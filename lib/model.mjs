// Shared race model: party normalisation, race ids, poll-close times and the
// helpers every source adapter uses to emit the same shape.
//
// Race result shape (what adapters return, keyed by race id):
//   { id, source, updatedAt, called: bool, winner: partyId|null, winnerName, calledBy,
//     expectedPct: 0..100|null, precincts: {reporting,total}|null, totalVotes,
//     candidates: [{ name, party, votes, pct, incumbent, winner }], counties?: {fips: {...}} }
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const PARTIES = require('../config/parties.json');
export const STATES = (() => { const s = { ...require('../config/states.json') }; delete s._comment; return s; })();

const index = new Map();
for (const p of PARTIES.parties) for (const m of p.match) index.set(m, p.id);
export function partyId(label) {
  const k = String(label ?? '').trim().toLowerCase().replace(/\s+party$/, '');
  if (!k) return 'IND';
  if (index.has(k)) return index.get(k);
  if (/democrat/.test(k)) return 'DEM';
  if (/republican/.test(k)) return 'GOP';
  if (/libertarian/.test(k)) return 'LIB';
  if (/green/.test(k)) return 'GRN';
  if (/independ|unaffil|no party|nonpartisan/.test(k)) return 'IND';
  return 'OTH';
}

export const raceId = (chamber, state, district, special) => {
  if (chamber === 'H') return `H-${state}-${String(district || 0).padStart(2, '0')}`;
  if (chamber === 'S') return special ? `S-${state}-special` : `S-${state}`;
  return `G-${state}`;
};

// Election day is Tue Nov 3 2026; DST ended Nov 1, so Eastern is UTC-5.
export const ELECTION_DAY = '2026-11-03';
export function closeTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, h + 5, m)).toISOString();
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
export const lastName = (s) => { const w = norm(s).split(' '); return w[w.length - 1] || ''; };
// match a feed's candidate name to the manifest's candidate list (last name + first initial)
export function matchCandidate(name, list) {
  const n = norm(name), ln = lastName(name);
  return list.find((c) => norm(c.name) === n)
    || list.find((c) => lastName(c.name) === ln && norm(c.name)[0] === n[0])
    || list.find((c) => lastName(c.name) === ln) || null;
}

export function finishRace(r) {
  r.candidates.sort((a, b) => b.votes - a.votes);
  r.totalVotes = r.candidates.reduce((s, c) => s + c.votes, 0);
  for (const c of r.candidates) c.pct = r.totalVotes ? (c.votes / r.totalVotes) * 100 : 0;
  const [a, b] = r.candidates;
  r.leader = a && a.votes > 0 ? a.party : null;
  r.marginPct = a && b && r.totalVotes ? ((a.votes - b.votes) / r.totalVotes) * 100 : a && r.totalVotes ? 100 : 0;
  return r;
}
