// Stream replay mapping: which video, and where in it, for a stream at a timeline moment.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.document = undefined; // public/js modules only touch the DOM inside functions
const tl = (await import('../public/js/timeline.js')).default;
const { streamAt } = await import('../public/js/timeline.js');
const { parseVideoMeta } = await import('../lib/sources/streams.mjs');
const s = (iso) => Math.round(Date.parse(iso) / 1000);
const HOUR = 3600e3;

test('watch page: broadcast start, end and archived length of an ended stream', () => {
  const m = parseVideoMeta(fs.readFileSync(new URL('./fixtures/youtube-watch-ended.html', import.meta.url), 'utf8'), 'LS8amqeDbS8');
  assert.equal(m.start_at, '2024-11-05T20:59:26+00:00');
  assert.equal(m.end_at, '2024-11-06T10:56:26+00:00');
  assert.equal(m.length_s, 42899);
  assert.equal(m.live, false);
});

test('streamAt covers archive, ended, live-with-DVR, no-DVR and offline', () => {
  const now = Date.now();
  const liveStart = new Date(now - 30 * HOUR).toISOString();
  tl.bundle = {
    simulated: false,
    archive: { cbs: ['ARCH0000001'] },
    videos: {
      ARCH0000001: { stream: 'cbs', start: '2026-11-03T23:00:00Z', end: '2026-11-04T13:00:00Z', length: 12 * 3600, archived: true },
      ENDED000001: { stream: 'pbs', start: '2026-11-03T23:30:00Z', end: '2026-11-04T05:30:00Z', length: 6 * 3600, live: false },
      LIVEDVR0001: { stream: 'nbc', start: liveStart, live: true, dvr: true },
      LIVENODVR01: { stream: 'sky', start: liveStart, live: true, dvr: false },
    },
    streams: {
      cbs: [[s('2026-11-03T22:00:00Z'), 'OTHER000001', 'live', 'x']],
      pbs: [[s('2026-11-03T23:30:00Z'), 'ENDED000001', 'live', 'p'], [s('2026-11-04T05:30:00Z'), null, 'offline', null]],
      nbc: [[s(new Date(now - 5 * HOUR).toISOString()), 'LIVEDVR0001', 'live', 'n']],
      sky: [[s(new Date(now - 5 * HOUR).toISOString()), 'LIVENODVR01', 'live', 's']],
    },
  };
  // curated archive wins over what was recorded, positioned from its start
  assert.deepEqual(streamAt('cbs', Date.parse('2026-11-04T01:00:00Z')), { kind: 'video', videoId: 'ARCH0000001', mode: 'vod', pos: 2 * 3600, title: undefined, archived: true });
  // ended recording: seconds since its start; after it went offline: nothing
  assert.equal(streamAt('pbs', Date.parse('2026-11-04T00:30:00Z')).pos, 3600);
  assert.deepEqual(streamAt('pbs', Date.parse('2026-11-04T06:00:00Z')), { kind: 'none', reason: 'offline' });
  assert.deepEqual(streamAt('pbs', Date.parse('2026-11-03T22:00:00Z')), { kind: 'none', reason: 'before-recording' });
  // still live with DVR: one hour back = one hour behind the live edge
  const edge = streamAt('nbc', now - HOUR);
  assert.equal(edge.mode, 'edge');
  assert.ok(Math.abs(edge.behind - 3600) < 5, `behind ${edge.behind}`);
  // still live without DVR: cannot be rewound
  assert.deepEqual(streamAt('sky', now - HOUR), { kind: 'none', reason: 'no-dvr' });
  assert.deepEqual(streamAt('abc', now - HOUR), { kind: 'none', reason: 'not-recorded' });
  // a simulated night stays live unless a curated video covers the moment
  tl.bundle = { ...tl.bundle, simulated: true };
  assert.equal(streamAt('nbc', now - HOUR), undefined);
  assert.equal(streamAt('cbs', Date.parse('2026-11-04T01:00:00Z')).videoId, 'ARCH0000001');
});

test('stocksAt rebuilds quotes and change from recorded prices', async () => {
  const { stocksAt } = await import('../public/js/timeline.js');
  tl.bundle = { stocks: { AAPL: { t: [100, 200, 300], v: [340, 350, 345] } }, stockPrev: { AAPL: { t: [100], v: [340] } } };
  const r = stocksAt(250 * 1000);
  assert.equal(r.quotes.AAPL.price, 350);
  assert.ok(Math.abs(r.quotes.AAPL.changePct - (10 / 340) * 100) < 1e-9);
  assert.deepEqual(r.series.AAPL, [[100, 340], [200, 350]]);
  assert.equal(stocksAt(50 * 1000).quotes.AAPL, undefined, 'nothing before the first recorded price');
  tl.bundle = { stocks: {} };
  assert.equal(stocksAt(250 * 1000), undefined, 'no recording: stay live');
});

test('currencies: change always means the currency against the dollar', async () => {
  const core = await import('../public/js/core.js');
  core.app.config = { stocks: { groups: [{ id: 'currencies', symbols: [{ s: 'EUR=', name: 'Euro', ccy: 'EUR', pair: 'EUR/USD' }, { s: 'JPY=', name: 'Japanese yen', ccy: 'JPY', pair: 'USD/JPY' }] }] } };
  const { _forTests: { adj, adjSeries, rate } } = await import('../public/js/views/stocks.js');
  // EUR/USD 1.10 -> 1.122: the euro is up 2%
  assert.ok(Math.abs(adj('EUR=', { price: 1.122, prevClose: 1.1, changePct: 2 }).changePct - 2) < 1e-9);
  // USD/JPY 156 -> 160: one yen buys fewer dollars, the yen is DOWN 2.5%
  assert.ok(Math.abs(adj('JPY=', { price: 160, prevClose: 156, changePct: 2.564 }).changePct - (156 / 160 - 1) * 100) < 1e-9);
  assert.ok(adj('JPY=', { price: 160, prevClose: 156 }).changePct < 0);
  assert.deepEqual(adjSeries('JPY=', [[1, 160]]), [[1, 1 / 160]], 'charts are drawn as the yen\'s value in dollars');
  assert.equal(rate('JPY=', { price: 156.86 }), '1 USD = 156.86 JPY');
  assert.equal(rate('EUR=', { price: 1.1199 }), '1 EUR = 1.1199 USD');
  assert.equal(adj('AAPL', { price: 1 }).price, 1, 'non-currencies untouched');
});
