/* First-visit guided tour: a spotlight on one UI element at a time with a short narrative card.
 * Steps whose target is missing or off-screen (a custom layout, another workspace, a phone) are
 * skipped. Esc or Skip ends it; ← → / Back / Next move. Seen state lives in localStorage
 * us-dash-tour-v1 (this site uses no cookies) and is set as soon as the tour first opens, so a
 * closed tab counts as seen. Restart from the help dialog (?) or with ?tour=1. */
import { $, app, toast } from './core.js';

export const TOUR_KEY = 'us-dash-tour-v1';
export const tourSeen = () => { try { return localStorage.getItem(TOUR_KEY) === '1'; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(TOUR_KEY, '1'); } catch {} };

const visible = (el) => {
  if (!el) return false;
  const w = el.closest('.win');
  if (w && (w.classList.contains('closed') || w.classList.contains('offscreen') || w.dataset.kind === 'special-hidden')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const win = (type) => [...document.querySelectorAll(`.win:has([data-type="${type}"])`)].find(visible);

// Each step: target (selector string, or a function returning an element), title, text (HTML), and
// where the card goes relative to the target.
const STEPS = () => [
  { target: '.brand', place: 'below', title: 'Welcome to Midterms 2026',
    text: `A second screen for the US midterm elections of Tuesday 3 November 2026: the Senate, the House and the governors' races, live from CNN/AP and official state feeds, with maps, seat counts, prediction markets, news, pundits and TV streams on one page. Every window here can be moved, resized, closed or swapped for another.` },
  { target: '#status', place: 'below', title: 'The status line',
    text: `How fresh the numbers are: how many races are reporting, how many have been called, and when the data was last written. A red strip under this bar means something is off: <b>SIMULATION</b> is invented data for trying the dashboard out, <b>Live data paused</b> means the results feed has stopped.` },
  { target: () => win('balance'), place: 'right', title: 'Balance of power',
    text: `The headline: seats won and leading for each chamber, with the line each party needs for a majority. Solid blocks are called races; hatched blocks are leads that can still change. Holdover seats not up this year are counted in but muted. The percentages next to <b>Markets</b> are what prediction markets price for control of each chamber.` },
  { target: () => win('map'), place: 'right', title: 'The map',
    text: `Every state or district coloured by its result. Click one to open its race card: candidates, votes, counties, ratings and market odds. The dropdown switches between live results and the pre-election ratings; the Senate / House / Gov buttons change the race. Scroll to zoom.` },
  { target: () => win('stream'), place: 'left', title: 'Live streams',
    text: `Election-night coverage from the networks and independent channels. Use the arrows or the dropdown to change source, or paste any YouTube link. Sound is the player's own mute button. In replay, the stream follows the timeline to the same moment.` },
  { target: () => win('feed'), place: 'left', title: 'The live feed',
    text: `Everything that happens, newest first: race calls, flips, lead changes, tight margins, polls closing, market moves. Filter it by a name, state or district. Important calls also pop up as toasts in the corner.` },
  { target: () => win('news'), place: 'left', title: 'News',
    text: `Headlines from the wires, national outlets and state papers, split into lanes. Click a headline to read it here in a reader view; Ctrl-click opens the original site.` },
  { target: () => [...document.querySelectorAll('.win .panel-head')].find(visible), place: 'below', title: 'Every window works the same way',
    text: `Drag the title bar to move a window (drop it on another to split that space). The gear opens the window's settings, the × closes it. Hold <b>Alt</b> and use the arrow keys to move focus between windows; the ? button lists every shortcut.` },
  { target: '#workspaces', place: 'below', title: 'Workspaces',
    text: `Five desktops of windows, like a tiling window manager. The default set is: 1 the overview, 2 Senate and House seats with the race browser, 3 markets and pundits, 4 the House map, 5 stock markets. Click a number or press Alt + 1…5. <i>S</i> is a scratch workspace that drops over the others.` },
  { target: '#transport', place: 'below', title: 'The timeline',
    text: `Election night is recorded. Drag the strip, or press ← →, to replay any moment: the map, the seat counts, the feed, the markets and the streams all go back to how they were then. <b>Live</b> returns to now; the speed menu plays the night back faster than real time.` },
  { target: '#bar-launch', place: 'below', title: 'Panels',
    text: `Open new windows of any type, load a named layout preset (the overview, a stream wall, a markets desk…), or jump to a window that is already open. Also Alt + R.` },
  { target: '#bar-share', place: 'below', title: 'Share',
    text: `Copies a link that carries this exact layout and every window's settings. Your arrangement is also remembered in this browser between visits.` },
  { target: '#bar-help', place: 'below', title: 'That is the tour',
    text: `The ? button has every keyboard shortcut and lets you take this tour again. Enjoy the night.` },
];

let state = null;
export function startTour({ force = false } = {}) {
  if (state) return;
  if (!force && tourSeen()) return;
  markSeen();
  const steps = STEPS();
  const root = document.createElement('div');
  root.className = 'tour'; root.id = 'tour';
  root.innerHTML = `<div class="tour-back"></div><div class="tour-spot"></div>
    <div class="tour-card" role="dialog" aria-labelledby="tour-title" aria-live="polite">
      <div class="tour-step"></div><h3 id="tour-title"></h3><p></p>
      <div class="tour-actions"><button type="button" class="tour-skip">Skip tour</button><span class="tour-dots"></span><span><button type="button" class="tour-back-btn">Back</button> <button type="button" class="tour-next">Next</button></span></div>
    </div>`;
  document.body.appendChild(root);
  const spot = root.querySelector('.tour-spot'), card = root.querySelector('.tour-card');
  state = { root, steps, i: -1, el: null };

  const resolve = (s) => (typeof s.target === 'function' ? s.target() : document.querySelector(s.target));
  const usable = (k) => { const el = resolve(steps[k]); return visible(el) ? el : null; };
  const show = (k, dir = 1) => {
    // skip steps whose target is not on screen
    while (k >= 0 && k < steps.length && !usable(k)) k += dir;
    if (k < 0) k = 0;
    if (k >= steps.length) return end(true);
    const el = usable(k); if (!el) return end(true);
    state.i = k; state.el = el;
    const s = steps[k], shown = steps.filter((_, j) => usable(j) || j === k);
    card.querySelector('.tour-step').textContent = `${shown.indexOf(s) + 1} of ${shown.length}`;
    card.querySelector('h3').textContent = s.title; card.querySelector('p').innerHTML = s.text;
    card.querySelector('.tour-dots').innerHTML = shown.map((x) => `<i class="${x === s ? 'on' : ''}"></i>`).join('');
    card.querySelector('.tour-back-btn').disabled = !steps.slice(0, k).some((_, j) => usable(j));
    card.querySelector('.tour-next').textContent = steps.slice(k + 1).some((_, j) => usable(k + 1 + j)) ? 'Next' : 'Done';
    root.dataset.step = s.target === '#transport' ? 'transport' : '';
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    place();
    card.querySelector('.tour-next').focus({ preventScroll: true });
  };
  const place = () => {
    const el = state.el; if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const s = steps[state.i], cw = card.offsetWidth, ch = card.offsetHeight, gap = 12, vw = innerWidth, vh = innerHeight;
    if (vw < 900) { card.style.left = card.style.top = ''; card.classList.add('fixed'); return; }
    card.classList.remove('fixed');
    let pref = s.place;
    const fits = { below: r.bottom + gap + ch < vh, above: r.top - gap - ch > 0, right: r.right + gap + cw < vw, left: r.left - gap - cw > 0 };
    if (!fits[pref]) pref = ['below', 'right', 'left', 'above'].find((p) => fits[p]) || 'below';
    let x, y;
    if (pref === 'below') { x = r.left + r.width / 2 - cw / 2; y = r.bottom + gap; }
    else if (pref === 'above') { x = r.left + r.width / 2 - cw / 2; y = r.top - gap - ch; }
    else if (pref === 'right') { x = r.right + gap; y = r.top + Math.min(24, Math.max(0, r.height / 2 - ch / 2)); }
    else { x = r.left - gap - cw; y = r.top + Math.min(24, Math.max(0, r.height / 2 - ch / 2)); }
    x = Math.max(8, Math.min(vw - cw - 8, x)); y = Math.max(8, Math.min(vh - ch - 8, y));
    card.style.left = `${x}px`; card.style.top = `${y}px`;
    card.dataset.place = pref;
  };
  const end = (finished) => {
    if (!state) return;
    removeEventListener('resize', place); document.removeEventListener('keydown', keys, true);
    state.root.remove(); state = null;
    if (finished) toast('Tour finished. Take it again from the <b>?</b> button any time.');
  };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); show(state.i + 1, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); show(state.i - 1, -1); }
  };
  root.querySelector('.tour-skip').addEventListener('click', () => end(false));
  root.querySelector('.tour-next').addEventListener('click', () => show(state.i + 1, 1));
  root.querySelector('.tour-back-btn').addEventListener('click', () => show(state.i - 1, -1));
  root.querySelector('.tour-back').addEventListener('click', () => show(state.i + 1, 1));
  document.addEventListener('keydown', keys, true);
  addEventListener('resize', place);
  show(0, 1);
}
export const tourOpen = () => !!state;
