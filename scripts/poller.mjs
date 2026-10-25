#!/usr/bin/env node
// Standalone poller for any always-on machine (a home server, Home Assistant box, laptop):
// calls the deployed /api/poll on an interval so the shared store stays fresh.
//   POLL_URL=https://<app>.vercel.app/api/poll POLL_SECRET=... node scripts/poller.mjs [seconds]
const url = process.env.POLL_URL, secret = process.env.POLL_SECRET;
const every = (+process.argv[2] || 30) * 1000;
if (!url) { console.error('set POLL_URL'); process.exit(1); }
async function tick() {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: secret ? { authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(55000) });
    const body = await res.json().catch(() => ({}));
    const ran = Object.entries(body.tasks || {}).filter(([, v]) => !v.skipped).map(([k, v]) => (v.ok ? k : `${k}!`));
    console.log(`${new Date().toLocaleTimeString()} ${res.status} ${Date.now() - t0}ms ${ran.join(' ') || '(nothing due)'}`);
  } catch (e) { console.error(`${new Date().toLocaleTimeString()} poll failed: ${e.message}`); }
}
tick(); setInterval(tick, every);
