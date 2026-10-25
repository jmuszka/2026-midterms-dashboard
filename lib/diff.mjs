// Snapshot differ: compares the previous and current merged results (and market
// prices) and emits the events that drive the live feed, ticker, toasts and the
// flips counter. Nothing else in the app derives events.
//
// Event: { id, t, type, raceId?, chamber?, state?, party?, text, data }
// Types: first_votes, vote_batch, lead_change, margin_tight, race_called,
//        race_uncalled, flip_called, runoff, market_move

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (n) => `${n.toFixed(1)}%`;

export function diffResults(prev, next, manifest, now = new Date().toISOString()) {
  const events = [];
  const push = (raceId, type, text, data = {}, party = null) => {
    const m = manifest[raceId] || {};
    events.push({ t: now, type, raceId, chamber: m.chamber, state: m.state, party, text, data });
  };
  for (const [id, r] of Object.entries(next)) {
    const p = prev?.[id];
    const m = manifest[id];
    if (!m) continue;
    const name = m.name;
    const lead = r.candidates[0], second = r.candidates[1];
    if (!p) {
      if (r.called) push(id, 'race_called', `${r.winnerName || lead?.name} wins ${name}`, { winner: r.winnerName, calledBy: r.calledBy, flip: isFlip(r, m) }, r.winner);
      else if (r.totalVotes > 0) push(id, 'first_votes', `First votes in ${name}: ${lead?.name} leads`, { votes: r.totalVotes }, lead?.party);
      continue;
    }
    // calls
    if (r.called && !p.called) {
      const flip = isFlip(r, m);
      push(id, flip ? 'flip_called' : 'race_called',
        `${r.winnerName || lead?.name} (${r.winner === 'DEM' ? 'D' : r.winner === 'GOP' ? 'R' : r.winner}) wins ${name}${flip ? `, flipping it from the ${m.incumbent?.party === 'DEM' ? 'Democrats' : m.incumbent?.party === 'GOP' ? 'Republicans' : 'incumbent party'}` : ''}`,
        { winner: r.winnerName, calledBy: r.calledBy, flip, marginPct: r.marginPct, expectedPct: r.expectedPct }, r.winner);
      continue;
    }
    if (!r.called && p.called) { push(id, 'race_uncalled', `Call withdrawn in ${name}`, {}, null); continue; }
    if (r.runoff && !p.runoff) push(id, 'runoff', `${name} heads to a runoff`, { candidates: r.candidates.filter((c) => c.runoff).map((c) => c.name) });
    if (r.called) continue;
    // first votes
    if (p.totalVotes === 0 && r.totalVotes > 0) { push(id, 'first_votes', `First votes in ${name}: ${lead?.name} leads`, { votes: r.totalVotes }, lead?.party); continue; }
    if (!lead || r.totalVotes === 0) continue;
    // lead change (ignore tiny counts where leads flip-flop on the first precinct)
    const pLead = p.candidates[0];
    if (pLead && pLead.name !== lead.name && r.totalVotes >= (m.chamber === 'H' ? 2000 : 10000) && lead.votes > (second?.votes || 0)) {
      push(id, 'lead_change', `${lead.name} takes the lead in ${name} by ${fmt(lead.votes - (second?.votes || 0))} votes`, { from: pLead.name, to: lead.name, marginPct: r.marginPct, totalVotes: r.totalVotes }, lead.party);
    }
    // vote batch: a meaningful drop of new votes
    const delta = r.totalVotes - p.totalVotes;
    const threshold = Math.max(m.chamber === 'H' ? 3000 : 15000, p.totalVotes * 0.04);
    if (delta >= threshold) {
      const gains = r.candidates.slice(0, 2).map((c) => ({ name: c.name, party: c.party, gain: c.votes - (p.candidates.find((x) => x.name === c.name)?.votes || 0) }));
      const [a, b] = gains;
      const batchMargin = a && b && delta ? ((a.gain - b.gain) / delta) * 100 : 0;
      const winnerOfBatch = batchMargin >= 0 ? a : b;
      push(id, 'vote_batch', `${fmt(delta)} new votes in ${name}; ${winnerOfBatch?.name} won the batch by ${pct(Math.abs(batchMargin))}`,
        { delta, gains, batchMargin, marginPct: r.marginPct, prevMarginPct: p.marginPct, expectedPct: r.expectedPct, leader: lead.name }, winnerOfBatch?.party);
    }
    // tight margin: crossing under 1 point once a real share of the vote is in
    const enough = (r.expectedPct ?? 0) >= 50 || (r.precincts && r.precincts.total && r.precincts.reporting / r.precincts.total >= 0.5);
    if (enough && r.marginPct < 1 && (p.marginPct >= 1 || !((p.expectedPct ?? 0) >= 50))) {
      push(id, 'margin_tight', `${name} is within a point: ${lead.name} leads by ${fmt(lead.votes - (second?.votes || 0))} votes`, { marginPct: r.marginPct, expectedPct: r.expectedPct }, lead.party);
    }
  }
  return events;
}
// flip: CNN's isSwitch when present, otherwise winner party vs the seat's incumbent party
export function isFlip(r, m) {
  if (r.flip != null) return !!r.flip;
  if (!m?.incumbent || !r.winner) return false;
  return r.winner !== m.incumbent.party;
}

// market_move: average Democratic probability moved >= 5 points versus >= 10 minutes ago.
// history: { key: [{ t, v }] } (oldest first); alerts: { key: lastAlertIso } (mutated)
export function diffMarkets(history, markets, manifest, alerts = {}, now = new Date().toISOString()) {
  const events = [];
  const tNow = Date.parse(now);
  const keys = [
    ...['S', 'H'].filter((k) => markets.control?.[k]).map((k) => ({ key: `control:${k}`, cur: markets.control[k].avg?.DEM, label: k === 'S' ? 'Senate control' : 'House control', chamber: k })),
    ...Object.entries(markets.races || {})
      .filter(([id]) => manifest[id] && Math.abs(manifest[id].consensus?.score ?? 3) < 2) // competitive races only
      .map(([id, v]) => ({ key: id, cur: v.avg?.DEM, label: manifest[id].name, chamber: manifest[id].chamber, state: manifest[id].state, raceId: id })),
  ];
  for (const k of keys) {
    const series = history[k.key];
    if (!series?.length || k.cur == null) continue;
    const old = [...series].reverse().find((x) => tNow - Date.parse(x.t) >= 10 * 60e3);
    if (!old || old.v == null) continue;
    const move = (k.cur - old.v) * 100;
    if (Math.abs(move) < 5 || tNow - Date.parse(alerts[k.key] || 0) < 15 * 60e3) continue;
    alerts[k.key] = now;
    events.push({ t: now, type: 'market_move', raceId: k.raceId || null, chamber: k.chamber, state: k.state || null, party: move > 0 ? 'DEM' : 'GOP',
      text: `Markets: ${k.label} moved ${move > 0 ? '+' : ''}${move.toFixed(0)} points toward ${move > 0 ? 'Democrats' : 'Republicans'} (now ${(k.cur * 100).toFixed(0)}% D)`,
      data: { key: k.key, from: old.v, to: k.cur, minutes: Math.round((tNow - Date.parse(old.t)) / 60e3) } });
  }
  return events;
}
