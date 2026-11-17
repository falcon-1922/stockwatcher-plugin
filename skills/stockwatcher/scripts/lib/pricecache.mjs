// Prices per symbol, kept in memory and on disk.
// - get(symbols, budgetMs) answers within the budget with whatever it has: fresh numbers,
//   older numbers (marked stale, refreshed in the background) and a list still pending.
// - Two requests for the same symbol share one fetch.
// - Symbols that returned nothing are remembered for a minute, so they are not re-asked
//   on every refresh.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchPrices } from './prices.mjs';

const MAX_SAVED = 800;
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

export function createPriceCache({ fetchImpl = fetch, log = () => {}, freshMs = 60_000, file = null, fetchPricesImpl = fetchPrices } = {}) {
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
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(keep)));
      renameSync(file + '.tmp', file);
    } catch (e) { log('price cache not saved: ' + e.message); }
  }
  // Writes are batched for a second; call flush() before the process exits.
  function save() {
    dirty = true;
    if (!file || saveTimer) return;
    saveTimer = setTimeout(flush, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  const isFresh = (e, now) => e && now - e.at < freshMs;

  // Starts fetching whatever is missing or old; returns a promise for all of it.
  function refresh(symbols) {
    const now = Date.now();
    const need = symbols.filter(s => !inflight.has(s) && !isFresh(entries.get(s), now));
    if (need.length) {
      const p = fetchPricesImpl(need, {
        fetchImpl, log,
        onQuote: (s, q, h, src) => { entries.set(s, { at: Date.now(), q, h, src }); save(); },
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
