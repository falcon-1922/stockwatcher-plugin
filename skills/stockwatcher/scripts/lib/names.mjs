// Company names for shares that arrive as bare tickers ("9983.T" in a researched Nikkei list):
// the US list and the built-in indices carry names, everything else is looked up here once and
// kept on disk, since a company's name rarely changes.
// Source 1: Yahoo's chart feed for the share (its longName). Source 2: Yahoo's search, when the
// chart feed is busy or has no name.
import { readFileSync } from 'node:fs';
import { pool } from './prices.mjs';
import { saveFile } from './store.mjs';

const RETRY_MS = 3600_000;   // a share no feed named is asked again after an hour

// "FAST RETAILING CO LTD" → kept only when nothing better comes; trailing legal forms stay, as
// the exchange writes them ("Fast Retailing Co., Ltd.").
export function readChartName(json) {
  const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  return (meta && (meta.longName || meta.shortName) || '').trim() || null;
}
export function readSearchName(json, symbol) {
  const q = ((json && json.quotes) || []).find(x => x && String(x.symbol).toUpperCase() === symbol.toUpperCase());
  return (q && (q.longname || q.shortname) || '').trim() || null;
}

export const unnamed = st => !st.n || st.n === st.y || st.n === st.t;

export function createNames({ fetchImpl = fetch, log = () => {}, file = null } = {}) {
  let names = {};
  if (file) { try { names = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ } }
  const failed = new Map(), inflight = new Map();
  let saveTimer = null;
  const save = () => {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveFile(file, JSON.stringify(names), log); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  };
  const get = async url => {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('yahoo ' + res.status);
    return res.json();
  };
  async function one(sym) {
    let name = null;
    try { name = readChartName(await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=1d')); } catch { /* try search */ }
    if (!name) {
      try { name = readSearchName(await get('https://query2.finance.yahoo.com/v1/finance/search?quotesCount=3&newsCount=0&q=' + encodeURIComponent(sym)), sym); } catch { /* none */ }
    }
    if (name) { names[sym] = name; save(); } else failed.set(sym, Date.now());
    return name;
  }

  // Looks up the names not known yet; resolves when all are back.
  function fill(symbols) {
    const now = Date.now();
    const need = [...new Set(symbols)].filter(s => !names[s] && !inflight.has(s) && !(now - (failed.get(s) || 0) < RETRY_MS));
    if (need.length) {
      const t0 = Date.now();
      const p = pool(need, 6, one).then(r => log('names: ' + r.filter(x => x.ok && x.value).length + '/' + need.length + ' in ' + (Date.now() - t0) + 'ms'))
        .finally(() => { for (const s of need) inflight.delete(s); });
      for (const s of need) inflight.set(s, p);
    }
    return Promise.all([...new Set(symbols.map(s => inflight.get(s)).filter(Boolean))]);
  }

  // Puts known names on the shares in these sections; returns the symbols still unnamed.
  function apply(sections) {
    const left = [];
    for (const sec of sections) for (const g of sec.groups) for (const st of g.stocks) {
      if (!unnamed(st)) continue;
      if (names[st.y]) st.n = names[st.y]; else left.push(st.y);
    }
    return left;
  }
  const pending = symbols => symbols.some(s => inflight.has(s));

  return { fill, apply, pending, names: () => names };
}
