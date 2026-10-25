// Usage: node tests/x-api.mock.mjs   Mocks api.x.com to test the X API path (parsing, since_id, 402 handling) without a real token.
process.env.X_BEARER_TOKEN = 'test-token';
const calls = [];
let mode = 'first';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.x.com/')) return realFetch(url, init);
  calls.push({ u, auth: init.headers.authorization });
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });
  if (mode === 'first') return json({
    data: [
      { id: '200', author_id: '30800681', created_at: '2026-10-25T04:30:00.000Z', text: 'RT @CBCNews: Conservatives projected https://t.co/a', referenced_tweets: [{ type: 'retweeted', id: '150' }] },
      { id: '199', author_id: '30800681', created_at: '2026-10-25T04:20:00.000Z', text: 'Eby concedes? https://t.co/x https://t.co/pic', entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://cbc.ca/story' }, { url: 'https://t.co/pic', expanded_url: 'https://x.com/JJ_McCullough/status/199/photo/1', media_key: '3_1' }] }, attachments: { media_keys: ['3_1'] } },
    ],
    includes: {
      users: [{ id: '30800681', name: 'J.J. McCullough', username: 'JJ_McCullough', profile_image_url: 'https://pbs.twimg.com/a.jpg' }, { id: '6433472', name: 'CBC News', username: 'CBCNews' }],
      tweets: [{ id: '150', author_id: '6433472', created_at: '2026-10-25T04:29:00.000Z', text: 'Conservatives projected to win majority' }],
      media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }],
    },
    meta: { newest_id: '200', result_count: 2 },
  });
  if (mode === 'quiet') return json({ meta: { result_count: 0 } });
  if (mode === 'broke') return json({ title: 'Payment Required' }, 402);
};
const feeds = await import(new URL('../lib/feeds.mjs', import.meta.url));
feeds.config.twitter.refreshSeconds = 0.001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let r = await feeds.getTweets();
console.log('1st call: source', r.source, '| tweets', r.tweets.length, '| auth header sent:', calls[0].auth === 'Bearer test-token');
console.log('   retweet ->', r.tweets[0].retweetOf?.author.handle, ':', r.tweets[0].retweetOf?.text);
console.log('   post    ->', JSON.stringify(r.tweets[1].text), '| media', r.tweets[1].media.map((m) => m.url));
console.log('   used stored user id (no lookup call):', !calls.some((c) => c.u.includes('/users/by/')));
console.log('   since_id on 1st:', new URL(calls[0].u).searchParams.get('since_id'));
await sleep(5); mode = 'quiet'; r = await feeds.getTweets();
console.log('2nd call: since_id', new URL(calls.at(-1).u).searchParams.get('since_id'), '| tweets kept', r.tweets.length);
await sleep(5); mode = 'broke'; r = await feeds.getTweets();
console.log('3rd call (402): ok', r.ok, '| stale', r.stale, '| error:', r.error, '| tweets kept', r.tweets.length);
