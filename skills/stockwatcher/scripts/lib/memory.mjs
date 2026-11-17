// What the skill has learned, kept in one small file in the data folder:
// - research: question → the named lists that answered it, how they were found (which site or
//   API) and when. The same question next time is answered from here, with no research; a
//   related one gets the old method as a hint.
// - portfolios: the person's own portfolios ("this is my portfolio: 10 AAPL, 5 MSFT").
// - asked: how often each request was made, so the page can offer the person's usual ones.
// Everything stays on this computer.
import { readFileSync } from 'node:fs';
import { normalise } from './resolve.mjs';
import { saveFile } from './store.mjs';

export const FRESH_DAYS = 30;           // a remembered answer older than this is researched again
const DAY_MS = 86_400_000;
const MAX_ASKED = 60;                   // requests counted; the least used drop out

// Words that do not change what a question is about.
const FILLER = new Set(('a an the of in on for to and or with by from about who whom which what whats anyone anybody everyone '
  + 'everybody all any some list show me give tell see find companies company stocks stock shares share listed public '
  + 'publicly traded did does do has have had is are was were that this these those their its it please now today latest').split(' '));

// "investors", "invested", "investing" → "invest"; enough to match rephrasings.
export function stem(w) {
  for (const suf of ['ments', 'ment', 'ings', 'ing', 'ors', 'ers', 'or', 'er', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

export function words(q) {
  return [...new Set(normalise(q).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w && !FILLER.has(w)).map(stem))].sort();
}

function near(a, b) {                      // equal, or a typo apart ("inveseted" ~ "invested")
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 2) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 2;
}

// Share of words in common (each side's words matched to the other's, typos allowed).
export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return 0;
  const hits = A.filter(x => B.some(y => near(x, y))).length;
  return hits / (A.length + B.length - hits);
}

export function createMemory(file, now = () => Date.now(), log = () => {}) {
  let data = { research: {}, portfolios: {}, asked: {} };
  if (file) { try { data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* first run */ } }
  const save = () => { if (file) saveFile(file, JSON.stringify(data, null, 1), log); };
  const key = q => words(q).join(' ');
  const age = e => Math.floor((now() - e.at) / DAY_MS);
  // Asked often and lately counts most: a habit from months ago fades.
  const weight = e => e.n / (1 + age(e) / 30);

  return {
    // A remembered answer to this question, if one is close enough and fresh enough.
    lookup(question) {
      let best = null, score = 0;
      for (const e of Object.values(data.research)) {
        const s = similarity(question, e.question);
        if (s > score) { score = s; best = e; }
      }
      return best && score >= 0.75 && age(best) <= FRESH_DAYS ? { ...best, days: age(best) } : null;
    },
    // Past research on related questions: how it was done, to save work on a new one.
    similar(question, limit = 3) {
      return Object.values(data.research).map(e => ({ e, s: similarity(question, e.question) }))
        .filter(x => x.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, limit).map(x => ({ ...x.e, days: age(x.e) }));
    },
    remember(question, { answer, how = '', sources = [] }) {
      data.research[key(question)] = { question, answer, how, sources, at: now() };
      save();
    },
    forget(question) {
      const k = Object.keys(data.research).find(k => similarity(question, data.research[k].question) >= 0.75);
      if (!k) return false;
      delete data.research[k]; save(); return true;
    },
    savePortfolio(name, items) { data.portfolios[name] = { items, at: now() }; save(); },
    removePortfolio(name) { delete data.portfolios[name]; save(); },
    portfolio(name) { return data.portfolios[name] || null; },
    // Counts a request the person made. Rephrasings ("show me the banks", "banks") count as one;
    // the latest wording is the one offered back.
    noteAsked(q) {
      const text = String(q || '').replace(/\s+/g, ' ').trim(), k = key(text);
      if (!k || text.length > 80) return;
      const e = data.asked[k];
      data.asked[k] = { q: text, n: (e ? e.n : 0) + 1, at: now() };
      const keys = Object.keys(data.asked);
      if (keys.length > MAX_ASKED) keys.sort((a, b) => weight(data.asked[a]) - weight(data.asked[b])).slice(0, keys.length - MAX_ASKED).forEach(x => delete data.asked[x]);
      save();
    },
    // The person's usual requests, most used first.
    frequent(limit = 4) {
      return Object.values(data.asked).sort((a, b) => weight(b) - weight(a) || b.at - a.at).slice(0, limit).map(e => ({ q: e.q, n: e.n }));
    },
    all() { return data; },
  };
}
