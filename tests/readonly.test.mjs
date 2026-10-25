// The site's read-only mode: never writes, never touches an upstream source.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.READ_ONLY = '1';
delete process.env.SUPABASE_URL; delete process.env.STORE_FILE; // memory store, guarded read-only

const calls = [];
globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error(`unexpected upstream fetch: ${url}`); };
const { snapshot, events, scraperStatus } = await import('../lib/poll.mjs');
const { handle } = await import('../lib/routes.mjs');
const { getStore } = await import('../lib/store.mjs');

test('store refuses every write in read-only mode', async () => {
  const store = await getStore();
  assert.equal(store.readOnly, true);
  for (const fn of ['set', 'addEvents', 'addTicks', 'addRaceTicks', 'addSnapshot', 'addNewsItems', 'addPosts', 'addStreamTicks', 'beat']) {
    await assert.rejects(() => store[fn]('x', []), /read-only/, fn);
  }
});

test('missing data is a 503, not an upstream fetch', async () => {
  await assert.rejects(() => snapshot('results'), (e) => e.status === 503);
  const r = await handle({ route: 'results', query: new URLSearchParams(), headers: {} });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /scraper has not written/);
  await events({ since: 0 });
  assert.deepEqual(calls, [], 'no upstream requests');
});

test('/api/poll is refused on a read-only site', async () => {
  const r = await handle({ route: 'poll', query: new URLSearchParams('force=1'), headers: { authorization: 'Bearer x' } });
  assert.equal(r.status, 403);
  assert.deepEqual(calls, []);
});

test('scraper status reports no heartbeat yet', async () => {
  assert.deepEqual(await scraperStatus(), { age: null });
});
