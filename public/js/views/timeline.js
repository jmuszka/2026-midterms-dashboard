/* Poll-closing timeline: 6 pm to 1 am ET with a now-marker, what closes when, and
 * which states count slowly or go to runoffs. Countdown to the next close. */
import { app, esc, closeAt, closeLabel, subscribeEvents } from '../core.js';

export default {
  type: 'timeline', name: 'Poll closings',
  defaults: {},
  settings: [],
  title: () => 'Poll closings',
  mount(body, settings, ctx) {
    const groups = {};
    for (const m of app.manifest) {
      const g = (groups[m.close] ||= { states: new Set(), races: { S: [], H: [], G: [] }, competitive: 0 });
      g.states.add(m.state); g.races[m.chamber].push(m);
      if (Math.abs(m.consensus?.score ?? 3) < 1.5) g.competitive++;
    }
    const times = Object.keys(groups).sort();
    let now = Date.now();
    const draw = () => {
      const t0 = closeAt('18:00'), t1 = closeAt('25:00');
      const x = (t) => ((t - t0) / (t1 - t0)) * 100;
      const next = times.find((h) => closeAt(h) > now);
      const left = next ? closeAt(next) - now : 0;
      const cd = next ? (left > 86400e3 ? `${Math.floor(left / 86400e3)}d ${Math.floor((left % 86400e3) / 3600e3)}h` : `${Math.floor(left / 3600e3)}h ${String(Math.floor((left % 3600e3) / 60e3)).padStart(2, '0')}m`) : '';
      body.innerHTML = `<div class="timeline">
        <div class="tl-head">${next ? `Next: <b>${closeLabel(next)} ET</b> in <b>${cd}</b> · ${[...groups[next].states].sort().join(', ')}` : 'All polls have closed'}${app.sim ? ' <span class="badge sim">SIM clock</span>' : ''}</div>
        <div class="tl-track">${times.map((h) => `<span class="tick ${closeAt(h) <= now ? 'past' : ''}" style="left:${x(closeAt(h))}%"><b>${closeLabel(h)}</b></span>`).join('')}
          ${now >= t0 && now <= t1 ? `<span class="now" style="left:${x(now)}%"></span>` : ''}</div>
        <ol class="tl-list">${times.map((h) => {
          const g = groups[h];
          const slow = [...g.states].filter((s) => app.config.states[s]?.slow || app.config.states[s]?.runoff);
          return `<li class="${closeAt(h) <= now ? 'past' : ''}"><span class="when">${closeLabel(h)}</span>
            <span class="what"><b>${[...g.states].sort().join(', ')}</b><br><span class="muted">${g.races.S.length} Senate · ${g.races.G.length} governor · ${g.races.H.length} House${g.competitive ? ` · ${g.competitive} competitive` : ''}</span>
            ${slow.length ? `<br><span class="slow">${slow.map((s) => `<abbr title="${esc(app.config.states[s].slow || app.config.states[s].runoff)}">${s}</abbr>`).join(' ')} count slowly or may go to a runoff</span>` : ''}</span></li>`;
        }).join('')}</ol></div>`;
    };
    const un = subscribeEvents((st) => { if (st.now) now = Date.parse(st.now); draw(); });
    const timer = setInterval(() => { if (!app.sim && !document.body.classList.contains('replay')) now = Date.now(); draw(); }, 30000);
    draw();
    return { destroy() { un(); clearInterval(timer); } };
  },
};
