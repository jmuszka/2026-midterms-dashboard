/* Window instances, settings, presets and shareable layouts.
 *
 * A window is an instance { type, settings } of a view type (js/views/*.js). The WM
 * owns geometry (workspaces, splits, floating); this module owns instances. Both are
 * saved together: localStorage per browser, and #l=<deflated base64url> in the URL
 * so a whole dashboard can be shared as a link. */
import { app, esc, selection, toast } from './core.js';
import { leaf, split, leaves } from './wm.js';
import { clock } from './clock.js';

const KEY = 'us-dash-layout-v1';
export const TYPES = {};
export function registerTypes(list) { for (const t of list) TYPES[t.type] = t; }

const inst = {};      // id -> { type, settings }
const live = {};      // id -> { view, el, body }
let wm = null;

/* ---------------- encoding for share links ---------------- */
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function deflate(str) {
  if (!('CompressionStream' in window)) return `j${b64u(new TextEncoder().encode(str))}`;
  const buf = await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return `z${b64u(new Uint8Array(buf))}`;
}
async function inflate(s) {
  const bytes = unb64u(s.slice(1));
  if (s[0] === 'j') return new TextDecoder().decode(bytes);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}

/* ---------------- snapshot / restore ---------------- */
function snapshot() {
  const S = wm.state();
  return { v: 1, ws: S.ws, special: S.special, floating: S.floating, active: S.active, focus: S.focus, lastFocus: S.lastFocus, inst, ...(clock.mode === 'replay' ? { t: Math.round(clock.t) } : {}) };
}
let saveTimer = 0;
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify({ ...snapshot(), mod: wm.state().mod })); } catch {} }, 200);
}
export async function shareLink() {
  const s = snapshot();
  const url = `${location.origin}${location.pathname}${location.search}#l=${await deflate(JSON.stringify(s))}`;
  return url;
}
function clean(doc) { // drop instances of unknown types, and tree leaves without an instance
  const ok = Object.fromEntries(Object.entries(doc.inst || {}).filter(([, v]) => TYPES[v.type]));
  const prune = (n) => { if (!n) return null; if (n.id) return ok[n.id] ? n : null; const a = prune(n.a), b = prune(n.b); return a && b ? { ...n, a, b } : a || b; };
  const ws = Object.fromEntries(Object.entries(doc.ws || {}).map(([k, t]) => [k, prune(t)]));
  const floating = Object.fromEntries(Object.entries(doc.floating || {}).filter(([id]) => ok[id]));
  const special = prune(doc.special);
  // an instance that is in no tree and not floating would be invisible forever: drop it
  const placed = new Set([...Object.values(ws).flatMap(leaves), ...leaves(special), ...Object.keys(floating)]);
  for (const id of Object.keys(ok)) if (!placed.has(id)) delete ok[id];
  return { ...doc, inst: ok, ws, special, floating };
}
export function apply(doc) {
  doc = clean(doc);
  for (const id of Object.keys(live)) destroy(id);
  for (const k of Object.keys(inst)) delete inst[k];
  for (const [id, v] of Object.entries(doc.inst)) { inst[id] = { type: v.type, settings: { ...TYPES[v.type].defaults, ...v.settings } }; mount(id); }
  const first = Object.keys(doc.ws).find((k) => leaves(doc.ws[k]).length) || 1;
  const focus = doc.focus && doc.inst[doc.focus] ? doc.focus : leaves(doc.ws[doc.active || first])[0] || null;
  const lastFocus = Object.fromEntries(Object.entries(doc.lastFocus || {}).filter(([, id]) => doc.inst[id]));
  wm.setState({ ws: doc.ws, special: doc.special, floating: doc.floating, active: +doc.active || +first, focus, lastFocus, ...(doc.mod ? { mod: doc.mod } : {}) });
  persist();
}
export async function restore(presets) {
  const hash = location.hash.match(/#l=([A-Za-z0-9_-]+)/);
  if (hash) {
    try {
      const doc = JSON.parse(await inflate(hash[1]));
      apply(doc);
      if (doc.t) clock.pending = doc.t; // open the shared moment once the timeline has loaded
      history.replaceState(null, '', location.pathname + location.search);
      toast('Loaded a shared dashboard. Your previous layout is in <b>Reset → Restore my layout</b>.');
      return;
    } catch (e) { toast(`That share link could not be read (${esc(e.message)}). Loading your layout instead.`); }
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (saved?.v === 1 && Object.keys(clean(saved).inst).length) { try { localStorage.setItem(`${KEY}-backup`, JSON.stringify(saved)); } catch {} apply(saved); return; }
  apply(preset(presets, 'night'));
}

/* ---------------- presets ----------------
 * config/presets.json: { id: { name, description, inst: { id: [type, settings] }, ws: { n: tree }, special } }
 * tree: "id" | ["h"|"v", ratio, a, b] */
export function preset(presets, id) {
  const p = presets[id] || Object.values(presets)[0];
  const tree = (t) => (t == null ? null : typeof t === 'string' ? leaf(t) : split(t[0], t[1], tree(t[2]), tree(t[3])));
  return {
    v: 1, active: 1,
    inst: Object.fromEntries(Object.entries(p.inst).map(([k, [type, settings]]) => [k, { type, settings: settings || {} }])),
    ws: Object.fromEntries(Object.entries(p.ws).map(([k, t]) => [k, tree(t)])),
    special: tree(p.special), floating: {},
  };
}

/* ---------------- instances ---------------- */
const GEAR = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.4 1l.3 1.9c.5.2 1 .5 1.4.8l1.8-.7 1.4 2.4-1.5 1.2a5 5 0 0 1 0 1.6l1.5 1.2-1.4 2.4-1.8-.7c-.4.3-.9.6-1.4.8L9.4 15H6.6l-.3-1.9c-.5-.2-1-.5-1.4-.8l-1.8.7-1.4-2.4 1.5-1.2a5 5 0 0 1 0-1.6L1.7 6.6l1.4-2.4 1.8.7c.4-.3.9-.6 1.4-.8L6.6 1h2.8zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>';
const CLOSE = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path stroke="currentColor" stroke-width="1.8" d="M3 3l10 10M13 3L3 13"/></svg>';
export const titleOf = (id) => { const i = inst[id]; return i ? (live[id]?.title || TYPES[i.type].title(i.settings)) : id; };

function mount(id) {
  const i = inst[id], T = TYPES[i.type];
  const el = document.createElement('div');
  el.innerHTML = `<div class="panel" data-type="${i.type}"><div class="panel-head"><h2></h2><span class="panel-meta"></span>
      <button type="button" class="hbtn gear no-drag" title="Window settings" aria-label="Window settings">${GEAR}</button>
      <button type="button" class="hbtn close no-drag" title="Close window (mod+C)" aria-label="Close window">${CLOSE}</button></div>
    <div class="panel-body"></div></div>`;
  const body = el.querySelector('.panel-body');
  const L = (live[id] = { el, body, title: null });
  el.querySelector('h2').textContent = T.title(i.settings);
  el.querySelector('.close').addEventListener('click', () => wm.killactive(id));
  el.querySelector('.gear').addEventListener('click', (e) => { e.stopPropagation(); settingsPopover(id, e.currentTarget); });
  wm.add(id, el);
  const ctx = {
    title: (t) => { if (!t) return; L.title = t; el.querySelector('h2').textContent = t; if (wm.state().focus === id) document.querySelector('#win-title').textContent = t; },
    meta: (html) => { el.querySelector('.panel-meta').innerHTML = html || ''; },
    save: (patch) => { Object.assign(i.settings, patch); persist(); },
    openRace,
    get primary() { return Object.entries(inst).find(([, v]) => v.type === i.type)?.[0] === id; },
  };
  try { L.view = T.mount(body, i.settings, ctx); } catch (e) { body.innerHTML = `<p class="feed-error">This window failed to start: ${esc(e.message)}</p>`; console.error(e); }
}
function destroy(id) {
  try { live[id]?.view?.destroy?.(); } catch (e) { console.error(e); }
  live[id]?.el.remove();
  delete live[id];
}
export function closed(id) { destroy(id); delete inst[id]; persist(); }

export function create(type, settings = {}, opts = {}) {
  const T = TYPES[type];
  let n = 1; while (inst[`${type}-${n}`]) n++;
  const id = `${type}-${n}`;
  inst[id] = { type, settings: { ...T.defaults, ...settings } };
  mount(id);
  wm.open(id, null, opts);
  persist();
  return id;
}
// Clicking a race anywhere should show it where the viewer is looking: use a race card
// that follows the selection on this workspace, else bring the floating "peek" card here.
function openRace() {
  const follow = Object.entries(inst).filter(([, v]) => v.type === 'race' && !v.settings.pin).map(([id]) => id);
  if (follow.some((id) => wm.visible(id))) return;
  const peek = follow.find((id) => wm.where(id)?.kind === 'float');
  const S = wm.state();
  if (peek) { S.floating[peek].ws = S.active; wm.focus(peek); return; }
  create('race', {}, { floating: true });
}

/* ---------------- settings popover ---------------- */
function settingsPopover(id, anchor) {
  const pop = document.querySelector('#popover');
  const i = inst[id], T = TYPES[i.type];
  const fields = (T.settings || []).map((s) => {
    const opts = typeof s.options === 'function' ? s.options() : s.options;
    return `<label>${esc(s.label)}<select data-key="${s.key}">${opts.map(([v, l]) => `<option value="${esc(JSON.stringify(v))}" ${JSON.stringify(v) === JSON.stringify(i.settings[s.key]) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }).join('');
  pop.innerHTML = `<div class="pop-title">${esc(titleOf(id))}</div>${fields || '<p class="muted">No settings for this window.</p>'}
    <div class="pop-actions"><button type="button" data-act="dup">Duplicate</button><button type="button" data-act="float">Float / tile</button><button type="button" data-act="close">Close</button></div>`;
  const r = anchor.getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  pop.onchange = (e) => {
    const k = e.target.dataset.key; if (!k) return;
    i.settings[k] = JSON.parse(e.target.value);
    persist();
    const L = live[id];
    if (L.view?.settingsChanged) { L.view.settingsChanged(); L.el.querySelector('h2').textContent = L.title || T.title(i.settings); }
    else { destroy(id); mount(id); wm.render(); }
    if (!L.title) L.el.querySelector('h2').textContent = T.title(i.settings);
  };
  pop.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    pop.hidden = true;
    if (act === 'dup') create(i.type, JSON.parse(JSON.stringify(i.settings)));
    if (act === 'float') { wm.focus(id); wm.togglefloating(); }
    if (act === 'close') wm.killactive(id);
  };
}
document.addEventListener('pointerdown', (e) => { const pop = document.querySelector('#popover'); if (pop && !pop.hidden && !e.target.closest('#popover') && !e.target.closest('.gear')) pop.hidden = true; });

/* ---------------- launcher items ---------------- */
export function launcherItems(q, loc, presets) {
  const m = (s) => !q || s.toLowerCase().includes(q);
  return [
    ...Object.keys(inst).filter((id) => m(titleOf(id))).map((id) => ({ group: 'Open windows', label: esc(titleOf(id)), sub: loc(id), action: ['focus', id] })),
    ...Object.values(TYPES).filter((t) => m(`new ${t.name}`)).map((t) => ({ group: 'New window', label: esc(t.name), sub: 'opens on this workspace', action: ['new', t.type] })),
    ...Object.entries(presets).filter(([, p]) => m(`preset ${p.name} ${p.description}`)).map(([k, p]) => ({ group: 'Presets (replace the layout)', label: esc(p.name), sub: esc(p.description), action: ['preset', k] })),
  ];
}

export function init(theWM) { wm = theWM; }
export { inst, live, selection };
