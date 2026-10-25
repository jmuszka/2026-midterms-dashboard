/* Seat maths shared by the balance bars, chamber (hemicycle) and map views. */
import { app, raceState } from './core.js';

export const CHAMBERS = {
  S: { name: 'Senate', short: 'Senate' },
  H: { name: 'House', short: 'House' },
  G: { name: 'Governors', short: 'Governors' },
};
const SIDE = ['DEM', 'IND', 'GOP'];

// Tally one chamber from results. Seats not up count as holdovers.
export function tally(ch, results) {
  const bal = app.config.balance[ch];
  const races = app.manifest.filter((m) => m.chamber === ch);
  const t = { called: {}, leading: {}, holdover: { ...(bal.holdover || {}) }, none: 0, total: bal.total, majority: bal.majority || null, races: races.length, flips: [], rated: {} };
  for (const m of races) {
    const r = results?.[m.id];
    const s = raceState(r);
    const p = s.party && SIDE.includes(s.party) ? s.party : s.party ? 'OTH' : null;
    if (s.status === 'called') { t.called[p] = (t.called[p] || 0) + 1; if (m.incumbent && r.winner !== m.incumbent.party && (r.flip ?? true)) t.flips.push(m.id); }
    else if (s.status === 'leading') t.leading[p] = (t.leading[p] || 0) + 1;
    else t.none++;
    // pre-results expectation from the consensus rating
    const sc = m.consensus?.score ?? 0;
    const k = sc >= 0.75 ? 'DEM' : sc <= -0.75 ? 'GOP' : 'TOSS';
    t.rated[k] = (t.rated[k] || 0) + 1;
  }
  t.seats = (p) => (t.called[p] || 0) + (t.holdover[p] || 0);
  t.withLeads = (p) => t.seats(p) + (t.leading[p] || 0);
  // Senate: independents caucus with Democrats (holdovers King and Sanders are already in DEM)
  t.control = (p) => (ch === 'S' && p === 'DEM' ? t.seats('DEM') + t.seats('IND') : t.seats(p));
  t.net = (p) => {
    const cur = bal.current?.[p];
    if (cur == null || ch === 'G') return null;
    return t.withLeads(p) - cur;
  };
  return t;
}

// Ordered seats for the hemicycle: D holdovers, D called, D leading, I, uncounted by rating, R leading, R called, R holdovers.
export function seatList(ch, results) {
  const bal = app.config.balance[ch];
  const seats = [];
  const races = app.manifest.filter((m) => m.chamber === ch).map((m) => ({ m, r: results?.[m.id], s: raceState(results?.[m.id]) }));
  const hold = (p, n) => { for (let i = 0; i < n; i++) seats.push({ party: p, status: 'holdover', raceId: null }); };
  // left to right: safest Democratic wins … leads … independents … uncounted (by rating) … leads … safest Republican wins
  const BASE = { DEM: { called: 1, leading: 2 }, IND: { called: 3, leading: 3.3 }, OTH: { called: 3.6, leading: 3.6 }, GOP: { leading: 6, called: 7 } };
  const rank = (x) => {
    const { party, status } = x.s;
    if (status === 'none' || !party) return 4 - (x.m.consensus?.score ?? 0) / 10;
    const base = (BASE[party] || BASE.OTH)[status];
    const m = (x.r?.marginPct || 0) / 1000;
    return party === 'GOP' ? base + (status === 'called' ? m : -m) : base - (status === 'called' ? m : -m);
  };
  if (ch !== 'H') hold('DEM', bal.holdover?.DEM || 0);
  races.sort((a, b) => rank(a) - rank(b));
  for (const x of races) seats.push({ party: x.s.party, status: x.s.status, raceId: x.m.id, rating: x.m.consensus?.score ?? 0 });
  if (ch !== 'H') hold('GOP', bal.holdover?.GOP || 0);
  return seats;
}

// Parliament (hemicycle) layout: n seats in concentric rows over a half disc.
export function hemicycle(n, { w = 600, h = 320, rows: forceRows } = {}) {
  const R = Math.min(w / 2, h) - 6, r0 = R * 0.38;
  let rows = forceRows || Math.max(4, Math.round(Math.sqrt(n / 8)));
  const pts = [];
  const radii = Array.from({ length: rows }, (_, i) => r0 + ((R - r0) * (i + 0.5)) / rows);
  const totalLen = radii.reduce((s, r) => s + Math.PI * r, 0);
  const counts = radii.map((r) => Math.max(1, Math.round((n * Math.PI * r) / totalLen)));
  let diff = n - counts.reduce((s, c) => s + c, 0);
  for (let i = rows - 1; diff !== 0; i = (i - 1 + rows) % rows) { counts[i] += Math.sign(diff); diff -= Math.sign(diff); }
  radii.forEach((r, i) => {
    const c = counts[i];
    for (let k = 0; k < c; k++) {
      const a = Math.PI - (Math.PI * (k + 0.5)) / c; // left to right
      pts.push({ x: w / 2 + r * Math.cos(a), y: h - 6 - r * Math.sin(a), a });
    }
  });
  pts.sort((p, q) => q.a - p.a || (Math.hypot(p.x - w / 2, p.y - h) - Math.hypot(q.x - w / 2, q.y - h)));
  const size = Math.min(((R - r0) / rows) * 0.42, (Math.PI * radii[0]) / counts[0] / 2.3);
  return { pts, size, w, h };
}
