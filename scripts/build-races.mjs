#!/usr/bin/env node
// Builds config/races.json: every 2026 Senate, House and governor contest with
// incumbent, candidates, ratings from every rater, poll-close time and the 2024
// presidential margin on the 2026 district lines.
//
// Sources (all free, see docs/RESEARCH.md):
//   Wikipedia: 2026 House / Senate / gubernatorial election pages and the House ratings page
//   The Downballot: 2024 presidential results by 2026 congressional district (Google Sheet CSV)
//
// Usage: node scripts/build-races.mjs [--refresh]
//   Fetches are cached in .cache/ (gitignored); --refresh re-downloads them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { partyId, lastName } from '../lib/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const refresh = process.argv.includes('--refresh');
const UA = 'us-midterms-dashboard/1.0 (hobby election dashboard; build script)';
const states = JSON.parse(await fs.readFile(path.join(ROOT, 'config/states.json'), 'utf8'));
delete states._comment;
const byName = Object.fromEntries(Object.entries(states).map(([k, v]) => [v.name.toLowerCase(), k]));

async function cachedFetch(name, url) {
  const file = path.join(CACHE, name);
  if (!refresh) { try { return await fs.readFile(file, 'utf8'); } catch {} }
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const text = await res.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text);
  return text;
}
async function wiki(page) {
  const raw = await cachedFetch(`${page}.json`, `https://en.wikipedia.org/w/api.php?action=parse&page=${page}&prop=text&format=json&formatversion=2`);
  const html = JSON.parse(raw).parse.text.replace(/<br\s*\/?>/gi, ' ').replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '');
  return parseHTML(`<html><body>${html}</body></html>`).document;
}

const clean = (s) => (s || '').replace(/\[[^\]]*\]/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const text = (el) => clean(el?.textContent);

// Expand a table into a rectangular grid honouring rowspan/colspan.
function grid(table) {
  const out = [];
  [...table.querySelectorAll('tr')].forEach((tr, r) => {
    out[r] = out[r] || [];
    let c = 0;
    for (const cell of tr.children) {
      while (out[r][c]) c++;
      const rs = +cell.getAttribute('rowspan') || 1, cs = +cell.getAttribute('colspan') || 1;
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) { out[r + i] = out[r + i] || []; out[r + i][c + j] = cell; }
      c += cs;
    }
  });
  return out;
}
// Incumbent cells carry notes ("Redistricted from the 6th district", "(retiring)"): use the first link when there is one.
function memberName(cell) {
  const a = cell?.querySelector('a');
  const t = a && !/^#|cite_note/.test(a.getAttribute('href') || '') ? text(a) : text(cell);
  return t.replace(/\(.*$/, '').replace(/\s*(Redistricted|Retiring|Running|Lost|Elected|Appointed|Resigned|Died).*$/, '').trim();
}
const tables = (doc) => [...doc.querySelectorAll('table.wikitable')];
const headerText = (t) => text(t.querySelector('tr'));

function candidates(cell) {
  if (!cell) return [];
  const items = [...cell.querySelectorAll('li')];
  const list = items.length ? items.map((li) => text(li).replace(/^▌/, '')) : [];
  return list.map((s) => {
    const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*(.*)$/);
    const name = clean(m ? m[1] : s).replace(/^▌/, '');
    const label = m ? m[2] : '';
    return { name, party: partyId(label.replace(/\s*\/.*$/, '')), label, writeIn: /write-in/i.test(s) };
  }).filter((c) => c.name && !c.writeIn);
}

// "Lean D (flip)" -> { rating: 'Lean D', score: 1, flip: true }. score: +3 safe D … -3 safe R, 0 toss-up.
function rating(s) {
  s = clean(s);
  if (!s || s === '—' || /^n\/?a$/i.test(s)) return null;
  const flip = /flip/i.test(s);
  const m = s.match(/(Safe|Solid|Likely|Lean|Tilt)\s*([DRI])/i);
  if (!m) return /toss/i.test(s) ? { rating: 'Toss-up', score: 0, flip } : null;
  const strength = { safe: 3, solid: 3, likely: 2, lean: 1, tilt: 0.5 }[m[1].toLowerCase()];
  const side = m[2].toUpperCase();
  const word = { safe: 'Safe', solid: 'Safe', likely: 'Likely', lean: 'Lean', tilt: 'Tilt' }[m[1].toLowerCase()];
  return { rating: `${word} ${side}`, score: side === 'R' ? -strength : strength, flip };
}
function ratingsFrom(headRow, row, firstCol) {
  const out = {};
  for (let c = firstCol; c < row.length; c++) {
    const rater = text(headRow[c]).replace(/\.(?=\s|$)/, '').replace(/\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?.*$/i, '').trim();
    const r = rating(text(row[c]));
    if (rater && r) out[rater] = r;
  }
  return out;
}
function consensus(ratings) {
  const vals = Object.values(ratings);
  if (!vals.length) return null;
  const avg = vals.reduce((s, r) => s + r.score, 0) / vals.length;
  const word = Math.abs(avg) >= 2.5 ? 'Safe' : Math.abs(avg) >= 1.5 ? 'Likely' : Math.abs(avg) >= 0.75 ? 'Lean' : null;
  return { rating: word ? `${word} ${avg > 0 ? 'D' : 'R'}` : 'Toss-up', score: Math.round(avg * 100) / 100, raters: vals.length };
}
function stateFrom(s) {
  const name = clean(s).replace(/\(.*$/, '').replace(/\s+(at-large|\d+)$/i, '').trim().toLowerCase();
  return byName[name] || null;
}

// District-level poll closes that differ from the state's statewide (last) close.
const DISTRICT_CLOSE = {
  FL: (d) => ([1, 2].includes(d) ? '20:00' : '19:00'),
  IN: (d) => ([1, 8].includes(d) ? '19:00' : '18:00'),
  KY: (d) => ([1, 2].includes(d) ? '19:00' : '18:00'),
  KS: (d) => (d === 1 ? '21:00' : '20:00'),
  MI: (d) => (d === 1 ? '21:00' : '20:00'),
  TX: (d) => ([16, 23].includes(d) ? '21:00' : '20:00'),
  ID: (d) => (d === 1 ? '23:00' : '22:00'),
};
const closeFor = (st, district) => (district != null && DISTRICT_CLOSE[st] ? DISTRICT_CLOSE[st](district) : states[st].close);

/* ---------------- House ---------------- */
async function house() {
  const doc = await wiki('2026_United_States_House_of_Representatives_elections');
  const races = new Map();
  for (const t of tables(doc)) {
    const head = headerText(t);
    if (!/^District Incumbent/.test(head) || !/Candidates/.test(head)) continue;
    const g = grid(t);
    const sub = g[1].map(text);
    const col = (re) => sub.findIndex((h) => re.test(h));
    const cLoc = col(/^Location$/), cPvi = col(/PVI/), cMember = col(/^Member$/), cParty = col(/^Party$/), cStatus = col(/^Status$/);
    const cCand = g[0].findIndex((c) => /Candidates/.test(text(c)));
    if (cLoc < 0) continue;
    for (const row of g.slice(2)) {
      if (!row[cLoc]) continue;
      const loc = text(row[cLoc]);
      const m = loc.match(/^(.*?)\s+(at-large|\d+)$/i);
      if (!m) continue;
      const st = byName[m[1].toLowerCase()];
      if (!st) continue;
      const district = /at-large/i.test(m[2]) ? 0 : +m[2];
      const id = `H-${st}-${String(district).padStart(2, '0')}`;
      if (races.has(id)) continue;
      const member = memberName(row[cMember]);
      const status = text(row[cStatus]);
      const newSeat = /new seat|^(none|vacant)$/i.test(member) || /new seat/i.test(status);
      races.set(id, {
        id, chamber: 'H', state: st, district,
        name: `${st}-${district === 0 ? 'AL' : String(district).padStart(2, '0')}`,
        pvi: cPvi >= 0 ? text(row[cPvi]) || null : null,
        incumbent: newSeat || !member ? null : { name: member, party: partyId(text(row[cParty])) },
        status: status || null,
        open: newSeat || !/renominated|advanced|running/i.test(status),
        candidates: candidates(row[cCand]),
        close: closeFor(st, district),
      });
    }
  }
  // ratings
  const rdoc = await wiki('2026_United_States_House_of_Representatives_election_ratings');
  const rt = tables(rdoc)[0];
  if (rt) {
    const g = grid(rt);
    for (const row of g.slice(2)) {
      const loc = text(row[0]);
      const m = loc.match(/^(.*?)\s+(at-large|\d+)$/i);
      const st = m && byName[m[1].toLowerCase()];
      if (!st) continue;
      const id = `H-${st}-${String(/at-large/i.test(m[2]) ? 0 : +m[2]).padStart(2, '0')}`;
      const race = races.get(id);
      if (race) race.ratings = ratingsFrom(g[1], row, 4);
    }
  }
  // 2024 presidential margin on 2026 lines + incumbent party cross-check
  const csv = await cachedFetch('downballot-2024-by-cd.csv', 'https://docs.google.com/spreadsheets/d/1eZfaFI-c-PFOoKx1-zZA2MP0_dxRq_LVK0re3BOQqy0/export?format=csv&gid=620838163');
  for (const line of csv.split('\n')) {
    const f = line.split(',');
    const m = f[0]?.match(/^([A-Z]{2})-(AL|\d{2})$/);
    if (!m) continue;
    const id = `H-${m[1]}-${m[2] === 'AL' ? '00' : m[2]}`;
    const race = races.get(id);
    if (!race) { console.warn(`downballot: ${f[0]} not in Wikipedia tables`); continue; }
    race.pres2024 = { dem: +f[3], gop: +f[4], margin: +f[5] }; // margin = Harris minus Trump, points
    const p = { '(D)': 'DEM', '(R)': 'GOP', '(I)': 'IND' }[f[2]];
    const sameMember = race.incumbent && lastName(race.incumbent.name) === lastName(f[1]);
    if (sameMember && p && race.incumbent.party !== p) race.incumbent.party = p;
    else if (race.incumbent && !sameMember && f[1]) console.warn(`${id}: Wikipedia incumbent ${race.incumbent.name}, Downballot lists ${f[1]} ${f[2]}`);
  }
  return [...races.values()];
}

/* ---------------- Senate ---------------- */
async function senate() {
  const doc = await wiki('2026_United_States_Senate_elections');
  const out = [];
  for (const t of tables(doc)) {
    const head = headerText(t);
    if (!/^Constituency Incumbent/.test(head) || !/Candidates/.test(head)) continue;
    const g = grid(t);
    const sub = g[1].map(text);
    const special = /Status/.test(head) && !/Results/.test(head);
    const cSen = sub.findIndex((h) => /^Senator$/.test(h)), cParty = sub.findIndex((h) => /^Party$/.test(h));
    const cPvi = sub.findIndex((h) => /PVI/.test(h));
    const cCand = g[0].findIndex((c) => /Candidates/.test(text(c)));
    const cStatus = g[0].findIndex((c) => /Status|Results/.test(text(c)));
    for (const row of g.slice(2)) {
      const st = stateFrom(text(row[0]));
      if (!st) continue;
      const status = text(row[cStatus === -1 ? cCand - 1 : cStatus + (g[0][cStatus] === g[0][cStatus + 1] ? 1 : 0)]);
      const cls = special ? 'special' : null;
      const id = special ? `S-${st}-special` : `S-${st}`;
      out.push({
        id, chamber: 'S', state: st, district: null, special: !!special,
        name: `${states[st].name} Senate${special ? ' (special)' : ''}`,
        pvi: cPvi >= 0 ? text(row[cPvi]) || null : null,
        incumbent: { name: memberName(row[cSen]), party: partyId(text(row[cParty])) },
        status: text(row[g[1].length - 2]) || status || null,
        open: !/renominated|advanced|nominated|running/i.test(text(row[g[1].length - 2]) || status),
        candidates: candidates(row[cCand]),
        close: states[st].close,
        cls,
      });
    }
  }
  // ratings table: "Constituency Incumbent Ratings"
  const rt = tables(doc).find((t) => /^Constituency Incumbent Ratings/.test(headerText(t)));
  if (rt) {
    const g = grid(rt);
    for (const row of g.slice(2)) {
      const label = text(row[0]);
      const st = stateFrom(label);
      if (!st) continue;
      const special = /special|class 3/i.test(label);
      const race = out.find((r) => r.state === st && r.special === special) || out.find((r) => r.state === st);
      if (race) race.ratings = ratingsFrom(g[1], row, 4);
    }
  }
  return out;
}

/* ---------------- Governors ---------------- */
async function governors() {
  const doc = await wiki('2026_United_States_gubernatorial_elections');
  const out = [];
  const ct = tables(doc).find((t) => /^State Governor Party/.test(headerText(t)));
  const g = grid(ct);
  const head = g[0].map(text);
  const cGov = head.indexOf('Governor'), cParty = head.indexOf('Party'), cStatus = head.indexOf('Status'), cCand = head.indexOf('Candidates');
  for (const row of g.slice(1)) {
    const st = stateFrom(text(row[0]));
    if (!st) continue;
    const status = text(row[cStatus]);
    out.push({
      id: `G-${st}`, chamber: 'G', state: st, district: null,
      name: `${states[st].name} Governor`,
      incumbent: { name: memberName(row[cGov]), party: partyId(text(row[cParty])) },
      status, open: !/renominated|advanced|nominated|running/i.test(status),
      candidates: candidates(row[cCand]),
      close: states[st].close,
    });
  }
  const rt = tables(doc).find((t) => /^Constituency Incumbent Ratings/.test(headerText(t)));
  if (rt) {
    const rg = grid(rt);
    for (const row of rg.slice(2)) {
      const st = stateFrom(text(row[0]));
      const race = out.find((r) => r.state === st);
      if (race) { race.ratings = ratingsFrom(rg[1], row, 4); race.pvi = text(row[1]) || null; }
    }
  }
  return out;
}

const all = [...await senate(), ...await governors(), ...await house()];
for (const r of all) {
  r.ratings = r.ratings || {};
  r.consensus = consensus(r.ratings);
  if (!r.consensus && r.pvi) { // unrated seats are safe for the PVI party
    const m = r.pvi.match(/^([DR])\+(\d+)/);
    if (m) r.consensus = { rating: `Safe ${m[1]}`, score: m[1] === 'D' ? 3 : -3, raters: 0, inferred: true };
  }
}

// sanity checks against known totals (RESEARCH.md §4)
const count = (c) => all.filter((r) => r.chamber === c).length;
const problems = [];
if (count('H') !== 435) problems.push(`House: ${count('H')} races, expected 435`);
if (count('S') !== 35) problems.push(`Senate: ${count('S')} races, expected 35`);
if (count('G') !== 36) problems.push(`Governors: ${count('G')} races, expected 36`);
for (const st of Object.keys(states)) {
  const n = all.filter((r) => r.chamber === 'H' && r.state === st).length;
  if (n !== states[st].seats) problems.push(`${st}: ${n} House races, expected ${states[st].seats}`);
}
const noCands = all.filter((r) => !r.candidates.length).map((r) => r.id);
if (noCands.length) console.warn(`no candidates parsed: ${noCands.join(', ')}`);

const doc = {
  _comment: 'GENERATED by scripts/build-races.mjs from Wikipedia and The Downballot. Do not hand-edit; put corrections in config/race-overrides.json.',
  generatedAt: new Date().toISOString(),
  races: all,
};
// hand corrections
try {
  const ov = JSON.parse(await fs.readFile(path.join(ROOT, 'config/race-overrides.json'), 'utf8'));
  for (const [id, patch] of Object.entries(ov.races || {})) {
    const r = all.find((x) => x.id === id);
    if (r) Object.assign(r, patch); else problems.push(`override for unknown race ${id}`);
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }

await fs.writeFile(path.join(ROOT, 'config/races.json'), JSON.stringify(doc, null, 1) + '\n');
console.log(`wrote config/races.json: ${count('S')} Senate, ${count('H')} House, ${count('G')} governor races`);
const rated = all.filter((r) => Object.keys(r.ratings).length).length;
console.log(`${rated} races with rater ratings; toss-ups by consensus: ${all.filter((r) => r.consensus?.rating === 'Toss-up').map((r) => r.id).join(' ')}`);
if (problems.length) { console.error('PROBLEMS:\n  ' + problems.join('\n  ')); process.exitCode = 1; }
