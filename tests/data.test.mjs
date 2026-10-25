// Offline tests for the data layer: parsers on real saved responses, merge rules,
// the differ, the simulator and the social normalisers.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseCnn, cnnRaceId, parseNcsbe, parseEnhancedVoting, parseClarity, mergeResults } from '../lib/sources/results.mjs';
import { diffResults, diffMarkets, isFlip } from '../lib/diff.mjs';
import { simulate } from '../lib/sim.mjs';
import { normBsky, normTruth, truthFromRss } from '../lib/sources/social.mjs';
import { partyId, finishRace, matchCandidate } from '../lib/model.mjs';

const require = createRequire(import.meta.url);
const fx = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const json = (f) => JSON.parse(fx(f));
const { races } = require('../config/races.json');
const manifest = Object.fromEntries(races.map((r) => [r.id, r]));
const any = new Proxy({}, { get: () => ({ candidates: [] }) }); // 2024 fixtures are not in the 2026 manifest

test('manifest has every contest exactly once', () => {
  assert.equal(races.filter((r) => r.chamber === 'S').length, 35);
  assert.equal(races.filter((r) => r.chamber === 'H').length, 435);
  assert.equal(races.filter((r) => r.chamber === 'G').length, 36);
  assert.equal(new Set(races.map((r) => r.id)).size, races.length);
  assert.ok(manifest['S-OH-special'] && manifest['S-FL-special'], 'both Senate specials present');
});

test('party labels normalise', () => {
  for (const [label, id] of [['Democratic', 'DEM'], ['REP', 'GOP'], ['Republican Party', 'GOP'], ['DFL', 'DEM'], ['Independent', 'IND'], ['GRE', 'GRN'], ['Legal Marijuana Now', 'OTH'], ['', 'IND']]) assert.equal(partyId(label), id, label);
});

test('CNN race keys map to manifest ids', () => {
  assert.equal(cnnRaceId('2026-SG-TX'), 'S-TX');
  assert.equal(cnnRaceId('2026-S2G-OH'), 'S-OH-special');
  assert.equal(cnnRaceId('2026-HG-CA-22'), 'H-CA-22');
  assert.equal(cnnRaceId('2026-HG-AK-1'), 'H-AK-00');
  assert.equal(cnnRaceId('2026-GG-GA'), 'G-GA');
  assert.equal(cnnRaceId('2026-HP-CA-1'), null, 'primaries are ignored');
});

test('CNN national file: calls, winners, flips', () => {
  const r = parseCnn(json('cnn-2024-SG.json'), any);
  assert.ok(Object.keys(r).length >= 34);
  const az = r['S-AZ'];
  assert.equal(az.called, true);
  assert.equal(az.winner, 'DEM');
  assert.equal(az.winnerName, 'Ruben Gallego');
  assert.equal(az.candidates[0].name, 'Ruben Gallego');
  assert.ok(az.marginPct > 2 && az.marginPct < 3);
  const h = parseCnn(json('cnn-2024-HG-sample.json'), any);
  assert.ok(h['H-AK-00'], 'at-large seat');
  assert.ok(Object.values(h).every((x) => x.called));
});

test('NC SBE 2026 file parses all federal contests', () => {
  const r = parseNcsbe(json('ncsbe-2026-11-03-fed.json'), manifest);
  assert.equal(Object.keys(r).length, 15); // Senate + 14 House
  assert.equal(r['H-NC-01'].precincts.total > 0, true);
  const davis = r['H-NC-01'].candidates.find((c) => /Davis/.test(c.name));
  assert.equal(davis.party, 'DEM');
  assert.equal(davis.incumbent, true);
});

test('Enhanced Voting: VA 2026 and GA 2024 (name suffixes stripped)', () => {
  const va = parseEnhancedVoting(json('va-2026-federal.json'), manifest, 'VA');
  assert.equal(Object.keys(va).length, 12);
  assert.ok(va['S-VA'].candidates.some((c) => /Warner/.test(c.name) && c.party === 'DEM'));
  assert.ok(!va['H-VA-02'].candidates.some((c) => /write/i.test(c.name)));
  const ga = parseEnhancedVoting(json('ga-2024-federal.json'), any, 'GA');
  for (const r of Object.values(ga)) for (const c of r.candidates) assert.doesNotMatch(c.name, /\((I|Rep|Dem|Lib)\)/);
});

test('Clarity summary: CO 2024 House', () => {
  const co = parseClarity(json('clarity-co-2024-summary-fed.json'), any, 'CO');
  assert.ok(['H-CO-01', 'H-CO-08'].every((id) => co[id]));
  assert.equal(co['H-CO-08'].candidates[0].party, 'GOP');
});

const race = (id, cands, extra = {}) => finishRace({ id, source: 't', updatedAt: extra.updatedAt || '2026-11-04T01:00:00Z', called: false, winner: null, calledBy: null, expectedPct: null, precincts: null, candidates: cands.map(([name, party, votes, winner]) => ({ name, party, votes, winner: !!winner })), ...extra });

test('merge: state counts win when ahead, calls stay from CNN', () => {
  const cnn = { 'H-NC-01': race('H-NC-01', [['Don Davis', 'DEM', 100000, true], ['Laurie Buckhout', 'GOP', 90000]], { called: true, winner: 'DEM', winnerName: 'Don Davis', source: 'cnn', expectedPct: 95 }) };
  const nc = { 'H-NC-01': race('H-NC-01', [['Don Davis', 'DEM', 120000], ['Laurie Buckhout', 'GOP', 95000]], { source: 'ncsbe', precincts: { reporting: 280, total: 290 } }) };
  const m = mergeResults(cnn, [nc])['H-NC-01'];
  assert.equal(m.totalVotes, 215000);
  assert.equal(m.called, true);
  assert.equal(m.candidates.find((c) => c.name === 'Don Davis').winner, true);
  assert.equal(m.countsFrom, 'ncsbe');
  assert.deepEqual(m.sources.sort(), ['cnn', 'ncsbe']);
  const behind = mergeResults(cnn, [{ 'H-NC-01': race('H-NC-01', [['Don Davis', 'DEM', 1], ['Laurie Buckhout', 'GOP', 2]]) }])['H-NC-01'];
  assert.equal(behind.totalVotes, 190000, 'state feed behind CNN does not override');
});

test('differ: first votes, lead change, batch, tight margin, call, flip', () => {
  const id = 'S-TX';
  const t = (a, b, extra) => ({ [id]: race(id, [['James Talarico', 'DEM', a], ['Ken Paxton', 'GOP', b]], extra) });
  const types = (prev, next) => diffResults(prev, next, manifest).map((e) => e.type);
  assert.deepEqual(types(t(0, 0), t(500, 400)), ['first_votes']);
  assert.ok(types(t(500000, 520000, { expectedPct: 40 }), t(560000, 540000, { expectedPct: 46 })).includes('lead_change'));
  assert.ok(types(t(1000000, 990000, { expectedPct: 40 }), t(1200000, 1100000, { expectedPct: 48 })).includes('vote_batch'));
  assert.ok(types(t(3000000, 2900000, { expectedPct: 80 }), t(3010000, 2990000, { expectedPct: 82 })).includes('margin_tight'));
  const called = { [id]: race(id, [['James Talarico', 'DEM', 4000000, true], ['Ken Paxton', 'GOP', 3600000]], { called: true, winner: 'DEM', winnerName: 'James Talarico' }) };
  const ev = diffResults(t(3900000, 3600000), called, manifest);
  assert.equal(ev[0].type, 'flip_called', 'TX seat is held by a Republican');
  assert.match(ev[0].text, /Talarico \(D\) wins Texas Senate, flipping it from the Republicans/);
  assert.equal(isFlip({ winner: 'GOP', flip: null }, manifest['S-TX']), false);
});

test('differ: market moves of 5+ points over 10 minutes', () => {
  const now = '2026-11-04T03:00:00Z';
  const history = { 'control:S': [{ t: '2026-11-04T02:45:00Z', v: 0.6 }, { t: '2026-11-04T02:55:00Z', v: 0.62 }] };
  const alerts = {};
  const ev = diffMarkets(history, { control: { S: { avg: { DEM: 0.71, GOP: 0.29 } } }, races: {} }, manifest, alerts, now);
  assert.equal(ev.length, 1);
  assert.match(ev[0].text, /Senate control moved \+11 points toward Democrats/);
  assert.equal(diffMarkets(history, { control: { S: { avg: { DEM: 0.72 } } }, races: {} }, manifest, alerts, now).length, 0, 'no repeat alert within 15 minutes');
});

test('simulation is deterministic, complete and labelled', () => {
  const a = simulate(races, null, { offsetMin: 600 });
  const b = simulate(races, null, { offsetMin: 600, seed: 'nov3' });
  assert.deepEqual(a.races['S-TX'], b.races['S-TX']);
  assert.equal(Object.keys(a.races).length, 506);
  assert.ok(Object.values(a.races).every((r) => r.simulated && r.source === 'sim'));
  assert.ok(Object.values(a.races).filter((r) => r.called).every((r) => r.calledBy === 'SIMULATED'));
  assert.ok(a.events.length > 500);
  assert.equal(simulate(races, null, { offsetMin: 1 }).events.length, 0, 'nothing before the first polls close');
  assert.equal(a.races['S-NE'].candidates.slice(0, 2).map((c) => c.party).sort().join(), 'GOP,IND', 'Osborn stands in for the Democrats in Nebraska');
});

test('social: Bluesky and Truth Social normalise to one post shape', () => {
  const posts = json('bsky-author-feed.json').feed.map(normBsky);
  assert.ok(posts.length > 0);
  for (const p of posts) { assert.equal(p.platform, 'bluesky'); assert.match(p.url, /^https:\/\/bsky\.app\/profile\/.+\/post\//); assert.ok(p.author.handle); }
  const truth = json('truth-statuses.json').map(normTruth);
  assert.ok(truth.every((p) => p.platform === 'truthsocial' && p.url.startsWith('https://truthsocial.com/')));
  assert.ok(truth.some((p) => /https?:\/\//.test(p.text) || p.card), 'link targets survive HTML stripping');
  const rss = truthFromRss(fx('trumpstruth.xml'), { name: 'Donald J. Trump', handle: 'realDonaldTrump' });
  assert.equal(rss.length, 8);
  assert.ok(rss.every((p) => p.url.startsWith('https://truthsocial.com/@realDonaldTrump/') && p.via === 'trumpstruth.org'));
});

test('candidate name matching tolerates initials and suffixes', () => {
  const list = [{ name: 'Robert Wittman', party: 'GOP' }, { name: 'Shannon Taylor', party: 'DEM' }];
  assert.equal(matchCandidate('Robert J. "Rob" Wittman', list)?.party, 'GOP');
  assert.equal(matchCandidate('Shannon L. Taylor', list)?.party, 'DEM');
  assert.equal(matchCandidate('Nobody Else', list), null);
});

test('YouTube live embed page yields the live video id', async () => {
  const { parseYouTubeEmbed } = await import('../lib/sources/streams.mjs');
  assert.deepEqual(parseYouTubeEmbed(fx('youtube-embed-live.html')), { status: 'live', videoId: 'aF9neWULq64', title: 'LIVE: NBC News NOW', via: 'embed' });
  assert.equal(parseYouTubeEmbed('<html>no player</html>'), null);
});

test('stocks: CNBC quotes and charts parse; sessions follow US market hours', async () => {
  const { parseQuotes, parseChart, session } = await import('../lib/sources/stocks.mjs');
  const q = parseQuotes(json('cnbc-quotes.json'));
  for (const s of ['AAPL', '.SPX', '@SP.1', 'US10Y', 'BTC.CB=', 'DJT']) assert.ok(q[s]?.price > 0, s);
  assert.equal(q.US10Y.unit, '%');
  assert.ok(Math.abs(q['.SPX'].changePct - ((q['.SPX'].price - q['.SPX'].prevClose) / q['.SPX'].prevClose) * 100) < 1e-9);
  const pts = parseChart(json('cnbc-chart-aapl.json'));
  assert.ok(pts.length > 5 && pts.every(([t, v], i) => v > 0 && (i === 0 || t > pts[i - 1][0])), 'ascending 5-minute closes');
  const at = (iso) => Date.parse(iso);
  // election night, 9 pm ET Tuesday Nov 3: stocks and indexes closed, futures trading, crypto always
  assert.equal(session('AAPL', 'STOCK', at('2026-11-04T02:00:00Z')), 'closed');
  assert.equal(session('.SPX', 'INDEX', at('2026-11-04T02:00:00Z')), 'closed');
  assert.equal(session('@SP.1', 'DERIVATIVE', at('2026-11-04T02:00:00Z')), 'open');
  assert.equal(session('AAPL', 'STOCK', at('2026-11-03T22:30:00Z')), 'post');
  assert.equal(session('@SP.1', 'DERIVATIVE', at('2026-11-03T22:30:00Z')), 'closed', 'daily 5-6 pm futures break');
  assert.equal(session('BTC.CB=', 'INDEX', at('2026-10-25T18:00:00Z')), 'open');
});

test('timeline bundle separates stock prices from prediction markets', async () => {
  const { bundleFromStore } = await import('../lib/timeline.mjs');
  const { _memoryStore } = await import('../lib/store.mjs');
  const st = _memoryStore();
  await st.addTicks([{ key: 'control:S', t: '2026-11-04T01:00:00Z', v: 0.6 }, { key: 'stock:AAPL', t: '2026-11-04T01:00:00Z', v: 350 }, { key: 'stockpc:AAPL', t: '2026-11-04T01:00:00Z', v: 348 }]);
  const b = await bundleFromStore(st);
  assert.deepEqual(Object.keys(b.markets), ['control:S']);
  assert.deepEqual(b.stocks.AAPL.v, [350]);
  assert.deepEqual(b.stockPrev.AAPL.v, [348]);
});

test('topics: Polymarket world questions parse from a saved Gamma response', async () => {
  const { parseTopics } = await import('../lib/sources/markets.mjs');
  const { markets: cfg } = require('../config/sources.json');
  const groups = parseTopics(json('polymarket-topics.json'), cfg.topics);
  assert.deepEqual(groups.map((g) => g.id), ['israel-election', 'israel-palestine']);
  const ev = Object.fromEntries(groups.flatMap((g) => g.events).map((e) => [e.slug, e]));
  assert.equal(Object.keys(ev).length, 18, 'every configured slug is in the fixture');
  // one winner: ranked by price, placeholder "Person H" markets dropped
  const pm = ev['who-will-be-the-next-prime-minister-of-israel-after-the-next-election'];
  assert.ok(pm.exclusive);
  assert.deepEqual(pm.outcomes.slice(0, 3).map((o) => o.label), ['Gadi Eizenkot', 'Benjamin Netanyahu', 'Naftali Bennett']);
  assert.ok(!pm.outcomes.some((o) => /^Person /.test(o.label)));
  assert.equal(pm.outcomes.find((o) => o.label === 'Benjamin Netanyahu').p, 0.255); // bid/ask mid
  // date ladder: expired rungs dropped while one is open
  assert.deepEqual(ev['netanyahu-out-before-2027'].outcomes.map((o) => o.label), ['December 31']);
  // a two-sided question shows both sides
  assert.deepEqual(ev['israel-election-which-bloc-wins-more-seats'].outcomes.map((o) => [o.label, o.id]), [['Bibi', '5475249'], ['Opp.', '5475249:1']]);
  // a plain Yes/No question
  assert.equal(ev['will-israel-annex-west-bank-territory-before-2027'].outcomes[0].label, 'Yes');
  // the timeline gets names without prices
  const { topicMeta } = await import('../lib/timeline.mjs');
  assert.deepEqual(Object.keys(topicMeta(groups)[0].events[0].outcomes[0]), ['id', 'label']);
});

test('timeline bundle carries topic names and topic:<id> price ticks', async () => {
  const { bundleFromStore } = await import('../lib/timeline.mjs');
  const { _memoryStore } = await import('../lib/store.mjs');
  const st = _memoryStore();
  await st.set('snap:markets', { topics: [{ id: 'g', name: 'G', events: [{ slug: 's', title: 'Q?', exclusive: true, outcomes: [{ id: '1', label: 'A', p: 0.6, d1: 0.01 }] }] }] });
  await st.addTicks([{ key: 'topic:1', t: '2026-10-27T20:00:00Z', v: 0.6 }]);
  const b = await bundleFromStore(st);
  assert.deepEqual(b.markets['topic:1'].v, [0.6]);
  assert.deepEqual(b.topics[0].events[0].outcomes, [{ id: '1', label: 'A' }]);
});
