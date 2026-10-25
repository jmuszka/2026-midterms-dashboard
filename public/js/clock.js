/* The dashboard clock (docs/SCRUBBER.md §3). In live mode the windows show the newest data,
 * exactly as before. In replay mode `t` is a moment the viewer chose, and the data hub feeds
 * every window the state at that moment from the timeline bundle. */
const subs = new Set();
export const clock = {
  mode: 'live',          // 'live' | 'replay'
  t: null,               // ms, only meaningful in replay
  playing: false,
  speed: 60,             // replay seconds per real second
  pending: null,         // a moment from a share link, applied once the timeline loads
  set(t) { this.mode = 'replay'; this.t = t; emit(); },
  live() { this.mode = 'live'; this.t = null; this.playing = false; emit(); },
  play() { if (this.mode !== 'replay') return; this.playing = true; emit(); },
  pause() { this.playing = false; emit(); },
  setSpeed(x) { this.speed = x; emit(); },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};
function emit() { for (const fn of subs) { try { fn(clock); } catch (e) { console.error(e); } } }
