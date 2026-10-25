// Election-night SIMULATION. Plays a plausible Nov 3 night through the real
// race model, differ and UI so every view can be built and rehearsed before
// results exist. It is a pure function of (clock, seed): no state, the same for
// every viewer, and safe to CDN-cache. Output is always flagged simulated:true and
// the UI shows a banner. Never presented as real results.
//
// Model, per race:
//   true margin (D minus R) from market odds when present, else consensus rating,
//   else 2024 presidential margin; plus a seeded national swing and race noise.
//   Counting starts at the race's real poll-close time; speed and the early
//   "mirage" (which party's votes are counted first) follow the state's habits.
//   Races are called once the true margin is safe relative to the uncounted share.
import { closeTime, finishRace } from './model.mjs';
import { diffResults } from './diff.mjs';

const SPEED = { // h = hours for most of the count; cap = share counted by the end of the night
  fast: { tau: 0.9, cap: 0.98, jump: 0.35 }, medium: { tau: 1.8, cap: 0.95, jump: 0.2 }, slow: { tau: 3.0, cap: 0.7, jump: 0.15 },
};
const STATE_SPEED = { FL: 'fast', GA: 'fast', NC: 'fast', VA: 'fast', OH: 'fast', IN: 'fast', KY: 'fast', SC: 'fast', TN: 'fast', AL: 'fast', OK: 'fast', AR: 'fast', NH: 'fast', VT: 'fast', DE: 'fast', WV: 'fast', MS: 'fast', MO: 'fast', KS: 'fast', NE: 'fast', SD: 'fast', ND: 'fast', WY: 'fast', TX: 'fast', IA: 'fast', MT: 'medium', ID: 'medium', CT: 'medium', RI: 'medium', MA: 'medium', MD: 'medium', NJ: 'medium', IL: 'medium', MN: 'medium', MI: 'medium', NM: 'medium', CO: 'medium', LA: 'medium', NY: 'medium', HI: 'medium', PA: 'medium', WI: 'medium', ME: 'medium', CA: 'slow', AK: 'slow', NV: 'slow', AZ: 'slow', WA: 'slow', OR: 'slow', UT: 'slow' };
// + = Democratic votes counted first (mail/early first), - = Republican first (mail last)
const MIRAGE = { FL: 6, GA: 7, NC: 8, VA: 6, OH: 5, TX: 4, IA: 4, KS: 3, AZ: 6, NV: 5, CO: 2, MN: -2, MI: -5, PA: -9, WI: -8, NY: -3, CA: 3, ME: -2, NH: 0 };

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Night window in sim time: 17:45 ET Nov 3 to 05:45 ET Nov 4 (12 h).
const NIGHT_START = Date.parse('2026-11-03T22:45:00Z'), NIGHT_LEN = 12 * 3600e3;
export function simClock(now = Date.now(), speed = 30, offsetMin = 0) {
  if (offsetMin) return NIGHT_START + offsetMin * 60e3; // pinned clock (tests, screenshots)
  return NIGHT_START + ((now * speed) % NIGHT_LEN);
}

function plan(m, markets, seed) {
  const r = rng(hash(`${seed}:${m.id}`));
  const nat = rng(hash(`${seed}:national`));
  const swing = gauss(nat) * 3; // national polling error, shared by every race
  const p = markets?.races?.[m.id]?.avg?.DEM;
  let base;
  if (p != null && p > 0.02 && p < 0.98) base = 8 * Math.log(p / (1 - p));
  else if (m.consensus && !m.consensus.inferred) base = m.consensus.score * 6;
  else if (m.pres2024?.margin != null) base = m.pres2024.margin * 0.9 + 3;
  else base = (m.consensus?.score ?? 0) * 8;
  const margin = base + swing + gauss(r) * (Math.abs(base) < 10 ? 3 : 5);
  // Pair a Democratic-side candidate against a Republican-side one. When a major party
  // has no nominee, an independent stands in (Osborn in NE, Kiley in CA-06).
  const C = m.candidates;
  const pick = (party) => C.find((c) => c.party === party && m.incumbent?.name === c.name) || C.find((c) => c.party === party);
  const ind = C.find((c) => c.party === 'IND' && m.incumbent?.name === c.name) || C.find((c) => c.party === 'IND') || C.find((c) => c.party !== 'DEM' && c.party !== 'GOP');
  let a = pick('DEM'), b = pick('GOP');
  if (!a && b && ind) a = ind; else if (a && !b && ind) b = ind;
  if (!a && !b) { a = C[0] || { name: m.incumbent?.name || 'Candidate', party: m.incumbent?.party || 'OTH' }; b = C[1] || null; }
  else if (!a) { a = b; b = null; }
  const minors = C.filter((c) => c !== a && c !== b).slice(0, 2);
  const districts = m.chamber === 'H' ? 1 : null;
  const turnout = Math.round((m.chamber === 'H' ? 290000 : 290000 * (STATE_SEATS[m.state] || 1)) * (0.75 + r() * 0.5));
  const minorShare = minors.length ? 0.01 + r() * 0.025 : 0;
  return { a, b, minors, margin, turnout, minorShare, districts, sp: SPEED[STATE_SPEED[m.state] || 'medium'], mirage: (MIRAGE[m.state] ?? 0) * (0.6 + r() * 0.8), r2: r() };
}
let STATE_SEATS = {};

function at(m, P, t) {
  const close = Date.parse(closeTime(m.close));
  const h = (t - close) / 3600e3;
  if (h < 0) return null;
  const { sp } = P;
  const f = Math.min(sp.cap, sp.jump + (sp.cap - sp.jump) * (1 - Math.exp(-h / sp.tau))) * (h < 0.08 ? h / 0.08 : 1); // first ~5 minutes: nothing yet
  const counted = Math.round(P.turnout * f);
  const shown = P.margin + P.mirage * (1 - f) * 1.4; // mirage fades as the count completes
  const two = 1 - P.minorShare;
  const aShare = P.b ? two * (0.5 + shown / 200) : two;
  const votesA = Math.round(counted * Math.max(0, Math.min(two, aShare)));
  const votesB = P.b ? Math.round(counted * two) - votesA : 0;
  const minorVotes = Math.max(0, counted - votesA - votesB);
  const cands = [
    { name: P.a.name, party: P.a.party, votes: votesA },
    ...(P.b ? [{ name: P.b.name, party: P.b.party, votes: votesB }] : []),
    ...P.minors.map((c, i) => ({ name: c.name, party: c.party, votes: Math.round(minorVotes * (i === 0 ? 0.7 : 0.3)) })),
  ];
  // call when the true margin is safe against the uncounted share
  const abs = Math.abs(P.margin);
  const needed = abs >= 18 ? 0 : abs >= 10 ? 0.25 : abs >= 5 ? 0.55 : abs >= 2.5 ? 0.8 : abs >= 1 ? 0.93 : 2;
  const called = !P.b ? f >= 0 : (f >= needed && h >= 0.02) || (abs >= 18 && h >= 0);
  const winner = P.b ? (P.margin >= 0 ? P.a : P.b) : P.a;
  return finishRace({
    id: m.id, source: 'sim', simulated: true, updatedAt: new Date(t).toISOString(),
    called, winner: called ? winner.party : null, winnerName: called ? winner.name : null, calledBy: called ? 'SIMULATED' : null,
    flip: called && m.incumbent ? winner.party !== m.incumbent.party : null,
    expectedPct: Math.round(f * 1000) / 10, pollsClosed: true, precincts: null,
    candidates: cands.map((c) => ({ ...c, incumbent: !!(m.incumbent && c.name === m.incumbent.name), winner: called && c.name === winner.name })),
  });
}

const cache = new Map();
export function simulate(manifestList, markets, { now = Date.now(), speed = 30, seed = 'nov3', offsetMin = 0 } = {}) {
  STATE_SEATS = {};
  for (const m of manifestList) if (m.chamber === 'H') STATE_SEATS[m.state] = (STATE_SEATS[m.state] || 0) + 1;
  const t = simClock(now, speed, offsetMin);
  const key = `${seed}:${speed}:${Math.floor(t / 60e3)}`;
  if (cache.has(key)) return cache.get(key);
  const plans = new Map(manifestList.map((m) => [m.id, plan(m, markets, seed)]));
  const raceAt = (tt) => {
    const out = {};
    for (const m of manifestList) { const r = at(m, plans.get(m.id), tt); if (r) out[m.id] = r; }
    return out;
  };
  const races = raceAt(t);
  // events: replay the night in 3-minute steps up to now
  const manifest = Object.fromEntries(manifestList.map((m) => [m.id, m]));
  const events = [];
  let prev = {};
  const STEP = 3 * 60e3;
  for (let tt = NIGHT_START, i = 0; tt <= t; tt += STEP, i++) {
    const cur = raceAt(tt);
    const ev = diffResults(prev, cur, manifest, new Date(tt).toISOString());
    ev.forEach((e, k) => events.push({ ...e, id: i * 1000 + k + 1, simulated: true }));
    prev = cur;
  }
  const value = { races, events, simTime: new Date(t).toISOString(), speed, seed };
  cache.set(key, value);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return value;
}
