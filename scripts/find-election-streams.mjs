#!/usr/bin/env node
// Finds each YouTube channel's election-night broadcast and pins it in config/election-streams.json.
// For every channel in config/sources.json streams.list it reads the channel's /streams tab, takes
// videos whose title is about the election, and confirms each on its watch page: kept only when it
// is live now or scheduled between 6 am ET on Nov 3 and 7 am ET on Nov 4. Existing pins are kept.
//
//   node scripts/find-election-streams.mjs           # report and write
//   node scripts/find-election-streams.mjs --dry     # report only
// Commit and deploy after it writes; the scraper reads the pins at start-up (restart it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseYouTubeLive, ELECTION_TITLE } from '../lib/sources/streams.mjs';
import { UA, pool } from '../lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const FILE = path.join(ROOT, 'config', 'election-streams.json');
const DRY = process.argv.includes('--dry');
const WINDOW = [Date.parse('2026-11-03T11:00:00Z'), Date.parse('2026-11-04T12:00:00Z')];
const { list } = require('../config/sources.json').streams;
const pins = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const page = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};
// every (videoId, title) pair in the tab's initial data, whatever renderer YouTube used
function videosIn(html) {
  const out = new Map();
  for (const m of html.matchAll(/"(?:videoId|contentId)":"([A-Za-z0-9_-]{11})"[\s\S]{0,4000}?"(?:title|text)":\{?"(?:simpleText|content)"?:?"((?:[^"\\]|\\.){4,200})"/g)) if (!out.has(m[1])) out.set(m[1], m[2]);
  for (const m of html.matchAll(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.){4,200})"\}\][\s\S]{0,600}?"videoId":"([A-Za-z0-9_-]{11})"/g)) if (!out.has(m[2])) out.set(m[2], m[1]);
  return [...out].map(([videoId, title]) => ({ videoId, title: title.replace(/\\u0026/g, '&').replace(/\\"/g, '"') }));
}

const yt = list.filter((s) => s.platform === 'youtube');
const found = await pool(yt, 4, async (s) => {
  try {
    const cands = videosIn(await page(`https://www.youtube.com/channel/${s.channel}/streams`)).filter((v) => ELECTION_TITLE.test(v.title)).slice(0, 6);
    const ok = [];
    for (const c of cands) {
      const r = parseYouTubeLive(await page(`https://www.youtube.com/watch?v=${c.videoId}`));
      const when = r.scheduledStart ? Date.parse(r.scheduledStart) : null;
      // live counts only from Nov 3 on (before that, a live 'midterms' video is a campaign event)
      if ((r.status === 'live' && Date.now() >= WINDOW[0]) || (r.status === 'upcoming' && when >= WINDOW[0] && when <= WINDOW[1])) ok.push({ ...c, status: r.status, scheduledStart: r.scheduledStart, title: r.title || c.title });
    }
    return { id: s.id, name: s.name, ok };
  } catch (e) { return { id: s.id, name: s.name, error: e.message }; }
});

let added = 0;
for (const f of found) {
  const have = pins.videos[f.id];
  if (f.error) { console.log(`${f.id.padEnd(15)} error: ${f.error}`); continue; }
  if (!f.ok.length) { console.log(`${f.id.padEnd(15)} ${have ? `pinned ${have} (kept)` : 'no election broadcast found yet'}`); continue; }
  const pick = f.ok.find((v) => v.status === 'live') || f.ok.sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart))[0];
  console.log(`${f.id.padEnd(15)} ${pick.videoId}  ${pick.status}${pick.scheduledStart ? ` ${pick.scheduledStart}` : ''}  ${pick.title.slice(0, 70)}${have && have !== pick.videoId ? `  (was ${have}, kept the existing pin)` : ''}`);
  if (!have) { pins.videos[f.id] = pick.videoId; added++; }
}
if (!DRY && added) fs.writeFileSync(FILE, JSON.stringify(pins, null, 2) + '\n');
console.log(`${added} new pin(s)${DRY ? ' (dry run, nothing written)' : added ? ` written to ${path.relative(ROOT, FILE)}` : ''}`);
