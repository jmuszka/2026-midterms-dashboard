import { publicConfig } from '../lib/feeds.mjs';
import { send } from './_respond.mjs';
export default function handler(req, res) { send(res, publicConfig(), 60); }
