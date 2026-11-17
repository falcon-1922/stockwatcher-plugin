// Prices per symbol, kept in memory and on disk.
// - get(symbols, budgetMs) answers within the budget with whatever it has: fresh numbers,
//   older numbers (marked stale, refreshed in the background) and a list still pending.
// - Two requests for the same symbol share one fetch.
// - Symbols that returned nothing are remembered for a minute, so they are not re-asked
//   on every refresh.
// - A price that came back unchanged (market closed, or a share that rarely trades) is asked
//   for again after ten minutes instead of one: nights and weekends cost a tenth of the requests.
import { readFileSync } from 'node:fs';
import { fetchPrices } from './prices.mjs';
import { saveFile } from './store.mjs';

const MAX_SAVED = 800;
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

export function createPriceCache({ fetchImpl = fetch, log = () => {}, freshMs = 60_000, quietMs = 10 * freshMs, saveMs = 15_000, file = null, fetchPricesImpl = fetchPrices } = {}) {
  const entries = new Map();   // symbol → { at, q, h, src }   (q null = feed had nothing)
  const inflight = new Map();  // symbol → promise
  let saveTimer = null;

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [s, e] of Object.entries(saved)) if (e && e.q) entries.set(s, e);
      log('price cache: ' + entries.size + ' symbols from disk');
    } catch { /* first run */ }
  }

  let dirty = false;
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!file || !dirty) return;
    dirty = false;
    const keep = [...entries.entries()].filter(([, e]) => e.q).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SAVED);
    saveFile(file, JSON.stringify(Object.fromEntries(keep)), log);
  }
  // The file is about 2 MB with a whole index in it: written at most every 15 seconds; call
  // flush() before the process exits.
  function save() {
    dirty = true;
    if (!file || saveTimer) return;
    saveTimer = setTimeout(flush, saveMs);
    if (saveTimer.unref) saveTimer.unref();
  }

  const isFresh = (e, now) => e && now - e.at < (e.quiet ? quietMs : freshMs);

  // Starts fetching whatever is missing or old; returns a promise for all of it.
  function refresh(symbols) {
    const now = Date.now();
    const need = symbols.filter(s => !inflight.has(s) && !isFresh(entries.get(s), now));
    if (need.length) {
      const p = fetchPricesImpl(need, {
        fetchImpl, log,
        onQuote: (s, q, h, src) => {
          const old = entries.get(s);
          const quiet = !!(old && old.q && old.q.p === q.p && old.q.d === q.d);   // not moving
          entries.set(s, { at: Date.now(), q, h: h || (old && old.h) || null, src, ...(quiet ? { quiet } : {}) });
          save();
        },
      }).then(r => {
        const at = Date.now();
        for (const s of need) if (!r.quotes[s]) { const old = entries.get(s); entries.set(s, old && old.q ? { ...old, failedAt: at } : { at, q: null }); }
      }, e => log('price fetch failed: ' + (e && e.message))).finally(() => { for (const s of need) if (inflight.get(s) === p) inflight.delete(s); });
      for (const s of need) inflight.set(s, p);
    }
    return Promise.all([...new Set(symbols.map(s => inflight.get(s)).filter(Boolean))]);
  }

  async function get(symbols, budgetMs = 1200) {
    const done = refresh(symbols);
    await Promise.race([done, sleep(budgetMs)]);
    const now = Date.now();
    const quotes = {}, history = {}, source = {}, stale = [], pending = [], missing = [];
    for (const s of symbols) {
      const e = entries.get(s);
      if (e && e.q) {
        quotes[s] = e.q; history[s] = e.h; source[s] = e.src;
        if (!isFresh(e, now) || e.failedAt) stale.push(s);
      } else if (inflight.has(s)) pending.push(s);
      else missing.push(s);
    }
    return { quotes, history, source, stale, pending, missing };
  }

  return { get, refresh, flush, entries };
}
