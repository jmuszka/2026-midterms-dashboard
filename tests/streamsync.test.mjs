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
