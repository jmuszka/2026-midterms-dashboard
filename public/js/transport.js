/* Transport strip: scrub, play and jump back to live (docs/SCRUBBER.md §4). The track runs
 * from the first recorded moment to the latest data. Dragging to the right end latches back
 * to live. While replaying, the data hub feeds every window from the timeline. */
import { app, $, hub, replay, closeAt, closeLabel } from './core.js';
import { clock } from './clock.js';
import tl, * as T from './timeline.js';

const fmtT = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
const BUCKETS = 240;

// poll-close events as of a moment (the live feed gets these from the server)
function pollClosesAt(ms) {
  const by = {};
  for (const m of app.manifest) (by[m.close] ||= new Set()).add(m.state);
  return Object.entries(by).filter(([h]) => closeAt(h) <= ms).map(([h, st]) => ({ id: `close-${h}`, t: new Date(closeAt(h)).toISOString(), type: 'poll_close', text: `Polls close in ${[...st].sort().join(', ')}`, data: { states: [...st] } }));
}

function source(key) {
  const t = clock.t;
  if (key === 'results') return T.resultsAt(t);
  if (key === 'markets') return T.marketsAt(t);
  if (key === 'news') return T.newsAt(t);
  if (key === 'stocks') return T.stocksAt(t);
  if (key.startsWith('social:')) return T.postsAt(key.slice(7), t);
  if (key === 'trends') return T.trendsAt(t);
  if (key === 'streams') return T.streamsAt(t);
  return undefined;
}

export function startTransport() {
  const el = $('#transport');
  el.innerHTML = `
    <button type="button" class="tl-live" title="Back to live (L)">Live</button>
    <button type="button" class="tl-play" title="Play / pause the replay" aria-label="Play">▶</button>
    <select class="tl-speed" aria-label="Replay speed" title="Replay speed">${[[1, '1×'], [10, '10×'], [60, '60×'], [300, '300×'], [1200, '1200×']].map(([v, l]) => `<option value="${v}" ${v === clock.speed ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button type="button" class="tl-earlier" title="Load the 24 hours before the start of the timeline" hidden>◂ Earlier</button>
    <div class="tl-track" role="slider" tabindex="0" aria-label="Timeline: scrub to any recorded moment">
      <svg class="tl-marks" preserveAspectRatio="none"></svg>
      <div class="tl-played"></div><div class="tl-thumb"></div><div class="tl-hover" hidden></div>
    </div>
    <span class="tl-time"></span>`;
  const track = el.querySelector('.tl-track'), thumb = el.querySelector('.tl-thumb'), played = el.querySelector('.tl-played'), hover = el.querySelector('.tl-hover');
  const range = () => ({ a: tl.from, b: tl.to });
  const toX = (ms) => { const { a, b } = range(); return b > a ? Math.max(0, Math.min(1, (ms - a) / (b - a))) : 1; };
  const fromX = (x) => { const { a, b } = range(); return a + x * (b - a); };

  function drawMarks() {
    const svg = el.querySelector('.tl-marks');
    const { a, b } = range();
    if (!a || !b || b <= a) { svg.innerHTML = ''; return; }
    const ms = T.markers(BUCKETS);
    const max = Math.max(1, ...ms.map((m) => m.calls));
    const w = 100 / BUCKETS;
    const closes = [...new Set(app.manifest.map((m) => m.close))].map((h) => [h, closeAt(h)]).filter(([, t]) => t >= a && t <= b);
    svg.setAttribute('viewBox', '0 0 100 20');
    svg.innerHTML = closes.map(([h, t]) => `<line class="close" x1="${toX(t) * 100}" x2="${toX(t) * 100}" y1="0" y2="20"><title>Polls close ${closeLabel(h)} ET</title></line>`).join('')
      + ms.map((m, i) => (m.calls ? `<rect x="${i * w}" width="${w * 0.8}" y="${20 - (m.calls / max) * 18}" height="${(m.calls / max) * 18}" class="${m.flips ? (m.dem >= m.gop ? 'flip-d' : 'flip-r') : 'call'}"/>` : '')).join('');
  }
  function draw() {
    const live = clock.mode === 'live';
    const has = tl.loaded && tl.from && tl.to && tl.to > tl.from;
    const was = el.hidden;
    el.hidden = !has;
    if (was !== el.hidden) window.wm?.render(); // the strip takes height from the desktop
    if (!has) return;
    const t = live ? tl.to : clock.t;
    const x = toX(t) * 100;
    thumb.style.left = `${x}%`; played.style.width = `${x}%`;
    el.classList.toggle('replaying', !live);
    document.body.classList.toggle('replay', !live);
    el.querySelector('.tl-live').classList.toggle('on', live);
    el.querySelector('.tl-live').textContent = live ? 'Live' : 'Go live';
    const play = el.querySelector('.tl-play');
    play.textContent = clock.playing ? '❚❚' : '▶'; play.setAttribute('aria-label', clock.playing ? 'Pause' : 'Play');
    el.querySelector('.tl-time').innerHTML = live ? `<b>Live</b> · latest data ${fmtT(tl.to)}` : `<b>Replay</b> · ${fmtT(t)}`;
    track.setAttribute('aria-valuetext', live ? 'live' : fmtT(t));
  }

  function enterReplay(t) {
    const { a, b } = range();
    if (t >= b - 1000) return goLive();
    clock.set(Math.max(a, t));
  }
  function goLive() { clock.live(); }

  // hub wiring follows the clock
  let wasLive = true;
  clock.subscribe(() => {
    if (clock.mode === 'replay') {
      replay.source = source;
      replay.events = () => ({ list: T.eventsAt(clock.t), pollCloses: pollClosesAt(clock.t), now: new Date(clock.t).toISOString() });
      hub.replayTick();
    } else if (!wasLive) {
      replay.source = null; replay.events = null;
      hub.goLive();
    }
    wasLive = clock.mode === 'live';
    draw();
    window.dispatchEvent(new CustomEvent('clockchange'));
  });

  // scrubbing
  let dragging = false;
  const pos = (e) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); clock.pause(); enterReplay(fromX(pos(e))); });
  track.addEventListener('pointermove', (e) => {
    const x = pos(e);
    hover.hidden = false; hover.style.left = `${x * 100}%`; hover.textContent = fmtT(fromX(x));
    if (dragging) enterReplay(fromX(x));
  });
  track.addEventListener('pointerleave', () => { hover.hidden = true; });
  const end = () => { dragging = false; };
  track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
  track.addEventListener('wheel', (e) => { e.preventDefault(); step(e.deltaY > 0 ? 60e3 : -60e3); }, { passive: false });

  const step = (d) => { const base = clock.mode === 'live' ? tl.to : clock.t; enterReplay(base + d); };
  el.querySelector('.tl-live').addEventListener('click', goLive);
  el.querySelector('.tl-play').addEventListener('click', () => {
    if (clock.playing) return clock.pause();
    if (clock.mode === 'live') clock.set(tl.from); // play from the start of the record
    clock.play();
  });
  el.querySelector('.tl-speed').addEventListener('change', (e) => clock.setSpeed(+e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select, [contenteditable]') || !$('#launcher').hidden || !$('#reader').hidden) return;
    const k = e.key;
    if (k === ',' || k === '<') { step(-(e.shiftKey ? 600e3 : 60e3)); e.preventDefault(); }
    else if (k === '.' || k === '>') { step(e.shiftKey ? 600e3 : 60e3); e.preventDefault(); }
    else if (k === 'l' || k === 'L') { goLive(); e.preventDefault(); }
  });

  // playback: advance the clock; at the end of the record, go live
  let lastFrame = performance.now(), acc = 0;
  const frame = (now) => {
    const dt = now - lastFrame; lastFrame = now;
    if (clock.playing && clock.mode === 'replay') {
      acc += dt;
      if (acc >= 250) { // step at most 4 times a second: every step redraws every window
        const next = clock.t + acc * clock.speed; acc = 0;
        if (next >= tl.to) goLive(); else clock.set(next);
      }
    } else acc = 0;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  let throttle = 0;
  const origSet = clock.set.bind(clock);
  clock.set = (t) => { // coalesce rapid scrubbing into one redraw per animation frame
    clock.t = t; clock.mode = 'replay';
    if (throttle) return;
    throttle = requestAnimationFrame(() => { throttle = 0; origSet(clock.t); });
  };

  const earlier = el.querySelector('.tl-earlier');
  earlier.addEventListener('click', async () => { earlier.disabled = true; earlier.textContent = 'Loading…'; await T.loadEarlier(); earlier.disabled = false; earlier.textContent = '◂ Earlier'; });
  tl.subscribe(() => {
    earlier.hidden = !T.canLoadEarlier();
    drawMarks(); draw();
    if (clock.pending && tl.from) { const t = clock.pending; clock.pending = null; enterReplay(t); }
    if (clock.mode === 'replay') hub.replayTick(); // new rows may change the state at the current moment
  });
  addEventListener('resize', drawMarks);
  T.start();
}
