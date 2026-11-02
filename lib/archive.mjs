// Local raw archive (scraper only): every task snapshot whose content changed, gzipped, as
// <dir>/<task>/<YYYY-MM-DD>/<HH-MM-SS>Z.json.gz (UTC). Supabase keeps what the site replays;
// this keeps everything the sources said, for research after the night (docs/SCRAPER.md).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);
// fields that change every run without the content changing
const VOLATILE = new Set(['ranAt', 'ms', 'fetchedAt', 'ticksWritten', 'task']);

export function diskArchive(dir) {
  const last = new Map(); // task -> hash of the last archived content
  return async (name, snap) => {
    const hash = crypto.createHash('sha1').update(JSON.stringify(snap, (k, v) => (VOLATILE.has(k) ? undefined : v))).digest('hex');
    if (last.get(name) === hash) return false;
    const t = snap.ranAt;
    const file = path.join(dir, name.replace(/[^\w-]/g, '_'), t.slice(0, 10), `${t.slice(11, 19).replace(/:/g, '-')}Z.json.gz`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await gzip(JSON.stringify(snap)));
    last.set(name, hash);
    return true;
  };
}
