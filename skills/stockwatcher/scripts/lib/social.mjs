// "What is r/wallstreetbets talking about": the 100 most-mentioned shares, shown like an index
// (grouped by sector, block size = market value, mentions next to each name).
//
// Sources, both read-only:
// - ApeWisdom's public API: mentions per ticker on r/wallstreetbets over the last 24 hours.
//   No key. Used for "wallstreetbets", "wsb", and for a thread link when Reddit is not set up.
// - Reddit's own API, only when REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set (a free
//   "script" app at reddit.com/prefs/apps): counts tickers in the comments of a specific
//   thread. Reddit refuses anonymous API requests, so there is no way around the credentials.
import { stockOf } from './resolve.mjs';
import { TO_GICS } from './indices.mjs';

const UA = 'stockwatcher-skill/1.0 (local stock dashboard)';
const TTL_MS = 10 * 60_000;
export const TOP = 100;

export const SOCIAL = /\b(wall\s*street\s*bets|wallstreetbets|wsb|reddit)\b|reddit\.com\/r\/\w+/i;
export const isSocial = q => SOCIAL.test(String(q || ''));
export const threadId = q => { const m = /reddit\.com\/r\/\w+\/comments\/([a-z0-9]+)/i.exec(String(q || '')); return m ? m[1] : null; };

// Tickers that are also everyday words or trading slang: "DTE" is days-to-expiry, not DTE
// Energy; "IT", "ON", "ALL" are words. Counted only when written as $IT, $ON...
export const NOT_TICKERS = new Set(('A AI ALL AM AN ANY ARE AT BE BIG BEST BIT BRO BUY CAN CASH CEO CFO CPI DD DTE EOD EPS ET ETF EV '
  + 'FAST FED FOR FUN GDP GO GOOD HAS HE HOLD HOPE IMO IPO IT ITM IV JUST LOL LOVE LOW MAIN MOON NEW NEXT NICE NOW OI OLD ON ONE OPEN '
  + 'OR OTM OUT PM PLAY PUMP REAL RH RUN SEC SEE SO TA TOO TRUE TWO USA VERY WELL WANT WSB YOLO').split(' '));

// Mentions → a dashboard section: real stocks only (in the stock list, so they have a market
// value), the top 100 by mentions, one line per company, grouped by sector, biggest first.
export function mentionsSection(counts, index, { id = 'wsb', title, blurb }) {
  const bySym = new Map(index.map(r => [r[0], r]));
  const names = new Set(), picked = [];
  for (const [sym, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const row = bySym.get(sym);
    if (!row || NOT_TICKERS.has(sym)) continue;
    const key = row[1].toLowerCase();
    if (names.has(key)) continue;              // GOOG and GOOGL are one company
    names.add(key);
    picked.push([row, n]);
    if (picked.length === TOP) break;
  }
  const bySector = new Map();
  for (const [row, n] of picked) {
    const sector = TO_GICS[row[2]] || 'Other';
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push({ ...stockOf(row), x: n.toLocaleString('en-US') + ' mentions', mentions: n });
  }
  const cap = l => l.reduce((a, s) => a + (s.cap || 0), 0);
  const groups = [...bySector.entries()].map(([name, stocks]) => ({ name, note: '', stocks: stocks.sort((a, b) => b.cap - a.cap) }))
    .sort((a, b) => cap(b.stocks) - cap(a.stocks));
  return groups.length ? { id, title, blurb, groups, big: true } : null;
}

// Tickers in free text: "$NVDA" always; "NVDA" in capitals when it is a listed stock and not
// an everyday word. Each comment counts a ticker once.
export function tickersIn(text, known) {
  const found = new Set();
  for (const m of String(text || '').matchAll(/(\$)?\b([A-Z]{1,5})\b/g)) {
    const sym = m[2];
    if (!known.has(sym)) continue;
    if (m[1] || (sym.length >= 2 && !NOT_TICKERS.has(sym))) found.add(sym);
  }
  return found;
}

async function apeWisdom(fetchImpl, pages = 3) {
  const got = await Promise.all(Array.from({ length: pages }, (_, i) =>
    fetchImpl('https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/' + (i + 1), { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null), () => null)));
  const counts = new Map();
  for (const p of got) for (const r of (p && p.results) || []) counts.set(String(r.ticker).toUpperCase().replace('.', '-'), +r.mentions || 0);
  if (!counts.size) throw new Error('ApeWisdom did not answer');
  return counts;
}

async function redditThread(id, known, fetchImpl, env) {
  const auth = Buffer.from(env.REDDIT_CLIENT_ID + ':' + env.REDDIT_CLIENT_SECRET).toString('base64');
  const tok = await fetchImpl('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
  }).then(r => r.json());
  if (!tok || !tok.access_token) throw new Error('Reddit refused the app credentials');
  const res = await fetchImpl('https://oauth.reddit.com/comments/' + id + '?limit=500&sort=top&depth=10', { headers: { Authorization: 'Bearer ' + tok.access_token, 'User-Agent': UA } });
  if (!res.ok) throw new Error('Reddit answered ' + res.status);
  const [postListing, comments] = await res.json();
  const post = postListing.data.children[0].data;
  const counts = new Map();
  let read = 0;
  const walk = list => {
    for (const c of list || []) {
      if (c.kind !== 't1') continue;
      read++;
      for (const s of tickersIn(c.data.body, known)) counts.set(s, (counts.get(s) || 0) + 1);
      walk(c.data.replies && c.data.replies.data && c.data.replies.data.children);
    }
  };
  walk(comments.data.children);
  return { counts, title: post.title, read, total: post.num_comments };
}

// Returns get(query, index) → { section, note } with answers cached for ten minutes.
export function createSocial({ fetchImpl = fetch, env = process.env, log = () => {} } = {}) {
  const cache = new Map(), inflight = new Map();
  async function load(key, index, q) {
    const id = threadId(q);
    const known = new Set(index.map(r => r[0]));
    if (id && env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
      const t = await redditThread(id, known, fetchImpl, env);
      log('reddit: thread ' + id + ', ' + t.read + ' of ' + t.total + ' comments read');
      return { section: mentionsSection(t.counts, index, {
        title: 'Thread: top ' + TOP + ' mentioned', blurb: 'Shares mentioned in “' + t.title + '” (' + t.read + ' of ' + t.total + ' comments read, top comments first), grouped by sector; block size is market value.' }), note: '' };
    }
    const counts = await apeWisdom(fetchImpl);
    log('apewisdom: ' + counts.size + ' tickers');
    return {
      section: mentionsSection(counts, index, {
        title: 'r/wallstreetbets: top ' + TOP + ' mentioned',
        blurb: 'The most-mentioned shares on r/wallstreetbets over the last 24 hours (ApeWisdom), grouped by sector; block size is market value. Funds and words like “DTE” or “IT” are left out.' }),
      note: id ? 'Counting this exact thread needs a free Reddit app (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET); showing the whole subreddit over the last 24 hours instead.' : '',
    };
  }
  return async function get(q, index) {
    const key = threadId(q) || 'wsb';
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    if (!inflight.has(key)) inflight.set(key, load(key, index, q).then(value => { cache.set(key, { at: Date.now(), value }); return value; }).finally(() => inflight.delete(key)));
    return inflight.get(key);
  };
}
