// Minimal RSS/Atom parsing shared by the news, trends and Truth Social fallback feeds.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
export function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export const unCdata = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
export const stripTags = (s) => unCdata(s).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
export function tag(x, name) {
  const m = x.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decode(stripTags(m[1])) : '';
}
export const rawTag = (x, name) => x.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '';

export function parseRSS(xml, feedName, feedId) {
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const isGoogle = /news\.google\./i.test(xml.slice(0, 2000)) || /google/i.test(feedName);
  return items.map((x) => {
    let title = tag(x, 'title');
    const source = tag(x, 'source') || feedName;
    if (isGoogle && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    let link = tag(x, 'link');
    if (!link) { const m = x.match(/<link\b[^>]*href="([^"]+)"/i); link = m ? decode(m[1]) : ''; }
    const published = Date.parse(tag(x, 'pubDate') || tag(x, 'dc:date') || tag(x, 'published') || tag(x, 'updated')) || null;
    const description = isGoogle ? '' : tag(x, 'description').slice(0, 280);
    const image = x.match(/<media:(?:content|thumbnail)\b[^>]*url="([^"]+)"/i)?.[1] || x.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*type="image/i)?.[1] || null;
    return { title, link, source, feed: feedName, feedId: feedId || null, published, description, image: image ? decode(image) : null, raw: x };
  }).filter((i) => i.title && i.link);
}
