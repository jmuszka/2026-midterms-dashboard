#!/usr/bin/env node
// Curate the permanent stream archive (config/stream-archive.json): official election-night
// videos that the timeline scrubber plays in sync, permanently, after the night.
//
//   node scripts/stream-archive.mjs add <stream-id> <youtube-url-or-id> [--start <iso>]
//   node scripts/stream-archive.mjs list
//   node scripts/stream-archive.mjs remove <video-id>
//
// `add` reads the video's broadcast start, end and archived length from its watch page.
// Use --start when the archive does not begin at the broadcast start (a re-upload, a trimmed
// VOD): it is the wall-clock time of the video's first second.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { videoMeta } from '../lib/sources/streams.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'config/stream-archive.json');
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/sources.json'), 'utf8'));
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const save = () => fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
const idOf = (s) => (s.match(/(?:youtu\.be\/|v=|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/))?.[1];
const [cmd, a, b] = process.argv.slice(2);
const opt = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const et = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : '—');

if (cmd === 'add') {
  const stream = a, videoId = idOf(b || '');
  if (!SOURCES.streams.list.some((s) => s.id === stream)) { console.error(`unknown stream id "${stream}"; one of: ${SOURCES.streams.list.map((s) => s.id).join(', ')}`); process.exit(1); }
  if (!videoId) { console.error('give a YouTube URL or 11-character video id'); process.exit(1); }
  const m = await videoMeta(videoId);
  if (!m) { console.error(`${videoId}: no broadcast details on the watch page (not a live stream / premiere?). Pass --start <iso> to add it anyway.`); if (!opt('--start')) process.exit(1); }
  const start = opt('--start') || m?.start_at;
  const length = m?.length_s || null;
  // with --start, the video's own broadcast end no longer applies: it ends `length` seconds later
  const end = opt('--start') ? (length ? new Date(Date.parse(start) + length * 1000).toISOString() : null) : m?.end_at || null;
  const entry = { stream, videoId, title: m?.title || null, start, end, length };
  if (!entry.start) { console.error('no start time: pass --start <iso>'); process.exit(1); }
  doc.videos = doc.videos.filter((v) => v.videoId !== videoId).concat(entry).sort((x, y) => x.stream.localeCompare(y.stream) || x.start.localeCompare(y.start));
  save();
  console.log(`added ${stream}: ${entry.title}\n  ${et(entry.start)} → ${entry.end ? et(entry.end) : 'still live'}${entry.length ? `, archived ${(entry.length / 3600).toFixed(1)} h` : ''}`);
  if (m?.live) console.log('  note: still live. Run add again after it ends to record the end time and archived length.');
} else if (cmd === 'remove') {
  const n = doc.videos.length; doc.videos = doc.videos.filter((v) => v.videoId !== a); save();
  console.log(n === doc.videos.length ? `${a} not in the archive` : `removed ${a}`);
} else if (cmd === 'list') {
  for (const v of doc.videos) console.log(`${v.stream.padEnd(14)} ${v.videoId}  ${et(v.start)} → ${v.end ? et(v.end) : 'live'}  ${v.title || ''}`);
  if (!doc.videos.length) console.log('(empty)');
} else {
  console.error('usage: node scripts/stream-archive.mjs add <stream-id> <youtube-url> [--start <iso>] | list | remove <video-id>');
  process.exit(1);
}
