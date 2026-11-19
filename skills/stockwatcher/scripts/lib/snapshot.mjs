// A dashboard as one self-contained HTML file, for sessions where the person cannot open
// 127.0.0.1: a cloud session (Claude Code on the web, Codex cloud), a remote machine. The page,
// the prices, the year of closes and the footer line are put in one file that needs no server,
// so it can be published as a claude.ai Artifact or sent as a file. It shows the prices at the
// moment it was made; asking again in the chat makes a fresh one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Cloud and remote sessions, where a link to 127.0.0.1 opens nothing for the person.
export function isRemote(env = process.env) {
  if (env.STOCKWATCHER_SNAPSHOT === '1') return true;
  if (env.STOCKWATCHER_SNAPSHOT === '0') return false;
  // Codex cloud sets no documented marker: there the person sets STOCKWATCHER_SNAPSHOT=1.
  return env.CLAUDE_CODE_REMOTE === 'true' || !!env.CODESPACES;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const getJson = (url, ms) => fetch(url, { signal: AbortSignal.timeout(ms) }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

// The data the page would ask the server for, fetched once. The dashboard answers within about
// a second with what is ready and lists the rest as pending: ask again until it is complete.
async function collect(base, q) {
  const enc = encodeURIComponent(q);
  let dash = null;
  for (let i = 0; i < 20; i++) {
    dash = await getJson(base + '/api/dashboard?q=' + enc + (i ? '' : '&fresh=1'), 20000);
    if (!(dash.pending && dash.pending.length) && dash.source !== 'loading') break;
    await wait(1000);
  }
  const [history, promo] = await Promise.all([
    getJson(base + '/api/history?q=' + enc, 30000).catch(() => null),
    getJson(base + '/api/promo', 5000).catch(() => null),
  ]);
  const page = await fetch(base + '/', { signal: AbortSignal.timeout(5000) }).then(r => r.text());
  return { dash, history, promo, page };
}

// Answers the page's own requests from the data in the file. Requests that would change the
// view or save something have no server to go to, and say so.
function shim(data) {
  // JSON in a <script> must not contain "</script" or "<!--".
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script>
(function () {
  var S = ${json};
  var ok = function (body) { return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })); };
  var real = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (url, opts) {
    var u = String(url && url.url || url);
    var m = /(?:^|\\/)api\\/([a-z/]+)(?:\\?(.*))?$/.exec(u);
    if (!m) return real ? real(url, opts) : Promise.reject(new Error('offline'));
    var q = new URLSearchParams(m[2] || '').get('q');
    switch (m[1]) {
      case 'dashboard': return q === S.q ? ok(S.dash) : ok({ universe: [], quotes: {}, sections: [], research: [], unmatched: [], pending: [] });
      case 'history': return q === S.q && S.history ? ok(S.history) : ok({});
      case 'promo': return ok(S.promo || { items: [] });
      case 'current': case 'watch': return ok({ q: S.q });
      case 'vocab': return ok({ usual: [], saved: [] });
      default: return Promise.resolve(new Response('{"error":"snapshot"}', { status: 503 }));
    }
  };
  if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; };
  document.addEventListener('DOMContentLoaded', function () {
    var t = new Date(S.at);
    var bar = document.createElement('div');
    bar.className = 'snapshot-bar';
    bar.textContent = 'Snapshot of ' + t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      + ' your time. Prices do not update here: ask in the chat to make a fresh one.';
    document.body.insertBefore(bar, document.body.firstChild);
  });
})();
</script>
<style>
  .snapshot-bar { padding: 8px 16px; font: 13px/1.4 system-ui, sans-serif; background: #fff4d6; color: #5a4300; border-bottom: 1px solid #e8d49a; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .snapshot-bar { background: #3a3014; color: #f3e2b0; border-color: #5a4a1e; } }
  :root[data-theme="dark"] .snapshot-bar { background: #3a3014; color: #f3e2b0; border-color: #5a4a1e; }
  /* No server behind the page: the box, the example buttons and Save would do nothing. */
  #ask, .chat-hint, #saveBtn { display: none !important; }
</style>
`;
}

const slug = q => (q.split(';').map(p => (/^\s*([^:;|]{2,60}?)\s*:/.exec(p) || [, p])[1]).join(' ')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'dashboard');

// A picture of the dashboard, for when nothing can show a page: a chat that only takes text and
// images (ChatGPT or Codex on a phone, Slack), or no way to publish the file. Needs Playwright with
// a Chromium it can launch; without one it returns { error } and the page file is still there.
// The page is opened from the file, so it works with no server and no network.
export async function screenshot(htmlFile, pngFile = htmlFile.replace(/\.html$/, '.png')) {
  let chromium;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    ({ chromium } = req('playwright'));
  } catch {
    try { ({ chromium } = await import('playwright')); } catch { return { error: 'Playwright is not installed here' }; }
  }
  let browser;
  try {
    const exe = process.env.STOCKWATCHER_CHROMIUM;
    browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    await page.goto('file://' + htmlFile.replace(/\\/g, '/'));
    await page.waitForTimeout(2500);                       // heat map layout and the slider
    await page.screenshot({ path: pngFile, fullPage: true });
    return { file: pngFile };
  } catch (e) {
    return { error: 'the browser could not take it (' + String(e.message || e).split('\n')[0] + ')' };
  } finally { if (browser) await browser.close().catch(() => {}); }
}

// Writes the file and returns its path. The page reads its view from ?q=, which a published
// file does not have, so the shim's /api/current answer gives it the view instead.
export async function writeSnapshot(base, q, outDir) {
  const { dash, history, promo, page } = await collect(base, q);
  const data = { q, at: Date.now(), dash, history, promo };
  // The title names the published page (a claude.ai Artifact takes it from <title>).
  const parts = (dash && dash.universe || []).map(s => s.title).filter(Boolean);
  const name = (parts.length ? parts.join(' · ') : q).slice(0, 80);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = page.replace(/<title>[^<]*<\/title>/, () => '<title>' + esc(name) + ' · Stockwatcher</title>')
    .replace(/<script>/, () => shim(data) + '<script>');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'stockwatcher-' + slug(q) + '.html');
  writeFileSync(file, html);
  return { file, priced: dash && dash.quotes ? Object.keys(dash.quotes).length : 0, bytes: Buffer.byteLength(html) };
}
