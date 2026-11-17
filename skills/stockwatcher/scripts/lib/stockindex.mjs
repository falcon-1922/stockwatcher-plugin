// The list of US-listed stocks with sector, industry and market value, from Nasdaq's public
// screener (one request, about 7,000 rows). Rows are kept compact:
//   [symbol, name, sector, industry, marketCapUSD, country]
// A snapshot ships with the skill (data/index.json.gz) so the first start needs no network;
// a newer copy is fetched in the background once a day and kept in the cache folder.
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { UA } from './prices.mjs';

const DAY_MS = 86_400_000;

export function readSnapshot(path) {
  const buf = readFileSync(path);
  const json = JSON.parse((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
  return Array.isArray(json) ? { at: statSync(path).mtimeMs, rows: json } : json; // { at, rows }
}

export function writeSnapshot(path, snap) {
  mkdirSync(dirname(path), { recursive: true });
  const body = Buffer.from(JSON.stringify(snap));
  writeFileSync(path + '.tmp', path.endsWith('.gz') ? gzipSync(body, { level: 9 }) : body);
  renameSync(path + '.tmp', path);
}

// Returns { rows(), at(), refresh() }. Never blocks on the network: the newest of the cached
// and the bundled snapshot is used straight away.
export function loadIndex({ bundledPath, cachePath, fetchImpl = fetch, log = () => {}, maxAgeMs = DAY_MS, autoRefresh = true }) {
  let snap = null;
  for (const p of [cachePath, bundledPath]) {
    if (!p) continue;
    try { const s = readSnapshot(p); if (!snap || s.at > snap.at) snap = s; } catch { /* missing */ }
  }
  if (!snap) snap = { at: 0, rows: [] };
  log('index: ' + snap.rows.length + ' stocks, ' + Math.round((Date.now() - snap.at) / 3600000) + 'h old');
  let running = null;
  const refresh = () => running || (running = fetchIndex(fetchImpl).then(rows => {
    snap = { at: Date.now(), rows };
    if (cachePath) writeSnapshot(cachePath, snap);
    log('index refreshed: ' + rows.length + ' stocks');
    return snap;
  }, e => { log('index refresh failed, keeping the old one: ' + e.message); return snap; }).finally(() => { running = null; }));
  if (autoRefresh && Date.now() - snap.at > maxAgeMs) refresh();
  return { rows: () => snap.rows, at: () => snap.at, refresh, ready: () => (snap.rows.length ? Promise.resolve(snap) : refresh()) };
}

export const SCREENER_URL = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true';

// Warrants, units, rights, preferreds and blank-cheque shells are not what people mean by "stocks".
// Every pattern ends on a word boundary: "\bunits?" alone would also drop "UnitedHealth".
const NOT_A_SHARE = [
  /\bwarrants?\b/i, /\bpreferred\b/i, /\bnotes?\b.*\bdue\b/i, /\bsubordinated\b/i, /\bdebentures?\b/i,
  /\brights?\s*$/i, /(?<!partnership)\s+units\s*$/i, /\bacquisition corp/i,
];
const NAME_TAIL = /\s+(common stock|common shares?|ordinary shares?|class [a-c]\b|capital stock|american depositary|depositary|ads\b|new\b|sponsored|share[s]? of beneficial|limited partnership units).*$/i;

export function cleanName(name) {
  return String(name || '').replace(NAME_TAIL, '').replace(/\s+/g, ' ').trim()
    .replace(/,?\s*(&\s*Co\.?|Inc\.?|Corporation|Corp\.?|Incorporated|Ltd\.?|Limited|plc|N\.V\.|S\.A\.(B\. de C\.V\.)?|Holdings?|Co\.?)$/i, '').trim();
}

export function compactRows(rows) {
  const out = [];
  for (const r of rows || []) {
    // Nasdaq writes share classes as "BRK/B"; Yahoo and most people write "BRK-B".
    const sym = String(r.symbol || '').trim().replace('/', '-');
    if (!sym || /[\^ /]/.test(sym)) continue;
    const industry = String(r.industry || '').trim();
    const sector = String(r.sector || '').trim(); // blank for a few large names (Berkshire): kept, found by name or ticker
    if (industry === 'Blank Checks' || NOT_A_SHARE.some(re => re.test(r.name || ''))) continue;
    const cap = Math.round(+String(r.marketCap || '0').replace(/[^0-9.]/g, '')) || 0;
    if (!cap) continue;
    out.push([sym, cleanName(r.name), sector, industry, cap, String(r.country || '').trim()]);
  }
  out.sort((a, b) => b[4] - a[4]);
  return out;
}

export async function fetchIndex(fetchImpl = fetch) {
  const res = await fetchImpl(SCREENER_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('nasdaq screener answered ' + res.status);
  const j = await res.json();
  const rows = compactRows(j && j.data && j.data.rows);
  if (rows.length < 1000) throw new Error('nasdaq screener returned only ' + rows.length + ' rows');
  return rows;
}
