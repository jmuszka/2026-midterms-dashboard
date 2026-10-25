#!/usr/bin/env node
// Builds the map geometry in public/data/:
//   districts-2026.json  TopoJSON of all 435 House districts as voted on Nov 3 2026
//   states-10m.json      us-atlas states (TopoJSON)
//   counties-10m.json    us-atlas counties (TopoJSON)
//
// Districts come from the Census TIGERweb "120th Congressional Districts" layer,
// EXCEPT Missouri: the Census 120th file still encodes the HB1 map that the
// Missouri Supreme Court blocked, so Missouri uses the 119th (2022) lines.
// See docs/RESEARCH.md §5.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { quantize } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';
import { STATES } from '../lib/model.mjs';
import { fetchJSON, fetchText, pool } from '../lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/data');
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer';
const LAYER = { 120: 0, 119: 4 };
const OLD_LINES = new Set(['MO']);

const query = (layer, fips, offset) => `${TIGER}/${layer}/query?where=STATE%3D%27${fips}%27&outFields=STATE,GEOID,AREALAND&returnGeometry=true&maxAllowableOffset=${offset}&geometryPrecision=5&outSR=4326&f=geojson`;

// d3-geo wants exterior rings clockwise (planar lon/lat); ArcGIS GeoJSON follows RFC 7946 (counter-clockwise).
const signed = (ring) => { let a = 0; for (let i = 0, n = ring.length - 1; i < n; i++) a += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]); return a / 2; }; // >0 = clockwise
function rewind(geom) {
  const fix = (poly) => poly.map((ring, i) => ((signed(ring) > 0) === (i === 0) ? ring : ring.slice().reverse()));
  if (geom.type === 'Polygon') geom.coordinates = fix(geom.coordinates);
  if (geom.type === 'MultiPolygon') geom.coordinates = geom.coordinates.map(fix);
  return geom;
}

await fs.mkdir(OUT, { recursive: true });
const states = Object.entries(STATES).filter(([st, s]) => s.seats > 0);
const res = await pool(states, 6, async ([st, s]) => {
  const congress = OLD_LINES.has(st) ? 119 : 120;
  const fc = await fetchJSON(query(LAYER[congress], s.fips, 0.002), { timeout: 60000, tries: 3 });
  return { st, congress, features: fc.features };
});
const features = [];
const problems = [];
for (const [i, r] of res.entries()) {
  const [st, s] = states[i];
  if (r?.error) { problems.push(`${st}: ${r.error}`); continue; }
  const fs2 = r.features.filter((f) => f.geometry && !/ZZ$/.test(f.properties.GEOID)); // ZZ = water / undefined areas
  if (fs2.length !== s.seats) problems.push(`${st}: ${fs2.length} districts, expected ${s.seats}`);
  for (const f of fs2) {
    const cd = +f.properties.GEOID.slice(2);
    const district = s.seats === 1 ? 0 : cd;
    features.push({ type: 'Feature', id: `H-${st}-${String(district).padStart(2, '0')}`, properties: { st, d: district, congress: r.congress }, geometry: rewind(f.geometry) });
  }
}

// Missouri check: the blocked HB1 map and the 2022 map must actually differ, or the trap has changed.
const area = async (layer) => (await fetchJSON(`${TIGER}/${layer}/query?where=STATE%3D%2729%27&outFields=GEOID,AREALAND&returnGeometry=false&f=json`)).features.map((f) => `${f.attributes.GEOID}:${f.attributes.AREALAND}`).sort().join(',');
const [mo120, mo119] = await Promise.all([area(LAYER[120]), area(LAYER[119])]);
console.log(mo120 === mo119 ? 'NOTE: Missouri 119th and 120th layers are now identical; the HB1 trap may be fixed upstream.' : 'Missouri: 120th layer differs from 2022 lines (HB1); using 119th layer as intended.');

// simplify (drops the lowest-weight 30% of points), then re-quantise: presimplify removes the transform
const pre = presimplify(topology({ districts: { type: 'FeatureCollection', features } }));
const simple = quantize(simplify(pre, quantile(pre, 0.3)), 1e5);
await fs.writeFile(path.join(OUT, 'districts-2026.json'), JSON.stringify(simple));

for (const name of ['states-10m.json', 'counties-10m.json']) {
  const { text } = await fetchText(`https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/${name}`, { timeout: 60000 });
  await fs.writeFile(path.join(OUT, name), text);
}
const size = async (f) => `${((await fs.stat(path.join(OUT, f))).size / 1024).toFixed(0)} KB`;
console.log(`districts: ${features.length} features, ${await size('districts-2026.json')}; states ${await size('states-10m.json')}; counties ${await size('counties-10m.json')}`);
if (features.length !== 435) problems.push(`total ${features.length}, expected 435`);
if (problems.length) { console.error('PROBLEMS:\n  ' + problems.join('\n  ')); process.exitCode = 1; }
