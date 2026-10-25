import { getTweets, config } from '../lib/feeds.mjs';
import { send } from './_respond.mjs';
export default async function handler(req, res) {
  try { send(res, await getTweets(), 90); }
  catch (e) { send(res, { ok: false, handle: config.twitter.handle, error: e.message }, 15); }
}
