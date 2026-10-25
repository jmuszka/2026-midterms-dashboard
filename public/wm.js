/* Hyprland-style tiling window manager for the dashboard panels.
 *
 * Mirrors Hyprland's defaults: dwindle layout (each new window splits the focused
 * or hovered one along its longer side), gaps_in 5 / gaps_out 20, border 2px with the
 * cyan→green active gradient, rounding 10, focus follows mouse, workspaces 1–9 that
 * slide horizontally, a special (scratchpad) workspace, floating and fullscreen
 * windows, mod+LMB drag to move, mod+RMB drag to resize, and resize by dragging the
 * gaps. Super is held by the user's real compositor, so the main modifier is Alt
 * (or Ctrl+Alt).
 */
(() => {
  const CFG = {
    gapsIn: 5,            // per side, like Hyprland: 10px between windows
    gapsOut: 20,
    border: 2,
    rounding: 10,
    resizeStep: 40,       // px per keyboard resize step
    minRatio: 0.08,
    floatSize: [0.5, 0.6],
  };
  const NAMES = {
    seats: 'Seat projection', map: 'Results map', detail: 'Riding detail', ridings: 'All ridings',
    video: 'CBC live stream', news: 'News', x: 'X feed',
  };
  const KEY = 'bc-dash-wm-v1';
  const desk = document.getElementById('desktop');
  const wins = Object.fromEntries([...desk.querySelectorAll('.win')].map((el) => [el.dataset.tile, el]));
  const $ = (s) => document.querySelector(s);

  /* ---------- tree helpers ---------- */
  const leaf = (id) => ({ id });
  const split = (dir, ratio, a, b) => ({ dir, ratio, a, b }); // 'h' = side by side, 'v' = stacked
  const DEFAULT = () => ({
    ws: {
      1: split('h', 0.5,
        split('v', 0.24, leaf('seats'), leaf('map')),
        split('v', 0.56, leaf('video'), split('h', 0.5, leaf('news'), leaf('x')))),
      2: split('h', 0.62, leaf('ridings'), leaf('detail')),
    },
    special: null,
    floating: {},        // id -> { ws, x, y, w, h }  (x/y/w/h as fractions of the desktop)
    active: 1,
    focus: 'map',
    lastFocus: {},       // ws -> id
    mod: 'alt',
  });
  const leaves = (n) => (!n ? [] : n.id ? [n.id] : [...leaves(n.a), ...leaves(n.b)]);
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
  function path(n, id, acc = []) { // [{node, side}] from root down to the leaf's parent
    if (!n || n.id) return n?.id === id ? acc : null;
    return path(n.a, id, [...acc, { node: n, side: 'a' }]) || path(n.b, id, [...acc, { node: n, side: 'b' }]);
  }
  function mapNodes(n, fn) { if (n && !n.id) { fn(n); mapNodes(n.a, fn); mapNodes(n.b, fn); } }

  /* ---------- state ---------- */
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch { S = null; }
  const valid = (s) => s && s.ws && Object.keys(NAMES).every((id) => true) && typeof s.active === 'number';
  if (!valid(S)) S = DEFAULT();
  S = { ...DEFAULT(), ...S };
  // drop unknown ids, keep everything else
  for (const k of Object.keys(S.ws)) for (const id of leaves(S.ws[k])) if (!wins[id]) S.ws[k] = without(S.ws[k], id);
  const R = { specialOpen: false, fullscreen: null, rects: {}, nodeRects: new Map(), dividers: [], drag: null };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

  function where(id) {
    for (const k of Object.keys(S.ws)) if (leaves(S.ws[k]).includes(id)) return { kind: 'tiled', ws: +k };
    if (leaves(S.special).includes(id)) return { kind: 'special' };
    if (S.floating[id]) return { kind: 'float', ws: S.floating[id].ws };
    return null; // closed
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
      Object.assign(R.rects, k === S.active ? out : {});
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
    for (const [id, el] of Object.entries(wins)) {
      const w = where(id);
      el.classList.toggle('closed', !w);
      el.classList.toggle('active', id === S.focus && !!w);
      el.classList.toggle('fullscreen', id === R.fullscreen);
      el.classList.toggle('offscreen', !!w && !visible(id));
      if (id === R.fullscreen) {
        Object.assign(el.style, { left: '0px', top: `${-$('#bar').offsetHeight}px`, width: `${A.W}px`, height: `${A.H + $('#bar').offsetHeight}px`, transform: 'none', zIndex: 60 });
      }
    }
    document.body.classList.toggle('special-open', R.specialOpen);
    renderBar();
    save();
  }
  function place(id, r, offsetX, kind, z) {
    const el = wins[id]; if (!el) return;
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
  const onScreen = () => Object.keys(wins).filter((id) => visible(id) && (!R.specialOpen || where(id).kind === 'special'));

  /* ---------- bar ---------- */
  function renderBar() {
    const used = new Set(Object.keys(S.ws).filter((k) => leaves(S.ws[k]).length).map(Number));
    Object.values(S.floating).forEach((f) => used.add(f.ws));
    used.add(S.active);
    const list = [...used].sort((a, b) => a - b);
    $('#workspaces').innerHTML = list.map((n) => `<button type="button" data-ws="${n}" class="${n === S.active && !R.specialOpen ? 'on' : ''}${leaves(S.ws[n]).length || Object.values(S.floating).some((f) => f.ws === n) ? ' used' : ''}" title="Workspace ${n}">${n}</button>`).join('')
      + (leaves(S.special).length ? `<button type="button" data-ws="special" class="special${R.specialOpen ? ' on' : ''}" title="Special workspace (mod+S)">S</button>` : '');
    $('#win-title').textContent = S.focus && visible(S.focus) ? NAMES[S.focus] : '';
  }
  $('#workspaces').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ws]'); if (!b) return;
    if (b.dataset.ws === 'special') toggleSpecial(); else workspace(+b.dataset.ws);
  });
  const clock = () => { $('#clock').textContent = new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Vancouver' }) + ' PT'; };
  clock(); setInterval(clock, 10000);

  /* ---------- dispatchers (Hyprland names) ---------- */
  function focus(id) {
    if (!id || !wins[id]) return;
    S.focus = id;
    const w = where(id);
    if (w?.kind !== 'special' && w) S.lastFocus[w.ws] = id;
    if (w?.kind === 'float') { // raise
      const f = S.floating[id]; delete S.floating[id]; S.floating[id] = f;
    }
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
      const dist = horiz ? Math.abs(rx - cx) : Math.abs(ry - cy);
      const off = horiz ? Math.abs(ry - cy) : Math.abs(rx - cx);
      const score = dist + off * 0.5 - (overlap > 0 ? 1e5 : 0);
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
        const size = (d === 'h' ? r.w : r.h) - CFG.gapsIn * 2;
        node.ratio = clampRatio(node.ratio + (side === 'a' ? 1 : -1) * delta / size);
        break;
      }
    }
    render();
  }
  const clampRatio = (x) => Math.min(1 - CFG.minRatio, Math.max(CFG.minRatio, x));
  function togglesplit() {
    const w = where(S.focus); if (!w || w.kind === 'float') return;
    const tree = w.kind === 'special' ? S.special : S.ws[w.ws];
    const p = path(tree, S.focus); if (!p?.length) return;
    const node = p[p.length - 1].node; node.dir = node.dir === 'h' ? 'v' : 'h';
    render();
  }
  function togglefloating() {
    const id = S.focus, w = where(id); if (!w) return;
    if (w.kind === 'float') {
      delete S.floating[id];
      insertTiled(S.active, id, null, null);
    } else {
      const [fw, fh] = CFG.floatSize;
      detach(id);
      S.floating[id] = { ws: S.active, x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh };
    }
    render();
  }
  function fullscreen() { R.fullscreen = R.fullscreen === S.focus ? null : S.focus; render(); }
  function killactive() {
    const id = S.focus; if (!where(id)) return;
    const pos = R.rects[id];
    detach(id);
    if (R.fullscreen === id) R.fullscreen = null;
    const v = wins[id].querySelector('iframe#video');
    if (v) { v.dataset.src = v.src; v.src = 'about:blank'; }
    render();
    const rest = onScreen();
    if (rest.length) {
      // focus whatever now occupies the closed window's centre
      const c = pos && { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 };
      focus(rest.find((r) => c && inRect(c, R.rects[r])) || rest[0]);
    } else { S.focus = null; render(); }
  }
  function open(id) {
    const w = where(id);
    if (w) { // already open: go to it
      if (w.kind === 'special') { R.specialOpen = true; } else if (w.ws !== S.active) S.active = w.ws;
      return focus(id);
    }
    if (R.specialOpen) insertTiled('special', id, S.focus, null); else insertTiled(S.active, id, S.focus, null);
    const v = wins[id].querySelector('iframe#video');
    if (v?.dataset.src) { v.src = v.dataset.src; delete v.dataset.src; }
    wins[id].classList.add('opening');
    setTimeout(() => wins[id].classList.remove('opening'), 30);
    focus(id);
    if (id === 'map' && typeof paintMap === 'function') paintMap();
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
    const i = used.indexOf(S.active);
    workspace(used[(i + d + used.length) % used.length]);
  }

  /* ---------- keyboard ---------- */
  // Alt mode: Alt (+Ctrl for keyboard resize). Ctrl+Alt mode: both required.
  const isMod = (e) => e.altKey && !e.metaKey && (S.mod !== 'ctrlalt' || e.ctrlKey);
  const ARROWS = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') { document.body.classList.add('mod-down'); if (S.mod === 'alt') e.preventDefault(); return; }
    if (!$('#launcher').hidden || !$('#help').hidden) return; // overlays handle their own keys
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
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') { document.body.classList.remove('mod-down'); if (S.mod === 'alt') e.preventDefault(); }
  }, true);
  addEventListener('blur', () => document.body.classList.remove('mod-down'));

  /* ---------- mouse ---------- */
  const inRect = (p, r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const local = (e) => { const b = desk.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const dividerAt = (p) => R.dividers.find((d) => d.dir === 'h'
    ? p.x >= d.pos - 3 && p.x <= d.pos + d.g + 3 && p.y >= d.rect.y && p.y <= d.rect.y + d.rect.h
    : p.y >= d.pos - 3 && p.y <= d.pos + d.g + 3 && p.x >= d.rect.x && p.x <= d.rect.x + d.rect.w);

  // focus follows mouse (Hyprland follow_mouse = 1): only on real movement, so a
  // layout change under a still cursor (float, close, swap) never steals focus.
  let lastXY = '';
  document.addEventListener('pointermove', (e) => {
    const xy = `${e.clientX},${e.clientY}`; const moved = xy !== lastXY; lastXY = xy;
    if (R.drag || !moved) return;
    const el = e.target.closest?.('.win'); if (!el) return;
    const id = el.dataset.tile;
    if (S.focus !== id && visible(id) && !(R.specialOpen && where(id)?.kind !== 'special')) { S.focus = id; const w = where(id); if (w && w.kind !== 'special') S.lastFocus[w.ws] = id; render(); }
  });
  // the pointer entering an iframe gives no pointermove to this page, so catch the iframe element's own enter
  for (const [id, el] of Object.entries(wins)) el.querySelectorAll('iframe').forEach((f) => f.addEventListener('pointerenter', (e) => {
    if (!R.drag && S.focus !== id && visible(id)) { S.focus = id; render(); }
  }));
  // keep binds working after clicking into an iframe: when the pointer leaves it, take focus back
  document.addEventListener('pointermove', () => { if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); window.focus(); } });

  desk.addEventListener('pointermove', (e) => {
    if (R.drag) return;
    const d = e.target === desk ? dividerAt(local(e)) : null;
    desk.style.cursor = d ? (d.dir === 'h' ? 'col-resize' : 'row-resize') : '';
  });
  desk.addEventListener('contextmenu', (e) => { if (isMod(e) || R.drag) e.preventDefault(); });

  desk.addEventListener('pointerdown', (e) => {
    const p = local(e);
    const winEl = e.target.closest('.win');
    // 1. drag the gap between two tiled windows (resize_on_border)
    if (e.target === desk && e.button === 0) {
      const d = dividerAt(p); if (!d) return;
      e.preventDefault();
      startDrag(e, { type: 'divider', d });
      return;
    }
    if (!winEl) return;
    const id = winEl.dataset.tile;
    if (where(id)?.kind === 'float') focus(id); // click raises a floating window
    // 2. plain LMB on a title bar: arm a move that starts once the pointer travels a few px,
    //    so clicks on the header's own buttons, links and inputs keep working
    if (!isMod(e) && e.button === 0 && e.target.closest('.panel-head') && !e.target.closest(INTERACTIVE) && !narrow()) {
      R.pending = { id, start: p, pointerId: e.pointerId };
      return;
    }
    // 3. mod + LMB move, mod + RMB resize (Hyprland bindm)
    if (!isMod(e) || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault(); e.stopPropagation();
    focus(id);
    const r = { ...R.rects[id] };
    if (e.button === 0) startDrag(e, { type: 'move', id, r, start: p, kind: where(id).kind });
    else {
      const w = where(id), tree = w.kind === 'special' ? S.special : S.ws[w.ws];
      const corner = { right: p.x > r.x + r.w / 2, bottom: p.y > r.y + r.h / 2 };
      const pick = (dir, wantSide) => (path(tree, id) || []).slice().reverse().find((s) => s.node.dir === dir && s.side === wantSide);
      startDrag(e, {
        type: 'resize', id, r, start: p, kind: w.kind, corner,
        hx: w.kind !== 'float' && pick('h', corner.right ? 'a' : 'b'),
        vy: w.kind !== 'float' && pick('v', corner.bottom ? 'a' : 'b'),
      });
    }
  }, true);

  const INTERACTIVE = 'input, textarea, select, button, a, label, summary, form, [contenteditable]';
  const narrow = () => matchMedia('(max-width: 900px)').matches;
  const HEADER_DRAG_THRESHOLD = 5;
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
    if (drag.type === 'move') wins[drag.id].classList.add('dragging');
    if (drag.hx) drag.hx0 = drag.hx.node.ratio;
    if (drag.vy) drag.vy0 = drag.vy.node.ratio;
    if (drag.type === 'resize' && drag.kind === 'float') drag.f0 = { ...S.floating[drag.id] };
    if (drag.type === 'move' && drag.kind === 'float') drag.f0 = { ...S.floating[drag.id] };
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
      else { const el = wins[d.id]; el.style.left = `${d.r.x + dx}px`; el.style.top = `${d.r.y + dy}px`; }
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
          const size = (s.node.dir === 'h' ? nr.w : nr.h) - CFG.gapsIn * 2;
          s.node.ratio = clampRatio(r0 + delta / size);
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
      wins[d.id].classList.remove('dragging');
      if (d.kind !== 'float') {
        const p = local(e);
        const target = onScreen().find((id) => id !== d.id && where(id)?.kind !== 'float' && inRect(p, R.rects[id]));
        if (target) {
          const key = d.kind === 'special' ? 'special' : S.active;
          detach(d.id);
          insertTiled(key, d.id, target, p);
        }
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
  function launcherItems() {
    const q = $('#launcher-input').value.toLowerCase();
    return Object.entries(NAMES).filter(([, n]) => n.toLowerCase().includes(q)).map(([id, n]) => {
      const w = where(id);
      const loc = !w ? 'closed' : w.kind === 'special' ? 'special' : w.kind === 'float' ? `workspace ${w.ws} · floating` : `workspace ${w.ws}`;
      return { id, n, loc };
    });
  }
  function fillLauncher() {
    const items = launcherItems(); sel = Math.min(sel, Math.max(0, items.length - 1));
    $('#launcher-list').innerHTML = items.map((it, i) => `<li role="option" data-id="${it.id}" class="${i === sel ? 'sel' : ''}"><span>${it.n}</span><small>${it.loc}</small></li>`).join('') || '<li class="muted">No match</li>';
  }
  $('#launcher-input').addEventListener('input', () => { sel = 0; fillLauncher(); });
  $('#launcher-input').addEventListener('keydown', (e) => {
    const items = launcherItems();
    if (e.key === 'ArrowDown') { sel = (sel + 1) % Math.max(1, items.length); fillLauncher(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % Math.max(1, items.length); fillLauncher(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[sel]) { launcher(false); open(items[sel].id); } e.preventDefault(); }
    else if (e.key === 'Escape') launcher(false);
  });
  $('#launcher-list').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) { launcher(false); open(li.dataset.id); } });
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
      [`${m} + LMB drag`, 'Move window (drop on a window to split it)'], [`${m} + RMB drag`, 'Resize window'],
      ['Drag a gap', 'Resize the split'], [`${m} + 1…9`, 'Switch workspace'], [`${m} + Shift + 1…9`, 'Move window to workspace'],
      [`${m} + scroll`, 'Cycle workspaces'], [`${m} + S`, 'Toggle special workspace'], [`${m} + Shift + S`, 'Move window to special workspace'],
      [`${m} + V`, 'Toggle floating'], [`${m} + F`, 'Fullscreen'], [`${m} + J`, 'Toggle split direction'],
      [`${m} + C`, 'Close window'], [`${m} + R`, 'Launcher: open a panel'], [`${m} + /`, 'This help'],
    ];
    $('#help-table').innerHTML = rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('');
  }
  $('#bar-help').addEventListener('click', () => help(true));
  $('#help-close').addEventListener('click', () => help(false));
  $('#help').addEventListener('pointerdown', (e) => { if (e.target.id === 'help') help(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#help').hidden) help(false); });
  $('#mod-select').addEventListener('change', (e) => { S.mod = e.target.value; save(); help(true); });
  $('#wm-reset').addEventListener('click', () => {
    const mod = S.mod; S = { ...DEFAULT(), mod }; R.specialOpen = false; R.fullscreen = null;
    for (const el of Object.values(wins)) { const v = el.querySelector('iframe#video'); if (v?.dataset.src) { v.src = v.dataset.src; delete v.dataset.src; } }
    help(false); render();
  });

  /* ---------- boot ---------- */
  let rt = 0;
  addEventListener('resize', () => { cancelAnimationFrame(rt); rt = requestAnimationFrame(render); });
  document.body.classList.add('wm-boot');
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('wm-boot')));
  window.wm = { state: () => S, runtime: R, open, focus, workspace, movetoworkspace, killactive, togglefloating, fullscreen, toggleSpecial, movefocus, movewindow, resizeactive, togglesplit, render };
})();
