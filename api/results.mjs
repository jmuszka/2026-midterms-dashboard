import { getResults } from '../lib/feeds.mjs';
import { send, fail } from './_respond.mjs';
export default async function handler(req, res) {
  try { send(res, await getResults(), 30); } catch (e) { fail(res, e); }
}
