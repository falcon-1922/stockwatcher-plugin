// Who made this, and one line about what they teach. Stockwatcher is built by Maria Sukhareva
// (AI Realist, airealist.org); the page shows a single quiet line pointing to a current
// workshop or the newsletter, one at a time.
//
// The workshop dates come from airealist.org itself, at very low cost:
// - at most once a day, and only while the dashboard is in use, the workshops page is read
//   (one request, about 8 KB);
// - each workshop page it links to is read once and kept for a week (its date and place come
//   from the page's own schema.org event data); a newly listed workshop is read the same day;
// - a date that has passed is dropped without asking anyone.
// Nothing about the person or what they look at is sent. If the site cannot be reached, the
// list that shipped with the skill (data/promo.json) is used, minus dates that have passed.
import { readFileSync } from 'node:fs';
import { saveFile } from './store.mjs';
import { VERSION } from './home.mjs';

export const SITE = 'https://airealist.org';
const SUBSTACK = 'https://msukhareva.substack.com';
const LIST_URL = SITE + '/workshops/';
const TAG = 'utm_source=stockwatcher';
const tagged = url => url + (url.includes('?') ? '&' : '?') + TAG;

export const ABOUT = {
  maker: 'Maria Sukhareva',
  linkedin: 'https://www.linkedin.com/in/msukhareva/',
  site: tagged(SITE + '/'),
  siteName: 'airealist.org',
};

const DAY_MS = 86_400_000;
const LIST_TTL_MS = DAY_MS;            // the workshops page: once a day at most
const PAGE_TTL_MS = 7 * DAY_MS;        // one workshop's page: once a week
const MAX_PAGES = 8;
const MAX_BYTES = 600_000;

// Links to single workshop or event pages on the site, in page order.
export function eventLinks(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/href="(?:https:\/\/airealist\.org)?(\/(?:workshops|events)\/[a-z0-9-]+\/)"/g)) {
    const url = SITE + m[1];
    if (!out.includes(url)) out.push(url);
    if (out.length === MAX_PAGES) break;
  }
  return out;
}

// The first schema.org event on a page → { name, start, place }, or null.
export function readEvent(html) {
  for (const m of String(html || '').matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let json;
    try { json = JSON.parse(m[1]); } catch { continue; }
    const list = Array.isArray(json) ? json : json && Array.isArray(json['@graph']) ? json['@graph'] : [json];
    for (const e of list) {
      if (!e || !/Event$/.test(String(e['@type'])) || typeof e.name !== 'string' || isNaN(Date.parse(e.startDate))) continue;
      const online = /Online/.test(String(e.eventAttendanceMode));
      const city = e.location && e.location.address && e.location.address.addressLocality;
      return { name: e.name.slice(0, 160), start: String(e.startDate), place: online ? 'online' : typeof city === 'string' ? city.slice(0, 40) : '' };
    }
  }
  return null;
}

// "Agentic AI Masterclass, Zurich — hands-on AI agents training" → "Agentic AI Masterclass, Zurich"
// "Beyond PowerPoint: A hands-on workshop…" → "Beyond PowerPoint"; a very short first part
// ("wAIn: Open-Weight AI Evening") is kept with what follows.
const shortName = n => {
  const dash = n.split(/\s[—–-]\s/)[0].trim(), colon = dash.split(/:\s/)[0].trim();
  return (colon.length >= 10 ? colon : dash).slice(0, 60);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The date as the page states it (its own time zone): "2027-02-11T09:00:00+01:00" → "11 Feb 2027"
const dayOf = iso => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; };

function eventText(e) {
  const name = shortName(e.name);
  const place = e.place && !name.toLowerCase().includes(e.place.toLowerCase()) ? e.place : '';
  return [name, place, dayOf(e.start)].filter(Boolean).join(' · ');
}

// What a workshop teaches, in words that fit this page. A kind without a coming date points
// to the workshops page, which is always current.
const KINDS = [
  { id: 'skills', re: /agent/i, lead: 'Learn to build skills like this one:' },
  { id: 'visuals', re: /powerpoint|slides?|visual/i, lead: 'Learn to build visualisations like this:' },
];

// The lines the page may show, one at a time: [{ id, lead, text, url }].
export function promoItems(pages, now = Date.now()) {
  const coming = Object.entries(pages || {})
    .filter(([url, p]) => url.startsWith(SITE + '/') && p && p.event && Date.parse(p.event.start) > now)
    .map(([url, p]) => ({ ...p.event, url }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const used = new Set();
  const items = KINDS.map(k => {
    const e = coming.find(x => !used.has(x.url) && k.re.test(x.name + ' ' + x.url));
    if (e) used.add(e.url);
    return { id: k.id, lead: k.lead, text: e ? eventText(e) : 'AI Realist workshops and courses', url: tagged(e ? e.url : LIST_URL) };
  });
  items.push({ id: 'news', lead: 'Honest, data-driven analysis of AI news:', text: 'read AI Realist', url: tagged(SUBSTACK + '/') });
  for (const e of coming.filter(x => !used.has(x.url)).slice(0, 2)) items.push({ id: 'event', lead: 'Coming up at AI Realist:', text: eventText(e), url: tagged(e.url) });
  items.push({ id: 'newsletter', lead: 'Independent AI analysis in your inbox:', text: 'subscribe to the AI Realist newsletter', url: tagged(SUBSTACK + '/subscribe') });
  return items;
}

// Reads the site: the workshops page, then only the workshop pages not read lately.
// `pages` is what is known so far ({ url: { at, event } }); returns the new set.
export async function readSite(pages = {}, { fetchImpl = fetch, now = Date.now(), log = () => {} } = {}) {
  const get = async url => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'stockwatcher-skill/' + VERSION, Accept: 'text/html' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(url + ' answered ' + res.status);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(url + ' is too large');
    return text;
  };
  const links = eventLinks(await get(LIST_URL));
  if (!links.length) throw new Error('no workshop links on ' + LIST_URL);
  const next = {};
  let read = 0;
  for (const url of links) {
    const old = pages[url];
    if (old && now - old.at < PAGE_TTL_MS) { next[url] = old; continue; }
    try { next[url] = { at: now, event: readEvent(await get(url)) }; read++; }
    catch (e) { if (old) next[url] = old; log('promo: ' + e.message); }
  }
  log('promo: workshops page read, ' + read + ' of ' + links.length + ' workshop pages refreshed');
  return next;
}

// `file`: where the list is kept between runs (cache folder). `bundledPath`: the list that
// ships with the skill. items() answers at once from what is known and, when that is over a
// day old, refreshes it in the background for next time.
export function createPromo({ fetchImpl = fetch, file = null, bundledPath = null, log = () => {}, now = () => Date.now(), offline = false } = {}) {
  let state = { at: 0, pages: {} };
  for (const p of [bundledPath, file]) {
    if (!p) continue;
    try { const s = JSON.parse(readFileSync(p, 'utf8')); if (s && s.pages && (s.at || 0) >= state.at) state = { at: s.at || 0, pages: s.pages }; } catch { /* missing */ }
  }
  let tried = file ? state.at : 0, running = null;
  const refresh = () => running || (running = readSite(state.pages, { fetchImpl, now: now(), log })
    .then(pages => { state = { at: now(), pages }; if (file) saveFile(file, JSON.stringify(state), log); },
      e => log('promo: not refreshed, keeping the old list (' + e.message + ')'))
    .finally(() => { running = null; }));
  return {
    items() {
      // One try a day, whether it worked or not: a computer that is offline is not asked again and again.
      if (!offline && now() - tried > LIST_TTL_MS) { tried = now(); refresh(); }
      return promoItems(state.pages, now());
    },
    refresh,
    state: () => state,
  };
}
