// A small local web server: the dashboard page plus JSON endpoints. The person steers it from
// the chat: each run of the command calls /api/show, and every open page switches to the new
// view at once (server-sent events), so no new tab is needed.
// Windows: every page belongs to a named window ("main" unless the URL says ?w=w2). A request
// changes one window; "in a new window" makes a new name and opens a tab for it.
//   GET /                         the page
//   GET /api/show?q=...&w=...     make this the window's view; returns what matched, what needs
//                                 research in the chat, and how many pages show that window
//   GET /api/window/new           a fresh window name { w }
//   GET /api/current?w=...        the window's view { q }
//   GET /api/events?w=...         event stream: { q } whenever the window's view changes
//   GET /api/dashboard?q=...      sections + prices; answers within ~1.2 s with what is ready
//                                 and lists the rest as `pending` (the page asks again)
//   GET /api/history?q=...        a year of daily closes per share (heat-map slider)
//   GET /api/vocab                themes and sector words, for the example prompts
//   GET /api/promo                who made this, and the one-line pointers the page rotates
//   GET /api/health               { app: 'stockwatcher', version, pid }
//   GET /api/stop                 shuts the server down
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, symbolsOf, vocabulary, splitQuery, isTitledList } from './resolve.mjs';
import { isPortfolio } from './portfolio.mjs';
import { similarity } from './memory.mjs';
import { parseMine, parseItems, applyChange, mineSection, sayOf } from './mine.mjs';
import { saveFile } from './store.mjs';
import { VERSION } from './home.mjs';
import { ABOUT } from './promo.mjs';
import { createPriceCache } from './pricecache.mjs';
import { splitResearch } from './research.mjs';
import { isSocial } from './social.mjs';
import { isActive, isExtended, stripMarketWords, sessionAt } from './active.mjs';

export { VERSION };

const SESSION_NOTE = {
  after: 'After-hours prices: the "Today" colours show the move from the 4 pm close to the latest after-hours trade (Nasdaq; after-hours trading runs 16:00–20:00 New York time).',
  pre: 'Pre-market prices: the "Today" colours show the move from the last close to the latest pre-market trade (Nasdaq; pre-market trading runs 4:00–9:30 New York time).',
  regular: 'The regular session is open now (9:30–16:00 New York time), so these are regular prices; after-hours trading starts at 16:00.',
  closed: 'Trading is closed now; the "Today" colours show the last extended-hours trade against the last regular close (Nasdaq).',
};
const SESSION_WORD = { after: 'after hours', pre: 'pre-market', closed: 'outside regular hours' };

// "now add the banks", "also show tesla", "plus gold miners too": added to what the window
// already shows instead of replacing it.
const ADD = /^\s*(?:(?:now|please|and|ok|okay|then)[,\s]+)*(?:add|also\s+(?:show|add|include)|also|plus|include)\s+(.+?)(?:[,\s]+(?:too|as well|also))?\s*[.!]?\s*$/i;
export function withAdded(q, previous) {
  const m = ADD.exec(String(q || ''));
  if (!m || !previous || parseMine(q)) return q;   // "add 5 TSLA to my portfolio" changes the portfolio
  const extra = m[1].replace(/\s+to\s+(?:it|this|the\s+(?:dashboard|view|page|list))$/i, '').trim();
  return extra ? previous + '; ' + extra : q;
}

// A researched list whose shares have no size here would be drawn with equal tiles, which
// misleads. The chat is told, in the list's own format, what to add. liveCaps: shares the live
// quote feed has a market value for (any exchange Yahoo covers); those need no research.
export function missingSizes(sections, liveCaps = new Set()) {
  const out = [];
  for (const sec of sections) {
    if (sec.sizeBy && sec.sizeBy !== 'indexWeight') continue;
    const byWeight = sec.sizeBy === 'indexWeight';
    const all = sec.groups.flatMap(g => g.stocks);
    const bare = all.filter(st => !(byWeight ? st.indexWeight > 0 : st.cap > 0 || liveCaps.has(st.y)));
    if (!bare.length) continue;
    const a = bare[0].y, b = (bare[1] || bare[0]).y;
    out.push('SIZES MISSING: ' + bare.length + ' of ' + all.length + ' shares in "' + sec.title + '" have no ' + (byWeight ? 'index weight' : 'market value')
      + ' (' + bare.slice(0, 8).map(st => st.y).join(', ') + (bare.length > 8 ? ', …' : '') + '), so their tiles are all drawn the same size and the map is misleading.'
      + ' Before replying, look up each share\'s index weight (for an index: from the index provider or a constituents table) or else its market value in US dollars,'
      + ' and run the command again with the size after every ticker, for example "' + sec.title + ': ' + a + ' 9.8%, ' + b + ' 4.2%, …" or "' + sec.title + ': ' + a + ' 160bn, …" (no $ sign: inside double quotes the shell deletes it).'
      + ' No thousands separators. Keep the same --how and --source.');
  }
  return out;
}

// Shares no feed has a current price for are drawn grey. The chat is told which, so it can
// check the symbols and say so instead of presenting a grey map as live.
export function missingPrices(sections, p) {
  if (!p || !p.missing || !p.missing.length) return [];
  const all = symbolsOf(sections), gone = p.missing.filter(s => all.includes(s));
  if (!gone.length) return [];
  return ['PRICES MISSING: no current price for ' + gone.length + ' of ' + all.length + ' shares (' + gone.slice(0, 10).join(', ') + (gone.length > 10 ? ', …' : '') + '), so their tiles are grey.'
    + ' The feeds tried: Yahoo Finance worldwide, Nasdaq for US listings, the Moscow Exchange for ".ME" listings; a Yahoo price weeks old counts as none.'
    + ' Check each symbol: the Yahoo form with the exchange suffix (SAP.DE, 7203.T), a renamed or merged company, or a share that is delisted or suspended.'
    + ' If a share has a current listing elsewhere (another exchange suffix, its US ADR), run the command again with that symbol; otherwise tell the person which shares have no price and why.'];
}

export function summarise(sections, unmatched, research, notes = []) {
  return {
    sections: sections.map(s => {
      const all = s.groups.flatMap(g => g.stocks);
      // A short list is named share by share, so the reply can say "Toyota, Sony and SoftBank".
      return { id: s.id, title: s.title, count: all.length, groups: s.groups.map(g => g.name), ...(all.length <= 10 ? { shares: all.map(st => (st.n && st.n !== st.y ? st.n + ' (' + st.y + ')' : st.y)) } : {}), ...(s.sizeBy === 'held' ? { about: s.blurb } : {}) };
    }),
    total: symbolsOf(sections).length,
    unmatched, research, notes,
  };
}

// `social` (optional): (query, indexRows) → { section, note }, see social.mjs.
// `portfolios` (optional): (text, indexRows) → section | null, see portfolio.mjs.
// `viewsFile` (optional): where each window's current view is kept, so the short dashboard
// link (http://127.0.0.1:4317/?w=w2) still shows it after a restart.
// `memory` (optional): research memory, saved portfolios and usual requests, see memory.mjs.
// `promo` (optional): the maker's one-line pointers, see promo.mjs.
// `active` (optional): most active shares and extended-hours prices, see active.mjs.
// `moex` (optional): the Moscow Exchange's index weights and market values, see moex.mjs.
// `themesAt` (optional): changes when a theme was updated in place (the index's daily weights).
// `names` (optional): company names for bare tickers, see names.mjs.
// Tile sizes that move with the prices, on a copy (the sections are cached and shared):
// - index weights published on a known day (weightsDate, the DAX): each weight × price now ÷
//   close that day, scaled back to the same total, as the index itself drifts between reviews;
// - a 13F position with its share count (qty): shares × price now, instead of the value on the
//   quarter's last day.
const dayNo = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400_000);
function closeOn(h, day) {
  if (!h || !h.t) return null;
  let c = null;
  for (let i = 0; i < h.t.length; i++) { if (h.t[i] <= day) c = h.c[i]; else break; }
  return c;
}
export function liveSizes(sections, quotes, history) {
  const money = v => (v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'tn' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'bn' : '$' + Math.round(v / 1e6) + 'm');   // as in portfolio.mjs
  return sections.map(sec => {
    if (sec.sizeBy === 'indexWeight' && sec.weightsDate) {
      const day = dayNo(sec.weightsDate);
      const all = sec.groups.flatMap(g => g.stocks);
      const before = all.reduce((a, st) => a + (st.indexWeight || 0), 0);
      const moved = new Map();
      for (const st of all) {
        const q = quotes[st.y], base = closeOn(history[st.y], day);
        const price = q && (q.close != null ? q.close : q.p);
        moved.set(st, st.indexWeight > 0 && price > 0 && base > 0 ? st.indexWeight * price / base : st.indexWeight || 0);
      }
      const after = [...moved.values()].reduce((a, v) => a + v, 0);
      if (!(after > 0)) return sec;
      return { ...sec, groups: sec.groups.map(g => ({ ...g, stocks: g.stocks.map(st => ({ ...st, indexWeight: +(moved.get(st) * before / after).toFixed(3) })) })) };
    }
    if (sec.sizeBy === 'held' && sec.groups.some(g => g.stocks.some(st => st.qty > 0))) {
      const value = st => { const q = quotes[st.y], price = q && (q.close != null ? q.close : q.p); return st.qty > 0 && price > 0 ? st.qty * price : st.held; };
      const total = sec.groups.reduce((a, g) => a + g.stocks.reduce((b, st) => b + value(st), 0), 0);
      return { ...sec, groups: sec.groups.map(g => ({ ...g, stocks: g.stocks.map(st => { const v = value(st); return { ...st, held: Math.round(v), weight: v / total, x: money(v) + ' · ' + (v / total * 100).toFixed(1) + '%' }; }) })) };
    }
    return sec;
  });
}

export function createServer({ pagePath, index, themes, prices = createPriceCache(), social = null, portfolios = null, memory = null, promo = null, active = null, moex = null, names = null, live = null, themesAt = () => 0, viewsFile = null, budgetMs = 1200, log = () => {}, onStop = () => {}, onActivity = () => {} }) {
  const resolved = new Map(); // query → { at, result }   (the index changes once a day at most)
  const vocab = vocabulary(themes);
  const views = new Map([['main', { q: '', at: 0 }]]);   // window name → its current view
  if (viewsFile) { try { for (const [w, v] of Object.entries(JSON.parse(readFileSync(viewsFile, 'utf8')))) views.set(w, v); } catch { /* first run */ } }
  const saveViews = () => { if (viewsFile) saveFile(viewsFile, JSON.stringify(Object.fromEntries([...views].filter(([, v]) => v.q).slice(-50))), log); };
  // What the person asks for most, for the page's buttons (their saved portfolio first).
  const usual = () => (memory ? memory.frequent(4).map(e => e.q) : []);
  const viewers = new Map();   // open event stream → window name, one per open page
  let windowCount = 1;
  const windowOf = url => { const w = url.searchParams.get('w') || 'main'; return /^[a-z0-9-]{1,20}$/i.test(w) ? w : 'main'; };
  const watching = w => [...viewers.values()].filter(x => x === w).length;

  function local(q) {
    const key = q.trim().toLowerCase();
    const hit = resolved.get(key), at = index.at() + ':' + themesAt();
    if (hit && hit.at === at) return hit.result;
    const result = resolve(q, index.rows(), themes);
    resolved.set(key, { at, result });
    if (resolved.size > 200) resolved.delete(resolved.keys().next().value);
    return result;
  }

  // Local answers, the r/wallstreetbets source, and the questions only a web search in the chat
  // can answer.
  async function lookup(q, ctx = {}) {
    // Other links ("…cnbc.com/berkshire-hathaway-portfolio/") are kept whole as the source for
    // the research in the chat; the splitter would otherwise cut them at every slash.
    const links = (q.match(/https?:\/\/\S+/gi) || []).filter(u => !/reddit\.com/i.test(u));
    for (const l of links) q = q.replace(l, ' ');
    const r = await lookupText(q.replace(/\s+/g, ' ').trim(), ctx);
    const open = [...r.research, ...r.unmatched];
    if (links.length && open.length) return { ...r, research: [open.join(' and ') + ' (source: ' + links.join(', ') + ')'], unmatched: [] };
    return r;
  }

  // Research answered before comes from memory ("refresh" in the request researches again).
  const REFRESH = /\b(refresh|research again|re-?research|look (?:it )?up again|update the list)\b/i;
  // A saved dashboard's own answers come first and never expire.
  function fromMemory(questions, refresh, savedAnswers = []) {
    const left = [], sections = [], notes = [], used = [];
    for (const qn of questions) {
      const own = refresh ? null : savedAnswers.find(a => similarity(a.question, qn) >= 0.75);
      const hit = own ? { ...own, days: Math.floor((Date.now() - own.at) / 86_400_000) } : (memory && !refresh ? memory.lookup(qn) : null);
      if (!hit) { left.push(qn); continue; }
      used.push({ question: hit.question, answer: hit.answer, how: hit.how || '', sources: hit.sources || [], at: hit.at });
      const r = local(hit.answer);
      for (const s of r.sections) sections.push({ ...s, footnote: [s.footnote, 'From memory: researched ' + (hit.days ? hit.days + ' days ago' : 'today') + (hit.how ? ' (' + hit.how + ')' : '') + (hit.sources.length ? '; sources: ' + hit.sources.join(', ') : '') + '. Say "refresh" to research again.'].filter(Boolean).join(' ') });
      notes.push('Answered from memory: "' + qn + '" (researched ' + (hit.days ? hit.days + ' days ago' : 'today') + (hit.how ? ' via ' + hit.how : '') + ').');
    }
    return { left, sections, notes, used };
  }

  // "Moscow banks" (a saved dashboard's name, also "show my Moscow banks dashboard"): the saved
  // request, with the research it was saved with.
  function savedDashboard(text) {
    if (!memory || !text || isTitledList(text) || parseMine(text)) return null;
    return memory.dashboard(text);
  }

  // "this is my portfolio: 10 AAPL, 5 MSFT", "add 5 TSLA to my portfolio", "I sold 2 AAPL"
  // (changes are saved only from /api/show) or "show my portfolio".
  function myPortfolio(q, save) {
    const mine = memory && parseMine(q);
    if (!mine) return null;
    const notes = [], unmatched = [], yours = sayOf(mine.name).replace(/^my/, 'your');
    if (mine.content && save) {
      const { items, unknown } = parseItems(mine.content, index.rows());
      const old = memory.portfolio(mine.name);
      if (items.length && mine.op === 'remove' && !old) { /* nothing saved to take from: said below */ }
      else if (items.length) {
        const { items: next, changed } = applyChange(old && old.items, items, mine.op);
        const n = next.length + ' holding' + (next.length === 1 ? '' : 's');
        if (!next.length) { memory.removePortfolio(mine.name); notes.push('Removed the last holding: ' + yours + ' is now empty.'); }
        else if (mine.op === 'remove' && !changed) notes.push('That is not in ' + yours + '; nothing was changed.');
        else {
          memory.savePortfolio(mine.name, next);
          notes.push((mine.op === 'add' ? 'Added to ' + yours : mine.op === 'remove' ? 'Removed from ' + yours : 'Saved as ' + yours) + ' (now ' + n + ', on this computer). Say "show ' + sayOf(mine.name) + '" any time.');
        }
      }
      unmatched.push(...unknown);
    }
    const saved = memory.portfolio(mine.name);
    if (!saved) notes.push('No portfolio saved' + (mine.name === 'default' ? '' : ' as "' + mine.name + '"') + ' yet. Say for example "this is my portfolio: 10 AAPL, 5 MSFT, 20 nvidia".');
    return { section: saved ? mineSection(mine.name, saved.items, index.rows()) : null, notes, unmatched, rest: q.replace(mine.phrase, ' ').replace(/\b(?:this is|here is|here's|show|save|remember)\b/gi, ' ').trim() };
  }

  async function lookupText(q, ctx = {}) {
    let rest = q, notes = [], sections = [], extraUnmatched = [], savedAnswers = [];
    const refresh = REFRESH.test(rest);
    if (refresh) rest = rest.replace(REFRESH, ' ').replace(/\s+/g, ' ').trim();
    const saved = savedDashboard(rest);
    if (saved) {
      rest = saved.q; savedAnswers = saved.answers || [];
      notes.push('Saved dashboard "' + saved.name + '" (saved ' + (saved.days ? saved.days + ' days ago' : 'today') + ')'
        + (savedAnswers.length ? '; its researched lists are the saved ones' + (refresh ? ', being researched again now' : ' (say "refresh" to research them again)') : '') + '.');
    }
    const mine = myPortfolio(rest, ctx.save);
    if (mine) {
      if (mine.section) sections.push(mine.section);
      notes.push(...mine.notes); extraUnmatched.push(...mine.unmatched);
      rest = mine.rest.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '');
    }
    // "Warren Buffett's portfolio": the latest 13F from SEC EDGAR. If no fund is found, the
    // words stay and go to research in the chat as before.
    if (portfolios && rest && isPortfolio(rest) && !isTitledList(rest)) {
      const keep = [];
      for (const p of splitQuery(rest)) {
        if (isPortfolio(p)) {
          try { const s = await portfolios(p, index.rows()); if (s) { sections.push(s); continue; } }
          catch (e) { notes.push('The SEC filing could not be read right now (' + e.message + ').'); }
        }
        keep.push(p);
      }
      rest = keep.join(', ');
    }
    if (social && rest && isSocial(rest)) {
      // A Reddit link has slashes, which the splitter would cut: stand it in with "wsb" first.
      const parts = splitQuery(rest.replace(/https?:\/\/\S*reddit\.com\/\S*/gi, ' wsb '));
      rest = parts.filter(p => !isSocial(p)).join(', ');
      try {
        const s = await social(q, index.rows(), { fresh: !!ctx.fresh });
        if (s.section) sections.push(s.section);
        if (s.note) notes.push(s.note);
      } catch (e) { notes.push('The r/wallstreetbets mention counts are unavailable right now (' + e.message + ').'); }
    }
    // "top 100 by trading volume", "most active", "after hours", "pre-market". "After hours" on
    // its own shows the most active shares; with other words ("nvidia after hours") those.
    let session = null;
    if (active && rest && (isActive(rest) || isExtended(rest))) {
      const wantList = isActive(rest), said = rest;
      if (isExtended(rest)) session = sessionAt();
      rest = stripMarketWords(rest);
      if (wantList || (!rest && !sections.length)) {
        try { const s = await active.section(said, index.rows()); if (s) sections.push(s); }
        catch (e) { notes.push('Today’s trading volumes are unavailable right now (' + e.message + ').'); }
      }
      if (session) notes.push(SESSION_NOTE[session]);
    }
    const { localText, questions } = rest ? splitResearch(rest, local) : { localText: '', questions: [] };
    const found = localText ? local(localText) : { sections: [], unmatched: [] };
    // Questions (and unknown words) answered before are taken from memory instead of research.
    const mem = fromMemory([...questions, ...found.unmatched, ...extraUnmatched], refresh, savedAnswers);
    const stillQuestions = mem.left.filter(x => questions.includes(x));
    const ids = new Set();
    const all = [...sections, ...found.sections, ...mem.sections].filter(s => !ids.has(s.id) && ids.add(s.id));   // a list and its remembered copy are one
    // Moscow shares that came without a size get their market value from the exchange.
    if (moex) await moex.enrich(all).catch(e => log('moex sizes failed: ' + e.message));
    return { sections: all, unmatched: mem.left.filter(x => !questions.includes(x)), research: stillQuestions, notes: [...notes, ...mem.notes], session, remembered: mem.used, saved: saved ? saved.name : null };
  }

  // Saves a window's view under a name, with the research answers it uses, so asking for the
  // name later brings it back as it was, with no research.
  async function saveView(w, name, q) {
    if (!memory) return { error: 'Saving needs the memory file, which is not available here.' };
    const view = q || (views.get(w) || {}).q || '';
    if (!view) return { error: 'There is no dashboard on screen to save yet.' };
    const r = await lookup(view);
    if (r.research.length || r.unmatched.length) return { error: 'Part of this dashboard is still waiting for research (' + [...r.research, ...r.unmatched].map(x => '"' + x + '"').join(', ') + '). Save it once the research is in.' };
    // A saved dashboard opened again is saved under its own request, not its name.
    const own = savedDashboard(view);
    const request = own ? own.q : view;
    const title = String(name || '').trim() || (own && own.name) || r.sections.map(s => s.title).join(' · ').slice(0, 80);
    const d = memory.saveDashboard(title, { q: request, answers: r.remembered });
    if (!d) return { error: 'That name has no letters or numbers in it; choose another.' };
    return { saved: { name: d.name, q: d.q, answers: d.answers.length, how: d.answers.map(a => a.how).filter(Boolean) }, list: memory.dashboards().map(x => x.name) };
  }
  const savedNames = () => (memory ? memory.dashboards().map(d => d.name) : []);
  // The window shown last: what "save this dashboard" means when no window is named.
  const lastWindow = () => [...views.entries()].filter(([, v]) => v.q).sort((a, b) => b[1].at - a[1].at).map(([k]) => k)[0] || 'main';

  // Self-learning: the questions a window is waiting on, and the named lists that answer them
  // when the agent comes back with its research. Each question is saved with how it was found.
  const pendingResearch = new Map();   // window → { questions, at }
  function learn(w, q, how, sources) {
    const pending = pendingResearch.get(w);
    if (!memory || !pending || Date.now() - pending.at > 2 * 3600_000) return [];
    const lists = q.split(';').map(p => p.trim()).filter(p => isTitledList(p) && !parseMine(p));
    if (!lists.length) return [];
    const questions = pending.questions.map(x => x.replace(/\s*\(source: [^)]*\)\s*$/, ''));
    const linkSources = pending.questions.flatMap(x => (/\(source: ([^)]*)\)/.exec(x) || [, ''])[1].split(', ').filter(Boolean));
    // Pair each question with the list whose title shares most words with it; one question
    // takes every list.
    const answers = new Map(questions.map(x => [x, []]));
    for (const l of lists) {
      const title = l.split(':')[0];
      let best = questions[0], score = -1;
      for (const x of questions) { const s = similarity(title, x); if (s > score) { score = s; best = x; } }
      answers.get(questions.length === 1 ? questions[0] : best).push(l);
    }
    const learned = [];
    for (const [x, ls] of answers) if (ls.length) { memory.remember(x, { answer: ls.join('; '), how, sources: [...new Set([...sources, ...linkSources])] }); learned.push(x); }
    pendingResearch.delete(w);
    return learned;
  }

  // fresh: a page that has just opened (or come back into view) gets prices fetched now, not
  // what was cached minutes ago.
  // Everything else on the page is refreshed with it: r/wallstreetbets counts (fresh on open,
  // then every minute), the stock list's market values (a new screener read every few minutes,
  // carried forward with each minute's prices in between).
  async function dashboard(q, { fresh = false } = {}) {
    if (index.refreshSoon) index.refreshSoon();
    const { sections, unmatched, research, notes, session } = await lookup(q, { fresh });
    const symbols = symbolsOf(sections);
    const outside = session && session !== 'regular' && active;
    // Shares that came as bare tickers ("9983.T") get their company names, looked up while the
    // prices load.
    const unnamedNow = names ? names.apply(sections) : [];
    const namesDone = unnamedNow.length ? names.fill(unnamedNow) : null;
    // live: Yahoo's quote feed, the latest price, today's change and market value of every
    // share (not Moscow ones: the exchange's own feed is the source there). Waited for at most
    // budgetMs like the prices; what is late comes with the next minute's refresh.
    const liveSyms = live ? symbols.filter(x => !/\.ME$/i.test(x)) : [];
    const [p, ext, lq] = await Promise.all([
      symbols.length ? prices.get(symbols, budgetMs, fresh ? { maxAgeMs: 15_000 } : {}) : { quotes: {}, source: {}, stale: [], pending: [], missing: [] },
      outside && symbols.length ? active.extended(symbols).catch(() => ({})) : {},
      liveSyms.length ? Promise.race([live.get(liveSyms).catch(() => ({})), new Promise(r => setTimeout(() => r({}), budgetMs + 800))]) : {},
    ]);
    if (namesDone) { await Promise.race([namesDone, new Promise(r => setTimeout(r, 300))]); names.apply(sections); }
    const caps = {}, sized = new Set();
    for (const s of sections) for (const g of s.groups) for (const st of g.stocks) {
      if (!s.sizeBy) sized.add(st.y);
      if (!st.cap) continue;
      // A screener value moves with the price: value × regular price now ÷ price it was read at.
      const v = p.quotes[st.y], at = st.capAt && st.capAt[0] === st.cap ? st.capAt[1] : 0;
      caps[st.y] = at > 0 && v && v.p > 0 && p.source[st.y] !== 'nasdaq' ? Math.round(st.cap * v.p / at) : st.cap;
    }
    const quotes = {};
    const syms = new Set([...Object.keys(p.quotes), ...Object.keys(lq)]);
    for (const sym of syms) {
      let qt = p.quotes[sym] || null;
      const L = lq[sym];
      if (L) {
        // The live quote is the price and today's move; the longer periods are carried over
        // from the daily closes (the same base, today's price).
        const r = qt && qt.p > 0 ? L.p / qt.p : null, mv = x => (x == null || r == null ? null : +((1 + x) * r - 1).toFixed(5));
        // Today's move from the last daily close before this session, as exchanges and other
        // vendors count it: Yahoo's own change field disagreed with its closes (LINK on
        // 17 Nov 2026: closes 2.785 → 2.80 = +0.54%, the field said −0.36%).
        const prevClose = closeOn(p.history && p.history[sym], Math.floor((L.at || Date.now() / 1000) / 86400) - 1);
        const d = prevClose > 0 ? L.p / prevClose - 1 : L.d != null ? L.d : L.prev ? L.p / L.prev - 1 : qt ? qt.d : null;
        qt = { ...(qt || { s: [], hi: L.p, lo: L.p }), p: L.p, d: d == null ? null : +d.toFixed(5),
          m: qt ? mv(qt.m) : null, y: qt ? mv(qt.y) : null, a: qt ? mv(qt.a) : null, t: L.at || (qt && qt.t), live: 1 };
        if (qt.hi != null && L.p > qt.hi) qt.hi = L.p;
        if (qt.lo != null && L.p < qt.lo) qt.lo = L.p;
        // Yahoo's value for every share: all share classes (and partnership units) at today's
        // price. The stock list's values went stale where it had no price to carry them forward
        // with (Accenture $160bn against $141.4bn at Yahoo and CNBC on 17 Nov 2026).
        if (L.cap && sized.has(sym)) caps[sym] = L.cap;
      }
      if (!qt) continue;
      if (caps[sym]) qt = { ...qt, cap: caps[sym] };
      // Outside regular hours "today" is the move from the last regular close to the latest
      // extended-hours trade: Yahoo's own after-hours / pre-market trade first (Nasdaq's
      // watchlist was a day behind on 17 Nov 2026), Nasdaq's otherwise.
      const e = outside ? (L && L.ext ? { p: L.ext.p, at: new Date(L.ext.at * 1000).toISOString().slice(11, 16) + ' UTC' } : ext[sym]) : null;
      if (e && qt.p) qt = { ...qt, close: qt.p, p: e.p, d: +(e.p / qt.p - 1).toFixed(5), xt: e.at };
      quotes[sym] = qt;
    }
    const missing = p.missing.filter(x => !quotes[x]);
    const universe = liveSizes(sections, quotes, p.history || {});
    return {
      query: q, updated: Date.now(),
      source: !symbols.length || Object.keys(quotes).length ? (p.stale.length ? 'stale' : 'live') : (p.pending.length ? 'loading' : 'none'),
      feeds: [...new Set([...Object.values(p.source), ...(Object.keys(lq).length ? ['yahoo quotes'] : [])])], universe, quotes,
      pending: p.pending.filter(x => !quotes[x]), stale: p.stale.length, missing, unmatched, research, notes, usual: usual(), saved: savedNames(),
      namesPending: unnamedNow.length ? names.pending(unnamedNow) : false,
      ...(outside ? { session: SESSION_WORD[session], extended: Object.keys(ext).length } : {}),
    };
  }

  function broadcast(w) {
    const msg = 'data: ' + JSON.stringify({ q: views.get(w).q, v: VERSION }) + '\n\n';
    for (const [res, x] of viewers) if (x === w) res.write(msg);
  }
  const ping = setInterval(() => { if (viewers.size) { onActivity(); for (const res of viewers.keys()) res.write(': ping\n\n'); } }, 25_000);
  if (ping.unref) ping.unref();

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  // Only this computer's own pages and the command may use the server. A website open in the
  // browser cannot: not under another name pointed at 127.0.0.1 (the Host check), and not by
  // calling the API from its own page (browsers mark such requests "cross-site"). This keeps a
  // saved portfolio private and stops other pages changing the view.
  const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const allowed = (req, path) => LOCAL.has(String(req.headers.host || '').replace(/:\d+$/, ''))
    && !(path.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!allowed(req, url.pathname)) return send(res, 403, { error: 'forbidden' });
    onActivity();
    let q = url.searchParams.get('q') || '';
    const w = windowOf(url);
    try {
      switch (url.pathname) {
        // Read per request (~0.1 ms) so an updated skill never serves an old page.
        case '/': case '/index.html': return send(res, 200, readFileSync(pagePath), 'text/html; charset=utf-8');
        case '/api/dashboard': return send(res, 200, await dashboard(q, { fresh: url.searchParams.get('fresh') === '1' }));
        case '/api/show': {
          await index.ready();
          // "Now add the banks": the window's current view plus the banks.
          const asked = q;
          q = withAdded(q, (views.get(w) || {}).q || '');
          // Research coming back is remembered first, so the question it answers, when the chat
          // repeats it in front of the lists ("show me the ASX 20; ASX 20: BHP.AX 16.5%, …"),
          // counts as answered instead of asking for research again.
          const learned = learn(w, q, url.searchParams.get('how') || '', url.searchParams.getAll('src').filter(Boolean));
          const { sections, unmatched, research, notes } = await lookup(q, { save: true });
          const symbols = symbolsOf(sections);
          // Warm up before the page asks, and say which shares no feed has a price for (only
          // those whose feeds have answered: the rest are still loading, not missing).
          // Warm up names and prices together; names that are back by then go into the reply.
          const namesDone = names && symbols.length ? names.fill(names.apply(sections)) : null;
          if (symbols.length) notes.push(...missingPrices(sections, await prices.get(symbols, budgetMs)));
          if (namesDone) { await Promise.race([namesDone, new Promise(r => setTimeout(r, 300))]); names.apply(sections); }
          if (isTitledList(q)) {
            // Market values come live from Yahoo's quote feed for every exchange it covers; they
            // replace sizes given with a list. Only what it has no value for needs research.
            const byCap = sections.filter(sec => !sec.sizeBy).flatMap(sec => sec.groups.flatMap(g => g.stocks.map(st => st.y))).filter(x => !/\.ME$/i.test(x));
            const lq = live && byCap.length ? await Promise.race([live.get(byCap).catch(() => ({})), new Promise(r => setTimeout(() => r({}), 4000))]) : {};
            const liveCaps = new Set(Object.keys(lq).filter(x => lq[x].cap > 0));
            notes.push(...missingSizes(sections, liveCaps));
            if (liveCaps.size) notes.push('MARKET VALUES: live from Yahoo Finance for ' + liveCaps.size + ' of ' + byCap.length + ' shares, updated every minute; they replace any sizes given with the list. Tell the person the tiles are sized by current market value, not by the numbers you looked up.');
          }
          views.set(w, { q, at: Date.now() });
          saveViews();
          broadcast(w);
          const open = [...research, ...unmatched];
          // Count what the person asks for, so the page can offer their usual requests. A
          // portfolio counts as "my portfolio" (never its contents); the chat's research
          // answers ("title: tickers") are not the person's words and are skipped.
          if (memory && q && (sections.length || research.length)) {
            const mine = parseMine(q);
            if (mine) memory.noteAsked(sayOf(mine.name));
            else if (!isTitledList(q)) memory.noteAsked(q.replace(REFRESH, ' '));
          }
          if (open.length) pendingResearch.set(w, { questions: open, at: Date.now() });
          // For what still needs research: how similar questions were answered before.
          const hints = memory ? open.flatMap(o => memory.similar(o).map(e => ({ for: o, question: e.question, how: e.how, sources: e.sources, days: e.days }))) : [];
          if (q !== asked) notes.unshift('Added to what this window showed: it now shows "' + q + '".');
          return send(res, 200, { ...summarise(sections, unmatched, research, notes), q, window: w, viewers: watching(w), vocab, learned, hints, usual: usual() });
        }
        case '/api/memory': return send(res, 200, memory ? { ...memory.all(), usual: memory.frequent(8) } : { research: {}, portfolios: {}, usual: [] });
        case '/api/memory/forget': return send(res, 200, { forgotten: memory ? memory.forget(q) : false });
        case '/api/window/new': {
          let name;
          do { name = 'w' + ++windowCount; } while (views.has(name));
          views.set(name, { q: '', at: Date.now() });
          return send(res, 200, { w: name });
        }
        case '/api/last': return send(res, 200, { w: lastWindow() });
        case '/api/current': return send(res, 200, { ...(views.get(w) || { q: '', at: 0 }), viewers: watching(w) });
        case '/api/save': {
          const target = url.searchParams.get('w') ? w : lastWindow();
          return send(res, 200, { window: target, ...(await saveView(target, url.searchParams.get('name') || '', q)) });
        }
        case '/api/events':
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          res.write('event: hello\ndata: ' + JSON.stringify({ v: VERSION }) + '\n\n'); // the page reloads itself after an update
          viewers.set(res, w);
          if (!views.has(w)) views.set(w, { q: '', at: 0 });
          req.on('close', () => viewers.delete(res));
          return;
        case '/api/history': {
          const symbols = symbolsOf((await lookup(q)).sections);
          const p = symbols.length ? await prices.get(symbols, budgetMs) : { history: {} };
          return send(res, 200, { updated: Date.now(), series: p.history });
        }
        case '/api/vocab': return send(res, 200, { ...vocab, usual: usual(), saved: savedNames() });
        case '/api/promo': return send(res, 200, { about: ABOUT, items: promo ? promo.items() : [] });
        case '/api/health': return send(res, 200, { ok: true, app: 'stockwatcher', version: VERSION, pid: process.pid, stocks: index.rows().length, viewers: viewers.size });
        case '/api/stop': send(res, 200, { ok: true, stopping: true }); return onStop();
        default: return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      log('error: ' + (e && e.stack || e));
      return send(res, 500, { error: String(e && e.message || e) });
    }
  });
  // Open event streams would keep close() waiting forever.
  const close = server.close.bind(server);
  server.close = cb => { clearInterval(ping); for (const res of viewers.keys()) res.end(); viewers.clear(); return close(cb); };
  return server;
}
