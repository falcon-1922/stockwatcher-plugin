// "Warren Buffett's portfolio", "Pershing Square holdings", "what does Michael Burry own":
// the latest 13F filing, straight from SEC EDGAR, no key.
//   1. who:   a few famous names map to their fund; anyone else goes to EDGAR's name search
//   2. what:  latest 13F-HR → its information table (positions by CUSIP, value in dollars)
//   3. ticker: OpenFIGI turns CUSIPs into tickers (free, no key); misses fall back to the
//              company name in the local stock list
// A filing never changes and a CUSIP keeps its ticker, so both are cached on disk for good;
// only "which filing is the latest" is re-checked, twice a day. Repeat views are instant.
import { readFileSync } from 'node:fs';
import { saveFile } from './store.mjs';
import { stockOf, lookupHelpers, normalise } from './resolve.mjs';
import { TO_GICS } from './indices.mjs';
import { pool } from './prices.mjs';

const UA = 'stockwatcher-skill/1.0 (local stock dashboard)';
const LATEST_TTL_MS = 12 * 3600_000;
const MAX_POSITIONS = 60;          // the rest is summed up in a note
const FIGI_BATCH = 10;             // OpenFIGI's limit per request without a key

// Words that make a request about an investor's holdings.
export const PORTFOLIO = /\b(portfolios?|holdings?|13f|what does .{2,40}? (own|hold|buy)|stocks? (owned|held) by|positions)\b/i;
export const isPortfolio = q => PORTFOLIO.test(String(q || ''));

// Famous people → the name their fund files under (EDGAR's search finds the fund).
export const INVESTORS = [
  [['warren buffett', 'warren buffet', 'buffett', 'buffet', 'berkshire hathaway', 'berkshire'], 'berkshire hathaway'],
  [['bill ackman', 'ackman', 'pershing square'], 'pershing square'],      // files as Pershing Square Inc. since its 2026 listing
  [['michael burry', 'burry', 'scion'], 'scion asset management'],
  [['ray dalio', 'dalio', 'bridgewater'], 'bridgewater associates'],
  [['cathie wood', 'cathy wood', 'ark invest', 'ark'], 'ark investment management'],
  [['stanley druckenmiller', 'druckenmiller', 'duquesne'], 'duquesne family office'],
  [['david tepper', 'tepper', 'appaloosa'], 'appaloosa'],
  [['dan loeb', 'daniel loeb', 'loeb', 'third point'], 'third point'],
  [['carl icahn', 'icahn'], 'icahn carl'],
  [['david einhorn', 'einhorn', 'greenlight'], 'greenlight capital'],
  [['seth klarman', 'klarman', 'baupost'], 'baupost group'],
  [['li lu', 'himalaya'], 'himalaya capital management'],
  [['george soros', 'soros'], 'soros fund management'],
  [['bill gates', 'gates foundation'], 'gates foundation trust'],
  [['terry smith', 'fundsmith'], 'fundsmith'],
  [['jim simons', 'renaissance technologies', 'renaissance'], 'renaissance technologies'],
  [['chase coleman', 'tiger global'], 'tiger global management'],
  [['philippe laffont', 'coatue'], 'coatue management'],
  [['mohnish pabrai', 'pabrai'], 'dalal street'],
  [['howard marks', 'oaktree'], 'oaktree capital management'],
];

const FILLER = /\b(show|me|the|a|an|of|in|for|latest|current|newest|recent|last|quarter|quarterly|filing|filed|his|her|their|what|does|do|own|owns|hold|holds|buy|buys|bought|stocks?|shares?|owned|held|by|portfolios?|holdings?|13f|positions|is|are|now|today|please|see|display|list|top|biggest|investments?|fund)\b|'s\b|’s\b/gi;

export function whoIn(text) {
  const t = normalise(String(text || '').replace(/[’']s\b/g, ''));
  for (const [names, fund] of INVESTORS) for (const n of names) if (new RegExp('(^| )' + n + '( |$)').test(t)) return { name: n, search: fund };
  const rest = String(text || '').replace(FILLER, ' ').replace(/[^\w&.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return rest.length >= 3 ? { name: rest, search: rest.toLowerCase() } : null;
}

// One 13F information table → positions by CUSIP (options and duplicate manager rows merged).
export function readInfoTable(xml) {
  const by = new Map();
  for (const m of String(xml || '').matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/g)) {
    const g = tag => { const r = new RegExp('<(?:\\w+:)?' + tag + '>([^<]*)<').exec(m[1]); return r ? r[1].trim() : ''; };
    if (g('putCall')) continue;                              // calls and puts are not holdings
    const cusip = g('cusip').toUpperCase();
    const o = by.get(cusip) || { name: g('nameOfIssuer'), cls: g('titleOfClass'), cusip, value: 0, shares: 0 };
    o.value += +g('value') || 0;
    o.shares += +g('sshPrnamt') || 0;
    if (g('sshPrnamtType') && g('sshPrnamtType').toUpperCase() !== 'SH') o.notShares = true;   // a bond's principal, not a share count
    by.set(cusip, o);
  }
  return [...by.values()].sort((a, b) => b.value - a.value);
}

const money = v => v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'tn' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'bn' : '$' + Math.round(v / 1e6) + 'm';
const day = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// Positions + tickers → a dashboard section sized by position value, grouped by sector.
// A filing for a quarter that ended over six months ago is flagged: the fund may have
// stopped filing (closed, or no longer over the $100m threshold).
export function portfolioSection(f, tickers, index, now = Date.now()) {
  const old = now - Date.parse(f.reportDate + 'T00:00:00Z') > 183 * 86400_000;
  const { bySym, findByName } = lookupHelpers(index);
  const total = f.positions.reduce((a, p) => a + p.value, 0);
  const shown = f.positions.slice(0, MAX_POSITIONS);
  const bySector = new Map(), seen = new Set();
  let unknown = 0;
  for (const p of shown) {
    let row = bySym.get(tickers[p.cusip] || '');
    if (!row) row = findByName(p.name.replace(/\b(inc|corp|corporation|co|ltd|limited|plc|holdings?|group|cl [a-c]|com)\b\.?/gi, ' '));
    if (!row) { unknown += p.value; continue; }
    if (seen.has(row[0])) {                                   // two filing lines for one share
      for (const g of bySector.values()) { const s = g.find(x => x.y === row[0]); if (s) { s.held += p.value; s.weight = s.held / total; s.x = money(s.held) + ' · ' + (s.weight * 100).toFixed(1) + '%'; if (s.qty != null) s.qty = p.notShares || !p.shares ? null : s.qty + p.shares; } }
      continue;
    }
    seen.add(row[0]);
    const sector = TO_GICS[row[2]] || 'Other';
    if (!bySector.has(sector)) bySector.set(sector, []);
    // qty: the shares held, so the server can value the position at today's price.
    bySector.get(sector).push({ ...stockOf(row), held: p.value, weight: p.value / total, x: money(p.value) + ' · ' + (p.value / total * 100).toFixed(1) + '%', ...(p.shares > 0 && !p.notShares ? { qty: p.shares } : {}) });
  }
  const sum = l => l.reduce((a, s) => a + s.held, 0);
  const groups = [...bySector.entries()].map(([name, stocks]) => ({ name, note: '', stocks: stocks.sort((a, b) => b.held - a.held) }))
    .sort((a, b) => sum(b.stocks) - sum(a.stocks));
  if (!groups.length) return null;
  const rest = f.positions.length - shown.length;
  return {
    id: 'p' + f.cik, title: f.entity + ' · 13F, ' + day(f.reportDate), sizeBy: 'held', big: f.positions.length > 40,
    stale: old,
    blurb: (old ? 'Old: this is the latest 13F on file, for the quarter to ' + day(f.reportDate) + '; the fund may have stopped filing. ' : '')
      + f.positions.length + ' positions worth ' + money(total) + ', filed ' + day(f.filingDate) + ' (SEC EDGAR). Block size is the position’s value.',
    footnote: 'A 13F lists US-listed long positions only and is filed up to 45 days after the quarter; foreign holdings, shorts and cash are not in it.'
      + (rest > 0 ? ' Showing the ' + shown.length + ' largest positions; ' + rest + ' smaller ones are left out.' : '')
      + (unknown > 0 ? ' ' + money(unknown) + ' could not be matched to a listed share.' : ''),
    groups,
  };
}

// The source itself: get(text, index) → section or null. `fetchImpl` and `file` for tests.
export function createPortfolios({ fetchImpl = fetch, file = null, log = () => {} } = {}) {
  let store = { cusips: {}, filings: {}, latest: {}, who: {} };
  if (file) { try { store = { ...store, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* first run */ } }
  const save = () => { if (file) saveFile(file, JSON.stringify(store), log); };
  const sec = (url, json = true) => fetchImpl(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' } })
    .then(r => { if (!r.ok) throw new Error('SEC answered ' + r.status); return json ? r.json() : r.text(); });

  // Name → [{ cik, entity }] candidates from EDGAR's search, remembered for a week (all of
  // them, so a fund that moves to a new filer is still found).
  async function candidates(search) {
    const hit = store.who[search];
    if (hit && Array.isArray(hit.list) && Date.now() - hit.at < 7 * 86400_000) return hit.list;
    const j = await sec('https://efts.sec.gov/LATEST/search-index?keysTyped=' + encodeURIComponent(search));
    const list = ((j.hits && j.hits.hits) || []).slice(0, 4).map(h => ({ cik: String(h._id).replace(/^0+/, ''), entity: String(h._source.entity || '').replace(/\s*\(.*?\)\s*/g, ' ').trim() }));
    store.who[search] = { at: Date.now(), list };
    return list;
  }

  async function latest(c) {
    const hit = store.latest[c.cik];
    if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.acc ? hit : null;
    const j = await sec('https://data.sec.gov/submissions/CIK' + c.cik.padStart(10, '0') + '.json');
    const r = j.filings.recent, i = r.form.indexOf('13F-HR');
    const entry = i < 0 ? { at: Date.now(), acc: null } : { at: Date.now(), acc: r.accessionNumber[i], reportDate: r.reportDate[i], filingDate: r.filingDate[i], entity: j.name };
    store.latest[c.cik] = entry;
    return entry.acc ? entry : null;
  }

  async function filing(cik, l) {
    if (store.filings[l.acc]) return store.filings[l.acc];
    const base = 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + l.acc.replace(/-/g, '') + '/';
    const files = (await sec(base + 'index.json')).directory.item.map(x => x.name);
    const table = files.find(f => /\.xml$/i.test(f) && !/primary_doc/i.test(f));
    if (!table) throw new Error('no information table in ' + l.acc);
    const positions = readInfoTable(await sec(base + table, false));
    const f = { cik, acc: l.acc, entity: titleCase(l.entity), reportDate: l.reportDate, filingDate: l.filingDate, positions };
    store.filings[l.acc] = f;
    return f;
  }

  async function tickers(positions) {
    const need = positions.slice(0, MAX_POSITIONS).map(p => p.cusip).filter(c => !(c in store.cusips));
    const batches = [];
    for (let i = 0; i < need.length; i += FIGI_BATCH) batches.push(need.slice(i, i + FIGI_BATCH));
    await pool(batches, 3, async b => {
      const res = await fetchImpl('https://api.openfigi.com/v3/mapping', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(b.map(c => ({ idType: 'ID_CUSIP', idValue: c, exchCode: 'US' }))),
      });
      if (!res.ok) throw new Error('OpenFIGI answered ' + res.status);
      (await res.json()).forEach((x, k) => { store.cusips[b[k]] = x.data && x.data[0] ? String(x.data[0].ticker).replace('/', '-') : ''; });
    });
    return store.cusips;
  }

  return async function get(text, index) {
    const who = whoIn(text);
    if (!who) return null;
    const t = Date.now();
    // Check the top matches at once and keep the newest 13F: a fund can move to a new filer
    // (Pershing Square after its listing), and the parent may not file at all.
    const check = async search => (await Promise.all((await candidates(search)).map(c => latest(c).then(l => (l ? { c, l } : null), () => null)))).filter(Boolean);
    const found = await check(who.search);
    // Nothing recent under the full name: the fund may file under a new entity, so also try
    // the first two words ("pershing square capital management" → "pershing square").
    const short = who.search.split(' ').slice(0, 2).join(' ');
    const newest = list => list.reduce((m, x) => (!m || x.l.filingDate > m.l.filingDate ? x : m), null);
    const best0 = newest(found);
    if (short !== who.search && (!best0 || Date.now() - Date.parse(best0.l.reportDate + 'T00:00:00Z') > 183 * 86400_000)) found.push(...await check(short));
    if (!found.length) { save(); return null; }
    const { c, l } = newest(found);
    const f = await filing(c.cik, l);
    const map = await tickers(f.positions);
    save();
    log('13f: ' + f.entity + ' ' + f.reportDate + ', ' + f.positions.length + ' positions in ' + (Date.now() - t) + 'ms');
    return portfolioSection(f, map, index);
  };
}

// "BERKSHIRE HATHAWAY INC" → "Berkshire Hathaway"
export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/[,\s]+(Inc|Llc|L\.?p|Co|Corp|Ltd|Plc|Lp)\.?$/i, '').replace(/\s+/g, ' ').trim();
}
