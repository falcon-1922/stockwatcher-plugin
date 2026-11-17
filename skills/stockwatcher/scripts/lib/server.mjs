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

export { VERSION };

export function summarise(sections, unmatched, research, notes = []) {
  return {
    sections: sections.map(s => ({ id: s.id, title: s.title, count: s.groups.reduce((a, g) => a + g.stocks.length, 0), groups: s.groups.map(g => g.name), ...(s.sizeBy === 'held' ? { about: s.blurb } : {}) })),
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
export function createServer({ pagePath, index, themes, prices = createPriceCache(), social = null, portfolios = null, memory = null, promo = null, viewsFile = null, budgetMs = 1200, log = () => {}, onStop = () => {}, onActivity = () => {} }) {
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
    const hit = resolved.get(key);
    if (hit && hit.at === index.at()) return hit.result;
    const result = resolve(q, index.rows(), themes);
    resolved.set(key, { at: index.at(), result });
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
  function fromMemory(questions, refresh) {
    const left = [], sections = [], notes = [];
    for (const qn of questions) {
      const hit = memory && !refresh ? memory.lookup(qn) : null;
      if (!hit) { left.push(qn); continue; }
      const r = local(hit.answer);
      for (const s of r.sections) sections.push({ ...s, footnote: [s.footnote, 'From memory: researched ' + (hit.days ? hit.days + ' days ago' : 'today') + (hit.how ? ' (' + hit.how + ')' : '') + (hit.sources.length ? '; sources: ' + hit.sources.join(', ') : '') + '. Say "refresh" to research again.'].filter(Boolean).join(' ') });
      notes.push('Answered from memory: "' + qn + '" (researched ' + (hit.days ? hit.days + ' days ago' : 'today') + (hit.how ? ' via ' + hit.how : '') + ').');
    }
    return { left, sections, notes };
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
    let rest = q, notes = [], sections = [], extraUnmatched = [];
    const refresh = REFRESH.test(rest);
    if (refresh) rest = rest.replace(REFRESH, ' ').replace(/\s+/g, ' ').trim();
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
        const s = await social(q, index.rows());
        if (s.section) sections.push(s.section);
        if (s.note) notes.push(s.note);
      } catch (e) { notes.push('The r/wallstreetbets mention counts are unavailable right now (' + e.message + ').'); }
    }
    const { localText, questions } = rest ? splitResearch(rest, local) : { localText: '', questions: [] };
    const found = localText ? local(localText) : { sections: [], unmatched: [] };
    // Questions (and unknown words) answered before are taken from memory instead of research.
    const mem = fromMemory([...questions, ...found.unmatched, ...extraUnmatched], refresh);
    const stillQuestions = mem.left.filter(x => questions.includes(x));
    return { sections: [...sections, ...found.sections, ...mem.sections], unmatched: mem.left.filter(x => !questions.includes(x)), research: stillQuestions, notes: [...notes, ...mem.notes] };
  }

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

  async function dashboard(q) {
    const { sections, unmatched, research, notes } = await lookup(q);
    const symbols = symbolsOf(sections);
    const p = symbols.length ? await prices.get(symbols, budgetMs) : { quotes: {}, source: {}, stale: [], pending: [], missing: [] };
    const caps = {};
    for (const s of sections) for (const g of s.groups) for (const st of g.stocks) if (st.cap) caps[st.y] = st.cap;
    const quotes = {};
    for (const [sym, v] of Object.entries(p.quotes)) quotes[sym] = caps[sym] ? { ...v, cap: caps[sym] } : v;
    return {
      query: q, updated: Date.now(),
      source: !symbols.length || Object.keys(quotes).length ? (p.stale.length ? 'stale' : 'live') : (p.pending.length ? 'loading' : 'none'),
      feeds: [...new Set(Object.values(p.source))], universe: sections, quotes,
      pending: p.pending, stale: p.stale.length, missing: p.missing, unmatched, research, notes, usual: usual(),
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
    const q = url.searchParams.get('q') || '';
    const w = windowOf(url);
    try {
      switch (url.pathname) {
        // Read per request (~0.1 ms) so an updated skill never serves an old page.
        case '/': case '/index.html': return send(res, 200, readFileSync(pagePath), 'text/html; charset=utf-8');
        case '/api/dashboard': return send(res, 200, await dashboard(q));
        case '/api/show': {
          await index.ready();
          const { sections, unmatched, research, notes } = await lookup(q, { save: true });
          const symbols = symbolsOf(sections);
          if (symbols.length) prices.refresh(symbols); // warm up before the page asks
          views.set(w, { q, at: Date.now() });
          saveViews();
          broadcast(w);
          const learned = learn(w, q, url.searchParams.get('how') || '', url.searchParams.getAll('src').filter(Boolean));
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
          return send(res, 200, { ...summarise(sections, unmatched, research, notes), window: w, viewers: watching(w), vocab, learned, hints, usual: usual() });
        }
        case '/api/memory': return send(res, 200, memory ? { ...memory.all(), usual: memory.frequent(8) } : { research: {}, portfolios: {}, usual: [] });
        case '/api/memory/forget': return send(res, 200, { forgotten: memory ? memory.forget(q) : false });
        case '/api/window/new': {
          let name;
          do { name = 'w' + ++windowCount; } while (views.has(name));
          views.set(name, { q: '', at: Date.now() });
          return send(res, 200, { w: name });
        }
        case '/api/current': return send(res, 200, views.get(w) || { q: '', at: 0 });
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
        case '/api/vocab': return send(res, 200, { ...vocab, usual: usual() });
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
