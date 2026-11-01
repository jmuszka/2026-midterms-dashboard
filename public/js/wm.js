/* Hyprland-style tiling window manager (ES module, no dependencies).
 *
 * Mirrors Hyprland's defaults: dwindle layout (a new window splits the focused or
 * hovered one along its longer side), gaps_in 5 / gaps_out 20, 2px border with the
 * cyan→green active gradient, rounding 10, focus follows mouse (on real movement
 * only), workspaces 1–9 that slide horizontally, a special (scratchpad) workspace,
 * floating and fullscreen windows, mod+LMB drag to move, mod+RMB drag to resize,
 * and resize by dragging the gaps. Super belongs to the user's real compositor,
 * so the main modifier is Alt (or Ctrl+Alt).
 *
 * Windows are dynamic: the layout layer (layout.js) creates window elements for
 * typed instances and registers them with add(); closing one calls onClose so the
 * instance is destroyed. Windows on other workspaces are moved with transform,
 * never re-parented, because moving an iframe in the DOM reloads it.
 */
const CFG = { gapsIn: 5, gapsOut: 20, resizeStep: 40, minRatio: 0.08, floatSize: [0.5, 0.6] };
const INTERACTIVE = 'input, textarea, select, button, a, label, summary, form, [contenteditable], .no-drag';
const HEADER_DRAG_THRESHOLD = 5;

/* ---------- tree helpers ---------- */
export const leaf = (id) => ({ id });
export const split = (dir, ratio, a, b) => ({ dir, ratio, a, b }); // 'h' = side by side, 'v' = stacked
export const leaves = (n) => (!n ? [] : n.id ? [n.id] : [...leaves(n.a), ...leaves(n.b)]);
function without(n, id) {
  if (!n) return null;
  if (n.id) return n.id === id ? null : n;
  const a = without(n.a, id), b = without(n.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}
function replace(n, id, fn) {
  if (!n) return n;
  if (n.id) return n.id === id ? fn(n) : n;
  return { ...n, a: replace(n.a, id, fn), b: replace(n.b, id, fn) };
}
function path(n, id, acc = []) {
  if (!n || n.id) return n?.id === id ? acc : null;
  return path(n.a, id, [...acc, { node: n, side: 'a' }]) || path(n.b, id, [...acc, { node: n, side: 'b' }]);
}

export function createWM({ desk, title = (id) => id, onClose = () => {}, onChange = () => {}, launcherItems = () => [], onLaunch = () => {}, helpExtra = '' }) {
  const $ = (s) => document.querySelector(s);
  const wins = new Map();
  let S = { ws: { 1: null }, special: null, floating: {}, active: 1, focus: null, lastFocus: {}, mod: 'alt' };
  const R = { specialOpen: false, fullscreen: null, rects: {}, nodeRects: new Map(), dividers: [], drag: null, pending: null };

  function where(id) {
    for (const k of Object.keys(S.ws)) if (leaves(S.ws[k]).includes(id)) return { kind: 'tiled', ws: +k };
    if (leaves(S.special).includes(id)) return { kind: 'special' };
    if (S.floating[id]) return { kind: 'float', ws: S.floating[id].ws };
    return null;
  }
  function detach(id) {
    for (const k of Object.keys(S.ws)) S.ws[k] = without(S.ws[k], id);
    S.special = without(S.special, id);
    delete S.floating[id];
  }
  const area = () => {
    const W = desk.clientWidth, H = desk.clientHeight, g = CFG.gapsOut;
    return { x: g, y: g, w: Math.max(0, W - 2 * g), h: Math.max(0, H - 2 * g), W, H };
  };

  /* ---------- dwindle layout ---------- */
  function layout(n, r, out, record) {
    if (!n) return;
    if (record) R.nodeRects.set(n, r);
    if (n.id) { out[n.id] = r; return; }
    const g = CFG.gapsIn * 2;
    if (n.dir === 'h') {
      const wa = Math.round((r.w - g) * n.ratio);
      if (record) R.dividers.push({ node: n, dir: 'h', rect: r, pos: r.x + wa, g });
      layout(n.a, { x: r.x, y: r.y, w: wa, h: r.h }, out, record);
      layout(n.b, { x: r.x + wa + g, y: r.y, w: r.w - wa - g, h: r.h }, out, record);
    } else {
      const ha = Math.round((r.h - g) * n.ratio);
      if (record) R.dividers.push({ node: n, dir: 'v', rect: r, pos: r.y + ha, g });
      layout(n.a, { x: r.x, y: r.y, w: r.w, h: ha }, out, record);
      layout(n.b, { x: r.x, y: r.y + ha + g, w: r.w, h: r.h - ha - g }, out, record);
    }
  }
  function insertTiled(wsKey, id, target, point) {
    const tree = wsKey === 'special' ? S.special : S.ws[wsKey];
    const ids = leaves(tree);
    let node;
    if (!tree) node = leaf(id);
    else {
      if (!ids.includes(target)) target = ids.includes(S.lastFocus[wsKey]) ? S.lastFocus[wsKey] : ids[ids.length - 1];
      const r = R.rects[target] || { w: 2, h: 1, x: 0, y: 0 };
      const dir = r.w > r.h ? 'h' : 'v';
      let first = false;
      if (point) first = dir === 'h' ? point.x < r.x + r.w / 2 : point.y < r.y + r.h / 2;
      node = replace(tree, target, (t) => (first ? split(dir, 0.5, leaf(id), t) : split(dir, 0.5, t, leaf(id))));
    }
    if (wsKey === 'special') S.special = node; else S.ws[wsKey] = node;
  }

  /* ---------- render ---------- */
  function render() {
    const A = area();
    R.rects = {}; R.nodeRects = new Map(); R.dividers = [];
    const keys = new Set([...Object.keys(S.ws).map(Number), S.active]);
    for (const k of keys) {
      const out = {};
      layout(S.ws[k], A, out, k === S.active && !R.specialOpen);
      for (const [id, r] of Object.entries(out)) place(id, r, (k - S.active) * A.W, 'tiled');
      if (k === S.active) Object.assign(R.rects, out);
    }
    const sp = {};
    layout(S.special, A, sp, R.specialOpen);
    for (const [id, r] of Object.entries(sp)) { place(id, r, 0, R.specialOpen ? 'special' : 'special-hidden'); if (R.specialOpen) R.rects[id] = r; }
    let z = 20;
    for (const [id, f] of Object.entries(S.floating)) {
      const r = { x: f.x * A.W, y: f.y * A.H, w: f.w * A.W, h: f.h * A.H };
      place(id, r, (f.ws - S.active) * A.W, 'float', z++);
      if (f.ws === S.active) R.rects[id] = r;
    }
    const db = desk.getBoundingClientRect();
    const barH = db.top + scrollY; // fullscreen also covers the bar and any banner
    const footH = Math.max(0, innerHeight - db.bottom); // …and the credits line below the desktop
    for (const [id, el] of wins) {
      const w = where(id);
      el.classList.toggle('closed', !w);
      el.classList.toggle('active', id === S.focus && !!w);
      el.classList.toggle('fullscreen', id === R.fullscreen);
      el.classList.toggle('offscreen', !!w && !visible(id));
      if (id === R.fullscreen) Object.assign(el.style, { left: '0px', top: `${-barH}px`, width: `${A.W}px`, height: `${A.H + barH + footH}px`, transform: 'none', zIndex: 60 });
      el.style.order = String(order(id));
    }
    document.body.classList.toggle('special-open', R.specialOpen);
    renderBar();
    onChange(S);
  }
  // stacking order for the phone layout: workspace, then position in the tree
  function order(id) {
    let n = 0;
    for (const k of Object.keys(S.ws).sort((a, b) => a - b)) { const l = leaves(S.ws[k]); const i = l.indexOf(id); if (i >= 0) return n + i; n += l.length; }
    return 900;
  }
  function place(id, r, offsetX, kind, z) {
    const el = wins.get(id); if (!el) return;
    Object.assign(el.style, {
      left: `${r.x}px`, top: `${r.y}px`, width: `${Math.max(40, r.w)}px`, height: `${Math.max(40, r.h)}px`,
      transform: kind === 'special-hidden' ? 'translateY(-40px) scale(.96)' : `translateX(${offsetX}px)`,
      zIndex: kind === 'float' ? z : kind.startsWith('special') ? 40 : 10,
    });
    el.dataset.kind = kind;
  }
  function visible(id) {
    const w = where(id); if (!w) return false;
    if (w.kind === 'special') return R.specialOpen;
    return w.ws === S.active;
  }
  const onScreen = () => [...wins.keys()].filter((id) => visible(id) && (!R.specialOpen || where(id).kind === 'special'));

  /* ---------- bar ---------- */
  function renderBar() {
    const used = new Set(Object.keys(S.ws).filter((k) => leaves(S.ws[k]).length).map(Number));
    Object.values(S.floating).forEach((f) => used.add(f.ws));
    used.add(S.active);
    $('#workspaces').innerHTML = [...used].sort((a, b) => a - b).map((n) => `<button type="button" data-ws="${n}" class="${n === S.active && !R.specialOpen ? 'on' : ''}${leaves(S.ws[n]).length || Object.values(S.floating).some((f) => f.ws === n) ? ' used' : ''}" title="Workspace ${n}">${n}</button>`).join('')
      + (leaves(S.special).length ? `<button type="button" data-ws="special" class="special${R.specialOpen ? ' on' : ''}" title="Special workspace (mod+S)">S</button>` : '');
    $('#win-title').textContent = S.focus && visible(S.focus) ? title(S.focus) : '';
  }
  $('#workspaces').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ws]'); if (!b) return;
    if (b.dataset.ws === 'special') toggleSpecial(); else workspace(+b.dataset.ws);
  });

  /* ---------- dispatchers (Hyprland names) ---------- */
  function focus(id) {
    if (!id || !wins.has(id)) return;
    S.focus = id;
    const w = where(id);
    if (w && w.kind !== 'special') S.lastFocus[w.ws] = id;
    if (w?.kind === 'float') { const f = S.floating[id]; delete S.floating[id]; S.floating[id] = f; } // raise
    render();
  }
  function neighbor(dir) {
    const from = R.rects[S.focus]; if (!from) return null;
    const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
    let best = null, bestScore = Infinity;
    for (const id of onScreen()) {
      if (id === S.focus) continue;
      const r = R.rects[id]; if (!r) continue;
      const rx = r.x + r.w / 2, ry = r.y + r.h / 2;
      const ok = { l: r.x + r.w <= from.x + 4, r: r.x >= from.x + from.w - 4, u: r.y + r.h <= from.y + 4, d: r.y >= from.y + from.h - 4 }[dir];
      if (!ok) continue;
      const horiz = dir === 'l' || dir === 'r';
      const overlap = horiz ? Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y) : Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x);
      const score = (horiz ? Math.abs(rx - cx) : Math.abs(ry - cy)) + (horiz ? Math.abs(ry - cy) : Math.abs(rx - cx)) * 0.5 - (overlap > 0 ? 1e5 : 0);
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best;
  }
  function movefocus(dir) { const n = neighbor(dir); if (n) focus(n); }
  function movewindow(dir) {
    const id = S.focus, w = where(id); if (!w) return;
    if (w.kind === 'float') {
      const f = S.floating[id], A = area(), step = 40;
      f.x += ({ l: -step, r: step }[dir] || 0) / A.W; f.y += ({ u: -step, d: step }[dir] || 0) / A.H;
      return render();
    }
    const n = neighbor(dir); if (!n) return;
    const nw = where(n); if (!nw || nw.kind === 'float') return;
    const key = w.kind === 'special' ? 'special' : w.ws;
    const swap = (t) => replace(replace(t, id, () => leaf('\u0000')), n, () => leaf(id));
    const fix = (t) => replace(t, '\u0000', () => leaf(n));
    if (key === 'special') S.special = fix(swap(S.special)); else S.ws[key] = fix(swap(S.ws[key]));
    render();
  }
  const clampRatio = (x) => Math.min(1 - CFG.minRatio, Math.max(CFG.minRatio, x));
  function resizeactive(dx, dy) {
    const id = S.focus, w = where(id); if (!w) return;
    if (w.kind === 'float') {
      const f = S.floating[id], A = area();
      f.w = Math.max(0.12, f.w + dx / A.W); f.h = Math.max(0.12, f.h + dy / A.H);
      return render();
    }
    const tree = w.kind === 'special' ? S.special : S.ws[w.ws];
    const p = path(tree, id) || [];
    for (const [d, delta] of [['h', dx], ['v', dy]]) {
      if (!delta) continue;
      for (let i = p.length - 1; i >= 0; i--) {
        const { node, side } = p[i];
        if (node.dir !== d) continue;
        const r = R.nodeRects.get(node); if (!r) break;
        node.ratio = clampRatio(node.ratio + (side === 'a' ? 1 : -1) * delta / ((d === 'h' ? r.w : r.h) - CFG.gapsIn * 2));
        break;
      }
    }
    render();
  }
  function togglesplit() {
    const w = where(S.focus); if (!w || w.kind === 'float') return;
    const p = path(w.kind === 'special' ? S.special : S.ws[w.ws], S.focus); if (!p?.length) return;
    const node = p[p.length - 1].node; node.dir = node.dir === 'h' ? 'v' : 'h';
    render();
  }
  function togglefloating() {
    const id = S.focus, w = where(id); if (!w) return;
    if (w.kind === 'float') { delete S.floating[id]; insertTiled(S.active, id, null, null); }
    else { const [fw, fh] = CFG.floatSize; detach(id); S.floating[id] = { ws: S.active, x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh }; }
    render();
  }
  function fullscreen() { R.fullscreen = R.fullscreen === S.focus ? null : S.focus; render(); }
  function killactive(id = S.focus) {
    if (!where(id)) return;
    const pos = R.rects[id];
    detach(id);
    if (R.fullscreen === id) R.fullscreen = null;
    remove(id);
    onClose(id);
    const rest = onScreen();
    if (rest.length) {
      const c = pos && { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 };
      focus(rest.find((r) => c && inRect(c, R.rects[r])) || rest[0]);
    } else { S.focus = null; render(); }
  }
  // add a newly created window element and tile it on the current workspace (or special)
  function open(id, el, { workspace: wsN, floating } = {}) {
    if (el && !wins.has(id)) add(id, el);
    const w = where(id);
    if (w) { if (w.kind === 'special') R.specialOpen = true; else if (w.ws !== S.active) S.active = w.ws; return focus(id); }
    if (floating) { const [fw, fh] = CFG.floatSize; S.floating[id] = { ws: S.active, x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh }; }
    else if (R.specialOpen) insertTiled('special', id, S.focus, null);
    else insertTiled(wsN || S.active, id, S.focus, null);
    const e = wins.get(id);
    e.classList.add('opening');
    setTimeout(() => e.classList.remove('opening'), 30);
    focus(id);
  }
  function workspace(n) {
    if (n < 1 || n > 9) return;
    R.specialOpen = false; R.fullscreen = null;
    S.active = n;
    if (!(n in S.ws)) S.ws[n] = null;
    const ids = onScreen();
    S.focus = ids.includes(S.lastFocus[n]) ? S.lastFocus[n] : ids[0] || null;
    render();
  }
  function movetoworkspace(n) {
    const id = S.focus; if (!where(id)) return;
    const wasFloat = where(id).kind === 'float' && S.floating[id];
    detach(id);
    if (n === 'special') { insertTiled('special', id, null, null); R.specialOpen = true; render(); return focus(id); }
    if (!(n in S.ws)) S.ws[n] = null;
    if (wasFloat) S.floating[id] = { ...wasFloat, ws: n };
    else { R.rects = {}; insertTiled(n, id, S.lastFocus[n], null); }
    S.active = n; R.specialOpen = false;
    S.lastFocus[n] = id;
    focus(id);
  }
  function toggleSpecial() {
    if (!leaves(S.special).length && !R.specialOpen) return;
    R.specialOpen = !R.specialOpen;
    const ids = onScreen();
    S.focus = R.specialOpen ? (leaves(S.special).includes(S.focus) ? S.focus : leaves(S.special)[0]) : (ids.includes(S.lastFocus[S.active]) ? S.lastFocus[S.active] : ids[0] || null);
    render();
  }
  function cycleWorkspace(d) {
    const used = [...new Set([...Object.keys(S.ws).filter((k) => leaves(S.ws[k]).length).map(Number), S.active])].sort((a, b) => a - b);
    workspace(used[(used.indexOf(S.active) + d + used.length) % used.length]);
  }

  /* ---------- window registry ---------- */
  function add(id, el) {
    el.dataset.win = id;
    el.classList.add('win');
    desk.appendChild(el);
    wins.set(id, el);
    // the pointer entering an iframe gives no pointermove to this page, so catch the iframe's own enter
    el.addEventListener('pointerenter', (e) => { if (e.target.tagName === 'IFRAME' && !R.drag && S.focus !== id && visible(id)) { S.focus = id; render(); } }, true);
  }
  function remove(id) { const el = wins.get(id); if (el) el.remove(); wins.delete(id); }

  /* ---------- keyboard ---------- */
  const isMod = (e) => e.altKey && !e.metaKey && (S.mod !== 'ctrlalt' || e.ctrlKey);
  const ARROWS = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') { document.body.classList.add('mod-down'); if (S.mod === 'alt') e.preventDefault(); return; }
    if (!$('#launcher').hidden || !$('#help').hidden) return;
    if (!isMod(e)) return;
    const c = e.code, dir = ARROWS[e.key];
    let handled = true;
    if (dir && e.shiftKey) movewindow(dir);
    else if (dir && e.ctrlKey && S.mod === 'alt') resizeactive({ l: -1, r: 1 }[dir] * CFG.resizeStep || 0, { u: -1, d: 1 }[dir] * CFG.resizeStep || 0);
    else if (dir) movefocus(dir);
    else if (/^Digit[1-9]$/.test(c)) e.shiftKey ? movetoworkspace(+c.slice(5)) : workspace(+c.slice(5));
    else if (c === 'KeyS') e.shiftKey ? movetoworkspace('special') : toggleSpecial();
    else if (c === 'KeyC') killactive();
    else if (c === 'KeyV') togglefloating();
    else if (c === 'KeyJ') togglesplit();
    else if (c === 'KeyF') fullscreen();
    else if (c === 'KeyR') launcher(true);
    else if (c === 'Slash') help(true);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keyup', (e) => { if (e.key === 'Alt') { document.body.classList.remove('mod-down'); if (S.mod === 'alt') e.preventDefault(); } }, true);
  addEventListener('blur', () => document.body.classList.remove('mod-down'));

  /* ---------- mouse ---------- */
  const inRect = (p, r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const local = (e) => { const b = desk.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const dividerAt = (p) => R.dividers.find((d) => (d.dir === 'h'
    ? p.x >= d.pos - 3 && p.x <= d.pos + d.g + 3 && p.y >= d.rect.y && p.y <= d.rect.y + d.rect.h
    : p.y >= d.pos - 3 && p.y <= d.pos + d.g + 3 && p.x >= d.rect.x && p.x <= d.rect.x + d.rect.w));
  const narrow = () => matchMedia('(max-width: 900px)').matches;

  // focus follows mouse (follow_mouse = 1) only on real movement: Chrome fires
  // pointer events when the layout changes under a still cursor.
  let lastXY = '';
  document.addEventListener('pointermove', (e) => {
    const xy = `${e.clientX},${e.clientY}`; const moved = xy !== lastXY; lastXY = xy;
    if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); window.focus(); } // keep binds working after clicking into an iframe
    if (R.drag || !moved) return;
    const el = e.target.closest?.('.win'); if (!el) return;
    const id = el.dataset.win;
    if (S.focus !== id && visible(id) && !(R.specialOpen && where(id)?.kind !== 'special')) { S.focus = id; const w = where(id); if (w && w.kind !== 'special') S.lastFocus[w.ws] = id; render(); }
  });
  desk.addEventListener('pointermove', (e) => {
    if (R.drag) return;
    const d = e.target === desk ? dividerAt(local(e)) : null;
    desk.style.cursor = d ? (d.dir === 'h' ? 'col-resize' : 'row-resize') : '';
  });
  desk.addEventListener('contextmenu', (e) => { if (isMod(e) || R.drag) e.preventDefault(); });
  desk.addEventListener('pointerdown', (e) => {
    const p = local(e);
    const winEl = e.target.closest('.win');
    if (e.target === desk && e.button === 0) { const d = dividerAt(p); if (!d) return; e.preventDefault(); startDrag(e, { type: 'divider', d }); return; }
    if (!winEl) return;
    const id = winEl.dataset.win;
    if (where(id)?.kind === 'float') focus(id);
    if (!isMod(e) && e.button === 0 && e.target.closest('.panel-head') && !e.target.closest(INTERACTIVE) && !narrow()) { R.pending = { id, start: p }; return; }
    if (!isMod(e) || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault(); e.stopPropagation();
    focus(id);
    const r = { ...R.rects[id] };
    if (e.button === 0) startDrag(e, { type: 'move', id, r, start: p, kind: where(id).kind });
    else {
      const w = where(id), tree = w.kind === 'special' ? S.special : S.ws[w.ws];
      const corner = { right: p.x > r.x + r.w / 2, bottom: p.y > r.y + r.h / 2 };
      const pick = (dir, wantSide) => (path(tree, id) || []).slice().reverse().find((s) => s.node.dir === dir && s.side === wantSide);
      startDrag(e, { type: 'resize', id, r, start: p, kind: w.kind, corner, hx: w.kind !== 'float' && pick('h', corner.right ? 'a' : 'b'), vy: w.kind !== 'float' && pick('v', corner.bottom ? 'a' : 'b') });
    }
  }, true);
  document.addEventListener('pointermove', (e) => {
    const pd = R.pending; if (!pd || R.drag) return;
    const p = local(e);
    if (Math.hypot(p.x - pd.start.x, p.y - pd.start.y) < HEADER_DRAG_THRESHOLD) return;
    R.pending = null;
    if (!where(pd.id)) return;
    focus(pd.id);
    startDrag(e, { type: 'move', id: pd.id, r: { ...R.rects[pd.id] }, start: pd.start, kind: where(pd.id).kind });
  }, true);
  const clearPending = () => { R.pending = null; };
  document.addEventListener('pointerup', clearPending, true);
  document.addEventListener('pointercancel', clearPending, true);

  function startDrag(e, drag) {
    R.drag = drag;
    desk.setPointerCapture(e.pointerId);
    document.body.classList.add('wm-dragging');
    if (drag.type === 'move') wins.get(drag.id).classList.add('dragging');
    if (drag.hx) drag.hx0 = drag.hx.node.ratio;
    if (drag.vy) drag.vy0 = drag.vy.node.ratio;
    if (drag.kind === 'float') drag.f0 = { ...S.floating[drag.id] };
  }
  desk.addEventListener('pointermove', (e) => {
    const d = R.drag; if (!d) return;
    const p = local(e), A = area();
    if (d.type === 'divider') {
      const r = d.d.rect, g = d.d.g;
      d.d.node.ratio = clampRatio(d.d.dir === 'h' ? (p.x - r.x - g / 2) / (r.w - g) : (p.y - r.y - g / 2) / (r.h - g));
      render();
    } else if (d.type === 'move') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (d.kind === 'float') { S.floating[d.id].x = d.f0.x + dx / A.W; S.floating[d.id].y = d.f0.y + dy / A.H; render(); }
      else { const el = wins.get(d.id); el.style.left = `${d.r.x + dx}px`; el.style.top = `${d.r.y + dy}px`; }
    } else if (d.type === 'resize') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (d.kind === 'float') {
        const f = S.floating[d.id];
        if (d.corner.right) f.w = Math.max(0.1, d.f0.w + dx / A.W); else { f.w = Math.max(0.1, d.f0.w - dx / A.W); f.x = d.f0.x + d.f0.w - f.w; }
        if (d.corner.bottom) f.h = Math.max(0.1, d.f0.h + dy / A.H); else { f.h = Math.max(0.1, d.f0.h - dy / A.H); f.y = d.f0.y + d.f0.h - f.h; }
      } else {
        for (const [s, delta, r0] of [[d.hx, dx, d.hx0], [d.vy, dy, d.vy0]]) {
          if (!s) continue;
          const nr = R.nodeRects.get(s.node); if (!nr) continue;
          s.node.ratio = clampRatio(r0 + delta / ((s.node.dir === 'h' ? nr.w : nr.h) - CFG.gapsIn * 2));
        }
      }
      render();
    }
  });
  const endDrag = (e) => {
    const d = R.drag; if (!d) return;
    R.drag = null;
    document.body.classList.remove('wm-dragging');
    if (d.type === 'move') {
      wins.get(d.id)?.classList.remove('dragging');
      if (d.kind !== 'float') {
        const p = local(e);
        const target = onScreen().find((id) => id !== d.id && where(id)?.kind !== 'float' && inRect(p, R.rects[id]));
        if (target) { const key = d.kind === 'special' ? 'special' : S.active; detach(d.id); insertTiled(key, d.id, target, p); }
      }
    }
    render();
  };
  desk.addEventListener('pointerup', endDrag);
  desk.addEventListener('pointercancel', endDrag);
  desk.addEventListener('wheel', (e) => { if (isMod(e)) { e.preventDefault(); cycleWorkspace(e.deltaY > 0 ? 1 : -1); } }, { passive: false });

  /* ---------- launcher (wofi-style) ---------- */
  let sel = 0;
  function launcher(show) {
    $('#launcher').hidden = !show;
    if (!show) return;
    $('#launcher-input').value = ''; sel = 0; fillLauncher();
    $('#launcher-input').focus();
  }
  const items = () => launcherItems($('#launcher-input').value.trim().toLowerCase(), (id) => {
    const w = where(id);
    return !w ? 'closed' : w.kind === 'special' ? 'special' : w.kind === 'float' ? `workspace ${w.ws} · floating` : `workspace ${w.ws}`;
  });
  function fillLauncher() {
    const list = items(); sel = Math.min(sel, Math.max(0, list.length - 1));
    $('#launcher-list').innerHTML = list.map((it, i) => `${it.group && (i === 0 || list[i - 1].group !== it.group) ? `<li class="grp">${it.group}</li>` : ''}<li role="option" data-i="${i}" class="${i === sel ? 'sel' : ''}"><span>${it.label}</span><small>${it.sub || ''}</small></li>`).join('') || '<li class="muted">No match</li>';
    $('#launcher-list li.sel')?.scrollIntoView({ block: 'nearest' });
  }
  const choose = (i) => { const it = items()[i]; if (!it) return; launcher(false); onLaunch(it); };
  $('#launcher-input').addEventListener('input', () => { sel = 0; fillLauncher(); });
  $('#launcher-input').addEventListener('keydown', (e) => {
    const n = Math.max(1, items().length);
    if (e.key === 'ArrowDown') { sel = (sel + 1) % n; fillLauncher(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + n) % n; fillLauncher(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(sel); e.preventDefault(); }
    else if (e.key === 'Escape') launcher(false);
  });
  $('#launcher-list').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
  $('#launcher').addEventListener('pointerdown', (e) => { if (e.target.id === 'launcher') launcher(false); });
  $('#bar-launch').addEventListener('click', () => launcher(true));

  /* ---------- help ---------- */
  function help(show) {
    $('#help').hidden = !show;
    if (!show) return;
    const m = S.mod === 'ctrlalt' ? 'Ctrl+Alt' : 'Alt';
    $('#help-mod').textContent = m; $('#mod-select').value = S.mod;
    const rows = [
      [`${m} + ←↑→↓`, 'Move focus'], [`${m} + Shift + ←↑→↓`, 'Swap window in that direction'],
      ...(S.mod === 'alt' ? [[`${m} + Ctrl + ←↑→↓`, 'Resize active window']] : []),
      ['Drag a title bar', 'Move window (drop on a window to split it)'], [`${m} + RMB drag`, 'Resize window'],
      ['Drag a gap', 'Resize the split'], [`${m} + 1…9`, 'Switch workspace'], [`${m} + Shift + 1…9`, 'Move window to workspace'],
      [`${m} + scroll`, 'Cycle workspaces'], [`${m} + S`, 'Toggle special workspace'], [`${m} + Shift + S`, 'Move window to special workspace'],
      [`${m} + V`, 'Toggle floating'], [`${m} + F`, 'Fullscreen'], [`${m} + J`, 'Toggle split direction'],
      [`${m} + C`, 'Close window'], [`${m} + R`, 'Launcher: new window, presets, open windows'], [`${m} + /`, 'This help'],
    ];
    $('#help-table').innerHTML = rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('');
    $('#help-extra').innerHTML = helpExtra;
  }
  $('#bar-help').addEventListener('click', () => help(true));
  $('#help-close').addEventListener('click', () => help(false));
  $('#help').addEventListener('pointerdown', (e) => { if (e.target.id === 'help') help(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#help').hidden) help(false); });
  $('#mod-select').addEventListener('change', (e) => { S.mod = e.target.value; render(); help(true); });

  let rt = 0;
  addEventListener('resize', () => { cancelAnimationFrame(rt); rt = requestAnimationFrame(render); });

  return {
    state: () => S, runtime: R, wins,
    // replace the whole layout (preset, shared link, reset); windows must already be added
    setState(next) {
      S = { ws: { 1: null }, special: null, floating: {}, active: 1, focus: null, lastFocus: {}, mod: S.mod, ...next, mod: next.mod || S.mod };
      R.specialOpen = false; R.fullscreen = null;
      for (const id of [...wins.keys()]) if (!where(id)) remove(id);
      document.body.classList.add('wm-boot');
      render();
      requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('wm-boot')));
    },
    add, open, focus, workspace, movetoworkspace, killactive, togglefloating, fullscreen, toggleSpecial, movefocus, movewindow, resizeactive, togglesplit, render, launcher, help, where, visible,
  };
}
