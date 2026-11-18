// Daily closes for a list of symbols, reduced to the numbers the dashboard shows.
// Source 1: Yahoo Finance's public spark feed (batches of 20, worldwide listings).
// Source 2: Nasdaq's public chart feed, one request per symbol, US listings only. Used for
// whatever Yahoo did not return (Yahoo rate-limits busy IP addresses with HTTP 429).
// Moscow listings (".ME") come from the Moscow Exchange itself, see moex.mjs; Yahoo is only
// their fallback. A Yahoo answer whose last close is weeks old (a market it stopped
// following) counts as no answer, so the share is reported missing instead of drawn with
// old prices as if they were today's.
import { isMoex, moexHistory } from './moex.mjs';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BATCH = 20;
const SPARK_POINTS = 60;
const DAY = 86400;

const round = (v, d = 4) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

export function summarise(timestamps, closes, now = Date.now()) {
  const pts = [];
  for (let i = 0; i < (timestamps || []).length; i++) {
    if (closes[i] != null && isFinite(closes[i])) pts.push([timestamps[i], closes[i]]);
  }
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const back = days => {
    const cut = last[0] - days * DAY;
    let older = null;
    for (const p of pts) { if (p[0] <= cut) older = p; else break; }
    if (older) return older[1];
    return pts[0][0] <= cut + 5 * DAY ? pts[0][1] : null;
  };
  const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1) / 1000;
  let ytdBase = null;
  for (const p of pts) { if (p[0] < yearStart) ytdBase = p[1]; else break; }
  const m1Base = back(30), y1Base = back(365);
  const vals = pts.map(p => p[1]);
  const price = last[1];
  let hi = -Infinity, lo = Infinity;
  for (const v of vals) { if (v > hi) hi = v; if (v < lo) lo = v; }
  return {
    p: round(price),
    d: round(price / prev[1] - 1, 5),
    m: m1Base ? round(price / m1Base - 1, 5) : null,
    y: ytdBase ? round(price / ytdBase - 1, 5) : null,
    a: y1Base ? round(price / y1Base - 1, 5) : null,
    hi: round(hi),
    lo: round(lo),
    s: vals.slice(-SPARK_POINTS).map(v => round(v, 3)),
    t: last[0],
  };
}

// Day numbers (days since 1 Jan 1970, UTC) and closes, for the heat map's period slider.
export function series(timestamps, closes) {
  const t = [], c = [];
  for (let i = 0; i < (timestamps || []).length; i++) {
    const v = closes[i];
    if (v == null || !isFinite(v)) continue;
    t.push(Math.floor(timestamps[i] / DAY));
    c.push(round(v, v >= 1 ? 2 : 4));
  }
  return { t, c };
}

// Yahoo has shipped two shapes for this endpoint; accept both.
export function readSpark(json) {
  const out = {};
  const nested = json && json.spark && json.spark.result;
  if (Array.isArray(nested)) {
    for (const r of nested) {
      const resp = r.response && r.response[0];
      if (!resp) continue;
      const q = resp.indicators && resp.indicators.quote && resp.indicators.quote[0];
      out[r.symbol] = { timestamp: resp.timestamp, close: q && q.close };
    }
    return out;
  }
  // fulldayPrice is the latest trade, after-hours and pre-market included.
  for (const [sym, v] of Object.entries(json || {})) {
    if (v && Array.isArray(v.close)) out[sym] = { timestamp: v.timestamp, close: v.close, latest: v.fulldayPrice };
  }
  return out;
}

// The latest trade becomes the price of the latest day. Yahoo leaves that day's close empty
// for hours after the close (Nvidia showed the day before's close as "today"), and a close
// does not move after hours: the dashboard shows the latest price there is.
export function withLatest(raw) {
  const close = (raw.close || []).slice(), latest = +raw.latest;
  if (close.length && latest > 0 && isFinite(latest)) close[close.length - 1] = latest;
  return { timestamp: raw.timestamp, close };
}

export function readNasdaqChart(json) {
  const pts = (json && json.data && json.data.chart) || [];
  const timestamp = [], close = [];
  for (const p of pts) {
    if (p && p.x != null && p.y != null) { timestamp.push(Math.floor(p.x / 1000)); close.push(+p.y); }
  }
  return { timestamp, close };
}

// Yahoo answers HTTP 429 in waves. After one, skip it for a while and go straight to Nasdaq
// instead of paying a failed round trip on every refresh.
const YAHOO_PAUSE_MS = 2 * 60_000;
export const yahooState = { pausedUntil: 0 };

async function yahooBatch(symbols, fetchImpl) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/spark?range=1y&interval=1d&symbols='
    + symbols.map(encodeURIComponent).join(',');
  // No browser User-Agent: in testing Yahoo throttled a spoofed browser string while still
  // answering plain clients.
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) { const e = new Error('yahoo ' + res.status); e.status = res.status; throw e; }
  return readSpark(await res.json());
}

const ymd = d => d.toISOString().slice(0, 10);
async function nasdaqOne(symbol, fetchImpl, now) {
  const to = new Date(now), from = new Date(now - 372 * DAY * 1000);
  const url = 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(symbol) + '/chart?assetclass=stocks&fromdate='
    + ymd(from) + '&todate=' + ymd(to);
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('nasdaq ' + res.status);
  return readNasdaqChart(await res.json());
}

const QUICK_OVER = 40;
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

// Price and today's change for every US stock, from the screener (one ~2 MB request).
export function readScreenerQuotes(json, now = Date.now()) {
  const out = {};
  for (const r of (json && json.data && json.data.rows) || []) {
    const p = num(r.lastsale), pc = num(r.pctchange);
    if (!(p > 0)) continue;
    const sym = String(r.symbol || '').trim().replace('/', '-');
    out[sym] = { p: round(p), d: pc == null ? null : round(pc / 100, 5), m: null, y: null, a: null, hi: round(p), lo: round(p), s: [], t: Math.floor(now / 1000), quick: true };
  }
  return out;
}

async function screenerQuotes(fetchImpl, now) {
  const res = await fetchImpl('https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true', { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('screener ' + res.status);
  return readScreenerQuotes(await res.json(), now);
}

// Runs fn over items with at most `limit` in flight.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (e) { out[i] = { ok: false, error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// onQuote(symbol, quote, history, source) fires as each share arrives, so a caller can show
// early results before the slowest request is back.
export const STALE_DAYS = 14;
export async function fetchPrices(symbols, { fetchImpl = fetch, now = Date.now(), log = () => {}, onQuote = () => {} } = {}) {
  const quotes = {}, history = {}, source = {};
  let old = 0;
  const take = (sym, raw, src) => {
    raw = withLatest(raw);
    const q = summarise(raw.timestamp, raw.close, now);
    if (q && src === 'yahoo' && q.t < now / 1000 - STALE_DAYS * DAY) { old++; return; }
    if (q) { quotes[sym] = q; history[sym] = series(raw.timestamp, raw.close); source[sym] = src; onQuote(sym, q, history[sym], src); }
  };
  // Moscow listings: the exchange's own feed, alongside Yahoo for everything else.
  const moscow = symbols.filter(isMoex);
  const moexDone = moscow.length ? (async () => {
    const t0 = Date.now();
    const got = await pool(moscow, 6, s => moexHistory(s, fetchImpl, now).then(v => { take(s, v, 'moex'); return v; }));
    log('moex: ' + moscow.filter(s => quotes[s]).length + '/' + moscow.length + ' in ' + (Date.now() - t0) + 'ms'
      + (got.some(r => !r.ok) ? ' (' + got.filter(r => !r.ok).length + ' failed: ' + got.find(r => !r.ok).error.message + ')' : ''));
  })() : Promise.resolve();
  let yahooLimited = Date.now() < yahooState.pausedUntil;
  const yahooFirst = symbols.filter(s => !isMoex(s));
  if (!yahooLimited && yahooFirst.length) {
    const batches = [];
    for (let i = 0; i < yahooFirst.length; i += BATCH) batches.push(yahooFirst.slice(i, i + BATCH));
    const t0 = Date.now();
    // At most six requests at once: a whole index is 26 batches, and a burst invites a 429.
    await pool(batches, 6, b => (yahooLimited ? Promise.resolve() : yahooBatch(b, fetchImpl)).then(
      got => { for (const [sym, v] of Object.entries(got || {})) take(sym, v, 'yahoo'); },
      e => { if (e && e.status === 429) yahooLimited = true; }));
    if (yahooLimited) yahooState.pausedUntil = Date.now() + YAHOO_PAUSE_MS;
    log('yahoo: ' + yahooFirst.filter(s => quotes[s]).length + '/' + yahooFirst.length + ' in ' + (Date.now() - t0) + 'ms' + (yahooLimited ? ' (rate limited, pausing 2 min)' : '') + (old ? ' (' + old + ' with prices over ' + STALE_DAYS + ' days old, dropped)' : ''));
  } else if (yahooFirst.length) log('yahoo: paused after a 429, using nasdaq');
  await moexDone;
  // Moscow shares the exchange did not answer for: Yahoo once more (current prices only).
  const moscowLeft = moscow.filter(s => !quotes[s]);
  if (moscowLeft.length && !yahooLimited) {
    await yahooBatch(moscowLeft.slice(0, BATCH), fetchImpl).then(got => { for (const [sym, v] of Object.entries(got || {})) take(sym, v, 'yahoo'); }, () => {});
  }

  // Nasdaq covers US listings only: symbols without an exchange suffix such as ".PA".
  const rest = symbols.filter(s => !quotes[s] && !s.includes('.'));
  // Many shares (a whole index): one screener request gives price and today's move for every
  // US stock at once. The longer-period columns stay empty until Yahoo answers again.
  if (rest.length > QUICK_OVER) {
    const t1 = Date.now();
    try {
      const quick = await screenerQuotes(fetchImpl, now);
      for (const s of rest) if (quick[s]) { quotes[s] = quick[s]; source[s] = 'nasdaq'; onQuote(s, quick[s], null, 'nasdaq'); }
      log('nasdaq screener: ' + rest.filter(s => quick[s]).length + '/' + rest.length + ' in ' + (Date.now() - t1) + 'ms (price and today only)');
    } catch (e) { log('nasdaq screener failed: ' + e.message); }
    return { quotes, history, source, missing: symbols.filter(s => !quotes[s]), yahooLimited };
  }
  if (rest.length) {
    const t1 = Date.now();
    const got = await pool(rest, 12, s => nasdaqOne(s, fetchImpl, now).then(v => { take(s, v, 'nasdaq'); return v; }));
    log('nasdaq: ' + got.filter(r => r.ok).length + '/' + rest.length + ' in ' + (Date.now() - t1) + 'ms');
  }
  return { quotes, history, source, missing: symbols.filter(s => !quotes[s]), yahooLimited };
}
