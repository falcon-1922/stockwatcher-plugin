// Live quotes from Yahoo's quote feed: the latest regular-session price, today's change,
// the previous close, the market value (in US dollars), and the latest extended-hours trade,
// for up to 50 shares per request on any exchange Yahoo covers.
//
// The feed wants a session: a cookie from fc.yahoo.com and a "crumb" read with it. Both are
// kept for hours and fetched again when Yahoo refuses them (401/403). Foreign market values
// are turned into dollars with Yahoo's own exchange rates (EURUSD=X …), read in the same way.
// A short User-Agent: Yahoo answered 429 to the full browser string and 200 to this.
const UA = 'Mozilla/5.0';

const BATCH = 50;
const FRESH_MS = 60_000;
const SESSION_MS = 6 * 3600_000;
// Quotes in minor units: pence (GBp), South African cents (ZAc), Israeli agorot (ILA); their
// market values are in the major unit (pounds, rand, shekels).
const MINOR = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

export function readQuotes(json) {
  const out = {};
  for (const r of (json && json.quoteResponse && json.quoteResponse.result) || []) {
    if (!r || !r.symbol || !(r.regularMarketPrice > 0)) continue;
    const ext = r.postMarketPrice > 0 && r.postMarketTime > (r.regularMarketTime || 0) ? { p: r.postMarketPrice, at: r.postMarketTime, s: 'after' }
      : r.preMarketPrice > 0 && r.preMarketTime > (r.regularMarketTime || 0) ? { p: r.preMarketPrice, at: r.preMarketTime, s: 'pre' } : null;
    out[r.symbol] = {
      p: r.regularMarketPrice,
      prev: r.regularMarketPreviousClose > 0 ? r.regularMarketPreviousClose : null,
      d: r.regularMarketChangePercent != null && isFinite(r.regularMarketChangePercent) ? r.regularMarketChangePercent / 100 : null,
      at: r.regularMarketTime || 0,
      cap: r.marketCap > 0 ? r.marketCap : null,
      cur: r.currency || '',
      fcur: r.financialCurrency || '',
      ext,
    };
  }
  return out;
}

export function createYQuote({ fetchImpl = fetch, log = () => {}, now = () => Date.now() } = {}) {
  let session = null, sessionAt = 0, sessionRun = null;
  const cache = new Map();   // symbol → { at, q }
  const fx = new Map();      // currency → { at, usd }
  let pausedUntil = 0;

  async function newSession() {
    const r = await fetchImpl('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) }).catch(() => null);
    const set = r && (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
    const cookie = (set || []).map(c => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error('no Yahoo cookie');
    const c = await fetchImpl('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(8000) });
    const crumb = c.ok ? (await c.text()).trim() : '';
    if (!crumb || crumb.length > 40 || /[<{ ]/.test(crumb)) throw new Error('no Yahoo crumb (' + c.status + ')');
    return { cookie, crumb };
  }
  async function getSession(force = false) {
    if (session && !force && now() - sessionAt < SESSION_MS) return session;
    sessionRun = sessionRun || newSession().then(s => { session = s; sessionAt = now(); return s; }).finally(() => { sessionRun = null; });
    return sessionRun;
  }

  async function batch(symbols) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await getSession(attempt > 0);
      const url = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + symbols.map(encodeURIComponent).join(',') + '&crumb=' + encodeURIComponent(s.crumb);
      const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Cookie: s.cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (r.status === 401 || r.status === 403) continue;
      if (r.status === 429) { pausedUntil = now() + 60_000; throw new Error('yahoo quote 429'); }
      if (!r.ok) throw new Error('yahoo quote ' + r.status);
      return readQuotes(await r.json());
    }
    throw new Error('Yahoo refused the session');
  }

  // Dollars per one unit of each currency (USD itself is 1).
  async function rates(currencies) {
    const need = [...new Set(currencies)].filter(c => c && c !== 'USD' && !(fx.has(c) && now() - fx.get(c).at < 10 * FRESH_MS));
    if (need.length) {
      const got = await batch(need.map(c => c + 'USD=X'));
      for (const c of need) { const q = got[c + 'USD=X']; if (q && q.p > 0) fx.set(c, { at: now(), usd: q.p }); }
    }
    return c => (c === 'USD' ? 1 : fx.has(c) ? fx.get(c).usd : null);
  }

  // symbol → { p, d, prev, at, cap (USD), cur, ext }; what fails is left out. Never throws.
  async function get(symbols) {
    const out = {}, need = [];
    for (const sym of new Set(symbols)) {
      const h = cache.get(sym);
      if (h && now() - h.at < FRESH_MS) { if (h.q) out[sym] = h.q; } else need.push(sym);
    }
    if (need.length && now() >= pausedUntil) {
      const batches = [];
      for (let i = 0; i < need.length; i += BATCH) batches.push(need.slice(i, i + BATCH));
      const got = {};
      await Promise.all(batches.map(b => batch(b).then(r => Object.assign(got, r), e => log('yahoo quotes failed: ' + e.message))));
      // Market values: Yahoo gives them in the major unit of the quote currency; into dollars.
      const cur = q => (MINOR[q.cur] ? MINOR[q.cur][0] : q.cur);
      let usd = () => null;
      try { usd = await rates(Object.values(got).filter(q => q.cap).map(cur)); } catch (e) { log('yahoo exchange rates failed: ' + e.message); }
      for (const sym of need) {
        const q = got[sym];
        if (q) {
          // The price is in pence for London, but Yahoo's market value there is in pounds.
          const rate = usd(cur(q));
          q.cap = q.cap && rate ? Math.round(q.cap * rate) : null;
          out[sym] = q;
        }
        cache.set(sym, { at: now(), q: q || null });
      }
    }
    return out;
  }

  return { get };
}
