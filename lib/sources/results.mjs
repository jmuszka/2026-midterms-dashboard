// Results adapters. Each returns { races: { [raceId]: result }, meta } using the
// shape documented in lib/model.mjs. Only CNN (AP-sourced) sets called/winner;
// state feeds provide counts and precinct progress, never calls.
import { fetchJSON, fetchText } from '../http.mjs';
import { partyId, raceId, STATES, matchCandidate, finishRace } from '../model.mjs';

const nowIso = () => new Date().toISOString();

/* ---------------- CNN (politics.api.cnn.io, AP data) ----------------
 * national-races/{year}-{contest}.json; ecKey like 2026-SG-AZ, 2026-SP-OH (2026 specials: contest SP, inside the SG file), 2026-HG-CA-22, 2026-GG-GA.
 * At-large House seats are "-1" (e.g. 2024-HG-AK-1). */
export function cnnRaceId(ecKey) {
  const m = ecKey.match(/^\d{4}-(SG|S2G|SS|SP|HG|GG)-([A-Z]{2})(?:-(\d+))?$/);
  if (!m || !STATES[m[2]]) return null;
  const [, type, st, d] = m;
  if (type === 'HG') return raceId('H', st, STATES[st].seats === 1 ? 0 : +d);
  if (type === 'GG') return raceId('G', st);
  return raceId('S', st, null, type !== 'SG');
}
export function parseCnn(list, manifest) {
  const races = {};
  for (const r of list) {
    if (!/^(SG|S2G|SS|SP|HG|GG)$/.test(r.contestType)) continue;
    const id = cnnRaceId(r.ecKey);
    if (!id || !manifest[id]) continue;
    const called = r.editorialStatus === 'called' || r.status === 'W';
    const cands = (r.candidates || []).map((c) => ({
      name: c.fullName, party: partyId(c.majorParty === 'DEM' || c.majorParty === 'REP' ? c.majorParty.replace('REP', 'GOP') : c.candidatePartyCode),
      votes: c.voteNum || 0, incumbent: !!c.isIncumbent, winner: called && !!c.winner, runoff: !!c.runoffCandidate,
    }));
    const winner = cands.find((c) => c.winner);
    races[id] = finishRace({
      id, source: 'cnn', updatedAt: r.voteTimestamp || r.extractedAt || nowIso(),
      called, winner: winner?.party || null, winnerName: winner?.name || null, calledBy: called ? 'AP via CNN' : null,
      runoff: cands.some((c) => c.runoff), flip: called ? !!r.isSwitch : null,
      expectedPct: Number.isFinite(r.percentReporting) ? r.percentReporting : null,
      pollsClosed: r.raceEmbargo?.pollsClosed ?? null,
      precincts: null, candidates: cands, countyKey: r.countyVotesAvailable ? r.ecKey : null,
    });
  }
  return races;
}
export async function cnn(cfg, manifest) {
  const races = {}; const errors = [];
  await Promise.all(cfg.contests.map(async (ct) => {
    try { Object.assign(races, parseCnn(await fetchJSON(`${cfg.base}/national-races/${cfg.year}-${ct}.json`), manifest)); }
    catch (e) { if (e.status !== 404) errors.push(`${ct}: ${e.message}`); } // 404 = not published yet
  }));
  return { races, meta: { source: 'cnn', errors, count: Object.keys(races).length } };
}
// county breakdown for one race, fetched on demand by the race card
export async function cnnCounties(base, ecKey) {
  const list = await fetchJSON(`${base}/county-races/${ecKey}.json`);
  return list.map((c) => ({
    fips: c.countyFipsCode, name: c.countyName, total: c.totalVote, pct: c.percentReporting,
    candidates: (c.candidates || []).map((x) => ({ name: x.fullName, party: partyId(x.majorParty === 'REP' ? 'GOP' : x.majorParty === 'DEM' ? 'DEM' : x.candidatePartyCode), votes: x.voteNum || 0 })),
  }));
}

// stored form (timeline snapshots `counties:<race>`): candidates once, then one row per county
export function compactCounties(list) {
  const cand = [];
  const col = (c) => { let i = cand.findIndex(([n, p]) => n === c.name && p === c.party); if (i < 0) i = cand.push([c.name, c.party]) - 1; return i; };
  const rows = list.map((c) => { const v = []; for (const x of c.candidates) v[col(x)] = x.votes; return [c.fips, c.name, c.total, c.pct, v]; });
  return { cand, rows: rows.map((r) => { r[4] = cand.map((_, i) => r[4][i] ?? null); return r; }) };
}
export function expandCounties(c) {
  return (c?.rows || []).map(([fips, name, total, pct, v]) => ({ fips, name, total, pct, candidates: c.cand.map(([n, party], i) => (v[i] == null ? null : { name: n, party, votes: v[i] })).filter(Boolean) }));
}

/* ---------------- shared: attach a feed's contest to a manifest race ---------------- */
function contestToRace(st, name) {
  const s = name.toUpperCase();
  if (/PRESIDENT/.test(s)) return null;
  if (/UNITED STATES SENATE|US SENATE|U\.S\. SENATE|UNITED STATES SENATOR/.test(s)) return raceId('S', st, null, /UNEXPIRED|SPECIAL/.test(s));
  if (/\bGOVERNOR\b/.test(s) && !/LIEUTENANT GOVERNOR/.test(s.replace(/GOVERNOR\s*(AND|&|\/)\s*LIEUTENANT GOVERNOR/, 'GOVERNOR'))) return raceId('G', st);
  const h = s.match(/(?:HOUSE OF REPRESENTATIVES|REPRESENTATIVE (?:TO|IN) .*CONGRESS|US HOUSE|U\.S\. HOUSE|UNITED STATES REPRESENTATIVE|CONGRESS(?:IONAL)?)\D*(?:DISTRICT\s*)?(\d{1,2})/);
  if (h && !/STATE (HOUSE|SENATE)|HOUSE OF DELEGATES|GENERAL ASSEMBLY|LEGISLAT/.test(s)) return raceId('H', st, STATES[st].seats === 1 ? 0 : +h[1]);
  if (/AT[- ]LARGE/.test(s) && /HOUSE|REPRESENTATIVE|CONGRESS/.test(s)) return raceId('H', st, 0);
  return null;
}
function build(id, source, cands, precincts, manifest, updatedAt) {
  const m = manifest[id];
  const candidates = cands.filter((c) => !/write-?in/i.test(c.name)).map((c) => {
    const known = m && matchCandidate(c.name, m.candidates);
    return { name: known?.name || c.name, party: known?.party || c.party, votes: c.votes, incumbent: !!(m?.incumbent && known && known.name === m.incumbent.name) };
  });
  return finishRace({ id, source, updatedAt: updatedAt || nowIso(), called: false, winner: null, calledBy: null,
    expectedPct: null, precincts, candidates });
}

/* ---------------- North Carolina (er.ncsbe.gov) ---------------- */
export function parseNcsbe(rows, manifest, state = 'NC') {
  const by = new Map();
  for (const r of rows) {
    if (r.ogl !== 'FED' && !/GOVERNOR/i.test(r.cnm)) continue;
    const id = contestToRace(state, r.cnm.replace(/\(VOTE FOR \d+\)/i, ''));
    if (!id || !manifest[id]) continue;
    const e = by.get(id) || { cands: [], precincts: { reporting: +r.prt || 0, total: +r.ptl || 0 } };
    e.cands.push({ name: r.bnm, party: partyId(r.pty), votes: +r.vct || 0 });
    by.set(id, e);
  }
  return Object.fromEntries([...by].map(([id, e]) => [id, build(id, `ncsbe`, e.cands, e.precincts, manifest)]));
}
export async function ncsbe(cfg, manifest) {
  const rows = await fetchJSON(cfg.url);
  const races = parseNcsbe(rows, manifest, cfg.state);
  return { races, meta: { source: cfg.id, count: Object.keys(races).length } };
}

/* ---------------- Enhanced Voting (VA, GA) ---------------- */
const en = (a) => (Array.isArray(a) ? (a.find((x) => x.languageId === 'en') || a[0])?.text : a) || '';
export function parseEnhancedVoting(body, manifest, state) {
  const races = {};
  for (const item of body.data || []) {
    const id = contestToRace(state, en(item.name));
    if (!id || !manifest[id] || races[id]) continue;
    const opts = item.summaryResults?.ballotOptions || [];
    const cands = opts.map((o) => ({ name: en(o.name).replace(/(\s*\([^)]{1,4}\))+\s*$/, ''), party: partyId(o.party?.abbreviation || en(o.party?.name)), votes: o.voteCount || 0 }));
    const rs = item.reportingStatus || {};
    races[id] = build(id, `ev-${state.toLowerCase()}`, cands, rs.totalUnits ? { reporting: rs.reportingUnits || 0, total: rs.totalUnits } : null, manifest, rs.asOf);
  }
  return races;
}
export async function enhancedVoting(cfg, manifest) {
  const body = await fetchJSON(`${cfg.base}/${cfg.slug}/ballot-items`);
  const races = parseEnhancedVoting(body, manifest, cfg.state);
  return { races, meta: { source: cfg.id, count: Object.keys(races).length } };
}

/* ---------------- Clarity / Scytl (CO, IA, counties) ---------------- */
export function parseClarity(summary, manifest, state) {
  const races = {};
  for (const c of summary) {
    const id = contestToRace(state, c.C);
    if (!id || !manifest[id] || races[id]) continue;
    const cands = (c.CH || []).map((name, i) => ({ name, party: partyId(String(c.P?.[i] || '').replace(/^REP$/, 'GOP')), votes: c.V?.[i] || 0 }));
    races[id] = build(id, `clarity-${state.toLowerCase()}`, cands, c.TP ? { reporting: c.PR || 0, total: c.TP } : null, manifest);
  }
  return races;
}
const clarityEid = new Map(); // state -> { eid, checked }
export async function clarity(cfg, manifest) {
  let hit = clarityEid.get(cfg.state);
  if (!hit || Date.now() - hit.checked > 30 * 60e3) {
    const list = await fetchJSON(`${cfg.base}/elections.json`);
    const e = list.find((x) => /^11\/3\/2026/.test(x.Date) && !x.County);
    hit = { eid: e?.EID || null, checked: Date.now() };
    clarityEid.set(cfg.state, hit);
  }
  if (!hit.eid) return { races: {}, meta: { source: cfg.id, count: 0, note: 'Nov 3 2026 election not listed yet' } };
  const ver = (await fetchText(`${cfg.base}/${hit.eid}/current_ver.txt`)).text.trim();
  const summary = await fetchJSON(`${cfg.base}/${hit.eid}/${ver}/json/en/summary.json`);
  const races = parseClarity(summary, manifest, cfg.state);
  return { races, meta: { source: cfg.id, count: Object.keys(races).length, version: ver } };
}

export const STATE_ADAPTERS = { ncsbe, enhancedvoting: enhancedVoting, clarity };

/* ---------------- merge ----------------
 * CNN is the base (it alone carries calls). An official state feed overrides the
 * vote counts when it has counted at least as many votes, which is usual because
 * aggregators lag the state's own site. Calls and expected-vote % stay from CNN. */
export function mergeResults(byCnn, byStates) {
  const out = { ...byCnn };
  for (const st of byStates) {
    for (const [id, s] of Object.entries(st)) {
      const base = out[id];
      if (!base) { out[id] = { ...s, sources: [s.source] }; continue; }
      const sources = [...new Set([...(base.sources || [base.source]), s.source])];
      if (s.totalVotes >= base.totalVotes && s.totalVotes > 0) {
        const winnerSet = new Set(base.candidates.filter((c) => c.winner).map((c) => c.name));
        const cands = s.candidates.map((c) => ({ ...c, winner: base.called && (winnerSet.has(c.name) || (base.winner === c.party && base.winnerName && matchCandidate(base.winnerName, [c]))) }));
        out[id] = finishRace({ ...base, candidates: cands, precincts: s.precincts || base.precincts, countsFrom: s.source, sources, updatedAt: s.updatedAt > base.updatedAt ? s.updatedAt : base.updatedAt });
      } else {
        out[id] = { ...base, precincts: base.precincts || s.precincts, sources };
      }
    }
  }
  return out;
}
