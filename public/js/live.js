/* Live wiring for the read-only site (docs/SCRUBBER.md §0a):
 *  - Realtime nudge: subscribe to scraper heartbeat inserts; each one means "new data", so the
 *    windows refetch right away instead of waiting for their next poll. Polling stays the
 *    data channel: Realtime's free tier caps at 200 connections, and past that viewers simply
 *    keep polling through the CDN.
 *  - Paused banner: if the scraper stops reporting, say so instead of showing stale data as live. */
import { app, $, hub, refreshEvents, etTime } from './core.js';
import { refresh as refreshTimeline } from './timeline.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
const PAUSED_AFTER = 180; // seconds without a heartbeat
const TASK_KEYS = (tasks) => Object.keys(tasks || {}).flatMap((t) => (t === 'results' ? ['results', 'events'] : t === 'stockcharts' ? ['stocks'] : [t]));

let last = 0;
function nudge(beat) {
  const now = Date.now();
  if (now - last < 3000) return; // a burst of heartbeats (catch-up after a stall) refreshes once
  last = now;
  const v = beat?.id || Math.floor(now / 10000);
  const ran = new Set(TASK_KEYS(beat?.tasks));
  for (const k of hub.keys()) if (!beat?.tasks || ran.has(k)) hub.refresh(k, v);
  if (!beat?.tasks || ran.has('events')) refreshEvents(v);
  if (!beat?.tasks || ran.has('results') || ran.has('markets') || ran.has('stocks')) refreshTimeline(v); // the scrubber's right edge follows the data
  setPaused(null);
}

function setPaused(since) {
  const el = $('#paused-banner');
  const show = !!since;
  if (el.hidden === !show && (!show || el.dataset.since === since)) return;
  el.hidden = !show;
  if (show) { el.dataset.since = since; el.textContent = `Live data paused since ${etTime(since)} ET: the results scraper has stopped reporting. Numbers on screen are from then.`; }
  window.wm?.render(); // the banner changes the desktop's height
}

async function checkStatus() {
  try {
    const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
    const age = s.scraper?.age;
    setPaused(age == null || age > PAUSED_AFTER ? (s.scraper?.t || null) : null);
    if (age == null && !s.scraper?.t) setPaused(new Date().toISOString());
  } catch { /* network blip: keep the current state */ }
}

export async function startLive() {
  if (!app.config.readOnly || app.sim) return;
  checkStatus();
  setInterval(checkStatus, 30000);
  const rt = app.config.realtime;
  if (!rt) return;
  try {
    const { createClient } = await import(SUPABASE_JS);
    const client = createClient(rt.url, rt.key, { auth: { persistSession: false, autoRefreshToken: false } });
    client.channel('scraper-heartbeat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: rt.table }, (msg) => { document.body.dataset.beats = String(+(document.body.dataset.beats || 0) + 1); nudge(msg.new); })
      .subscribe((status) => { document.body.dataset.realtime = status === 'SUBSCRIBED' ? 'on' : 'off'; });
  } catch (e) { console.warn('realtime unavailable, polling only:', e.message); }
}
