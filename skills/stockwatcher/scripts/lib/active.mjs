// "Most active", "top 100 by trading volume", "after hours", "pre-market": what is trading
// most right now, and prices outside the regular session.
//
// Sources, both read-only, no key:
// - Nasdaq's stock screener (the same request the stock list comes from): today's share
//   volume and last price for every US listing. Ranked by dollars traded (price × shares), so
//   sub-$1 shares that trade billions of shares for pennies do not crowd out real companies.
//   Kept for five minutes.
// - Nasdaq's watchlist quotes: the latest trade in or outside regular hours, 20 symbols per
//   request (100 shares = 5 requests in parallel, about a quarter of a second). Kept a minute.
import { SCREENER_URL } from './stockindex.mjs';
import { UA } from './prices.mjs';
import { stockOf } from './resolve.mjs';
import { TO_GICS } from './indices.mjs';

export const ACTIVE = /\b(?:most[\s-]+(?:active|traded)|busiest|(?:market\s+)?movers|trading\s+(?:the\s+)?most|volume\s+leaders?|(?:highest|biggest|largest|most|top|heaviest)(?:\s+\d{1,3})?\s+(?:trading\s+|share\s+|dollar\s+)?volumes?|(?:by|with)\s+(?:the\s+)?(?:top\s+\d{1,3}\s+|highest\s+|most\s+)?(?:trading\s+|share\s+|dollar\s+)?volumes?|(?:trading|share)\s+volumes?)\b/i;
export const EXTENDED = /\b(?:after[\s-]*hours?|after[\s-]*market|after[\s-]*the[\s-]*close|post[\s-]*market|extended[\s-]*(?:hours|trading|session)|pre[\s-]*market|before\s+the\s+open)\b/i;
export const isActive = q => ACTIVE.test(String(q || ''));
export const isExtended = q => EXTENDED.test(String(q || ''));

// "top 100", "100 most active", "top 50 by volume" → 100 / 50. Default 100, at most 200.
export function countOf(q) {
  const m = /\btop\s+(\d{1,3})\b|\b(\d{1,3})\s+(?:most|busiest|highest|biggest|largest|top)\b/i.exec(String(q || ''));
  const n = m ? +(m[1] || m[2]) : 100;
  return Math.max(10, Math.min(200, n || 100));
}

// The words this module answered, taken out of the request so the rest still works
// ("nvidia and amd after hours" → "nvidia and amd"). A lone "now" or "today" goes too: next to
// these words it means the time, not ServiceNow's ticker.
export function stripMarketWords(q) {
  let s = String(q || '');
  for (let i = 0; i < 4 && (ACTIVE.test(s) || EXTENDED.test(s)); i++) s = s.replace(ACTIVE, ' ').replace(EXTENDED, ' ');
  return s.replace(/\btop\s+\d{1,3}\b|\b\d{1,3}\s+(?:most|busiest)\b|\b(?:right\s+)?now\b|\btoday\b|\bcurrently\b/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').trim();
}

// The US session by the clock in New York: 'pre' 4:00–9:30, 'regular' 9:30–16:00,
// 'after' 16:00–20:00, otherwise 'closed' (also weekends; holidays are not known here).
export function sessionAt(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'closed';
  const m = +parts.hour * 60 + +parts.minute;
  return m >= 240 && m < 570 ? 'pre' : m >= 570 && m < 960 ? 'regular' : m >= 960 && m < 1200 ? 'after' : 'closed';
}

const num = v => +String(v == null ? '' : v).replace(/[^0-9.\-]/g, '') || 0;
const money = v => v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'bn' : v >= 1e6 ? '$' + Math.round(v / 1e6) + 'm' : '$' + Math.round(v / 1e3) + 'k';

// Screener rows → the top N shares in the stock list by dollars traded today, grouped by
// sector (largest first), each with what was traded.
export function activeSection(screenerRows, index, n = 100) {
  const bySym = new Map(index.map(r => [r[0], r]));
  const names = new Set(), picked = [];
  const ranked = (screenerRows || []).map(r => {
    const sym = String(r.symbol || '').trim().replace('/', '-'), price = num(r.lastsale), vol = num(r.volume);
    return { sym, price, vol, dollars: price * vol };
  }).filter(r => r.price >= 1 && r.vol > 0 && bySym.has(r.sym)).sort((a, b) => b.dollars - a.dollars);
  for (const r of ranked) {
    const row = bySym.get(r.sym), key = row[1].toLowerCase();
    if (names.has(key)) continue;              // GOOG and GOOGL are one company
    names.add(key);
    picked.push({ row, ...r });
    if (picked.length === n) break;
  }
  if (!picked.length) return null;
  const bySector = new Map();
  for (const p of picked) {
    const sector = TO_GICS[p.row[2]] || 'Other';
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push({ ...stockOf(p.row), x: money(p.dollars) + ' traded', traded: Math.round(p.dollars) });
  }
  const sum = l => l.reduce((a, s) => a + s.traded, 0);
  const groups = [...bySector.entries()].map(([name, stocks]) => ({ name, note: '', stocks: stocks.sort((a, b) => b.traded - a.traded) }))
    .sort((a, b) => sum(b.stocks) - sum(a.stocks));
  return {
    id: 'active', title: 'Most active: top ' + picked.length + ' by trading volume', big: true, sizeBy: 'traded', groups,
    blurb: 'The ' + picked.length + ' US shares with the most money traded today (share volume × price, Nasdaq), grouped by sector; block size is the amount traded.',
  };
}

// Nasdaq watchlist answer → { SYMBOL: { p, at, status } } with Yahoo-style symbols (BRK-B).
export function readWatchlist(json) {
  const out = {};
  for (const r of (json && json.data) || []) {
    const p = num(r.lastSalePrice);
    if (!r.symbol || !p) continue;
    out[String(r.symbol).replace('.', '-')] = { p, at: String(r.lastTradeTimestamp || '').replace(/^.*?(\w{3} \d+, \d{4} )/, '$1'), status: String(r.marketStatus || '') };
  }
  return out;
}

export function createActive({ fetchImpl = fetch, log = () => {}, now = () => Date.now() } = {}) {
  let screener = null, screenerAt = 0, screenerRun = null;
  const ext = new Map();   // symbol → { at, q }
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const getJson = (url, ms) => fetchImpl(url, { headers, signal: AbortSignal.timeout(ms) }).then(r => { if (!r.ok) throw new Error('Nasdaq answered ' + r.status); return r.json(); });

  async function rows() {
    if (screener && now() - screenerAt < 60_000) return screener;
    screenerRun = screenerRun || getJson(SCREENER_URL, 8000).then(j => {
      const r = j && j.data && j.data.rows;
      if (!Array.isArray(r) || r.length < 1000) throw new Error('the Nasdaq screener returned too little');
      screener = r; screenerAt = now(); log('active: screener read, ' + r.length + ' rows');
      return r;
    }).finally(() => { screenerRun = null; });
    try { return await screenerRun; } catch (e) { if (screener) return screener; throw e; }
  }

  return {
    // The "Most active" section for this request.
    async section(q, index) { return activeSection(await rows(), index, countOf(q)); },
    // Latest trades (any session) for US symbols; what fails is left out.
    async extended(symbols) {
      const us = [...new Set(symbols)].filter(s => !s.includes('.'));
      const fresh = {}, need = [];
      for (const s of us) { const h = ext.get(s); if (h && now() - h.at < 60_000) { if (h.q) fresh[s] = h.q; } else need.push(s); }
      const batches = [];
      for (let i = 0; i < need.length; i += 20) batches.push(need.slice(i, i + 20));
      await Promise.all(batches.map(b => getJson('https://api.nasdaq.com/api/quote/watchlist?' + b.map(s => 'symbol=' + encodeURIComponent(s.replace('-', '.').toLowerCase() + '|stocks')).join('&'), 5000)
        .then(j => { const got = readWatchlist(j); for (const s of b) { ext.set(s, { at: now(), q: got[s] || null }); if (got[s]) fresh[s] = got[s]; } },
          e => log('active: extended-hours quotes failed (' + e.message + ')'))));
      return fresh;
    },
  };
}
