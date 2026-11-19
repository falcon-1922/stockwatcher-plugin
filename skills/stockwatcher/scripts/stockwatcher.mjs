#!/usr/bin/env node
// Stockwatcher: shows a live stock dashboard in the browser for whatever the person asked for in
// the chat, then exits. Pass the person's words as they are; the script works out what it can
// locally and prints research steps for the rest. An open page updates itself on each run.
//   node stockwatcher.mjs i want to see stocks in healthcare
//   node stockwatcher.mjs "nvidia, amd and tesla"
//   node stockwatcher.mjs "OpenAI investors: MSFT, NVDA, 9984.T | private: Thrive Capital"
//   node stockwatcher.mjs --list          (what it understands)
//   node stockwatcher.mjs --memory        (what it has learned on this computer)
//   node stockwatcher.mjs --about         (who made it, and their current workshops)
//   node stockwatcher.mjs --stop          (stops the background server)
// Options: --port N, --no-open
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homeDir, DEFAULT_PORT, VERSION, browserCommand, isNewer, shellSafe } from './lib/home.mjs';
import { withAdded } from './lib/server.mjs';
import { isRemote, writeSnapshot, screenshot } from './lib/snapshot.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = n => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
// A cloud session (Claude Code on the web, Codex cloud): the person cannot open 127.0.0.1, so
// each view is also written as one self-contained HTML file to publish (a claude.ai Artifact).
// --screenshot: also a PNG of it, for chats that cannot open a page at all (a phone app).
const wantShot = flag('--screenshot') || process.env.STOCKWATCHER_SCREENSHOT === '1';
const remote = flag('--snapshot') || wantShot || isRemote();
const outDir = opt('--out') || process.env.STOCKWATCHER_OUT || process.cwd();
const noOpen = flag('--no-open') || process.env.STOCKWATCHER_NO_OPEN === '1' || remote;
const stop = flag('--stop');
const list = flag('--list');
const showMemory = flag('--memory');                  // what has been learned and saved
const about = flag('--about');                        // who made this, and what they teach now
const forget = opt('--forget');                       // drop one remembered answer
// After research: how it was found (which site or API) and the main source links, saved with
// the answer so the same question is never researched twice.
const how = opt('--how') || '';
const sources = [];
for (let s; (s = opt('--source'));) sources.push(s);
const firstPort = +(opt('--port') || process.env.STOCKWATCHER_PORT || DEFAULT_PORT);
let windowName = opt('--window');
// "show in a different window …", "… in a new tab": a separate window with its own view.
const NEW_WINDOW = /\b(?:(?:show|open|put)\s+)?(?:it\s+)?(?:in|into|on)\s+(?:a\s+)?(?:new|different|separate|another|second|other)\s+(?:browser\s+)?(?:window|tab)\b/i;
const newWindow = flag('--new-window') || NEW_WINDOW.test(args.join(' '));
const query = args.join(' ').replace(NEW_WINDOW, ' ').replace(/\s+/g, ' ').trim();
const home = homeDir();

const getJson = (url, ms = 800) => fetch(url, { signal: AbortSignal.timeout(ms) }).then(r => r.json());
const health = port => getJson('http://127.0.0.1:' + port + '/api/health', 400).then(h => (h && h.app === 'stockwatcher' ? h : null), () => null);
const portFree = port => new Promise(r => { const s = netServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))); s.listen(port, '127.0.0.1'); });
const wait = ms => new Promise(r => setTimeout(r, ms));

function startServer(port) {
  mkdirSync(home, { recursive: true });
  const logFd = openSync(join(home, 'server.log'), 'a');
  spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url)), '--port', String(port)], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env, windowsHide: true,
  }).unref();
}

const newer = isNewer;

// Finds our server on one of ten ports, or starts it on the first free one. Several copies of
// the skill can be installed (Claude Code, Codex, OpenClaw, an older version): a running server
// of the same or a newer version is used as it is, and only an older one is replaced. Replacing
// any other version, as before, made two copies stop each other's server in turn.
async function ensureServer() {
  const found = [];
  for (let port = firstPort; port < firstPort + 10; port++) {
    const h = await health(port);
    if (h && (h.version === VERSION || newer(h.version, VERSION))) return port;
    if (h) found.push(port);
  }
  const blocked = await bindBlocked();
  if (blocked) { if (found.length) return found[0]; sandboxed(blocked); }   // another version: still shows the request
  for (let port = firstPort; port < firstPort + 10; port++) {
    const h = await health(port);
    if (h && (h.version === VERSION || newer(h.version, VERSION))) return port;
    if (h) { await getJson('http://127.0.0.1:' + port + '/api/stop').catch(() => {}); await wait(150); } // older copy: replace it
    if (!(await portFree(port))) continue;
    startServer(port);
    for (let i = 0; i < 100; i++) {
      await wait(30);
      if (!(await health(port))) continue;
      // Replaced an older server that had pages open: they reconnect within ~2 s, so wait for
      // them rather than opening a second tab.
      if (h && h.viewers !== 0) for (let j = 0; j < 25; j++) { const now = await health(port); if (now && now.viewers) break; await wait(100); }
      return port;
    }
    break;
  }
  return null;
}

function openBrowser(url) {
  const [cmd, a] = browserCommand(url);
  try { spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); return true; } catch { return false; }
}

// The command line to run this script again, quoted for any shell (paths may have spaces).
const self = 'node "' + process.argv[1] + '"';

function hint(vocab) {
  return 'It understands sectors (' + vocab.sectors.slice(0, 8).map(s => s.say).join(', ') + ' …), themes ('
    + vocab.themes.map(t => t.say).join(', ') + '), company names and tickers.';
}

// A sandbox (Codex, some IDE agents) may forbid starting a server while still allowing a visit
// to one that is running. So a running server is used whatever its version, and only when a new
// one must be started is the sandbox reported, in words an agent acts on.
const bindBlocked = () => new Promise(r => { const s = netServer().once('error', e => r(e.code === 'EPERM' || e.code === 'EACCES' ? e.code : null)).once('listening', () => s.close(() => r(null))); s.listen(0, '127.0.0.1'); });
function sandboxed(code) {
  console.log('BLOCKED BY THE SANDBOX (' + code + '): Stockwatcher must start a small web server on this computer (127.0.0.1) and fetch prices from the internet, and this sandbox allows neither.');
  console.log('Run exactly the same command again outside the sandbox: in Codex, request escalated permissions (sandbox_permissions "require_escalated", justification "Stockwatcher runs a local dashboard and fetches stock prices"). If the person is asked to approve, suggest approving it for future runs too.');
  console.log('Do not run the smoke test or look for another script: nothing is broken, only the sandbox is in the way. If escalation is not possible here, tell the person to run this once in a terminal, then ask again: ' + self + ' "' + shellSafe(query) + '"');
  process.exit(2);
}

if (stop) {
  let stopped = 0;
  for (let port = firstPort; port < firstPort + 10; port++) if (await health(port)) { await getJson('http://127.0.0.1:' + port + '/api/stop').catch(() => {}); stopped++; }
  console.log(stopped ? 'Stockwatcher stopped.' : 'Stockwatcher was not running.');
  process.exit(0);
}

const port = await ensureServer();
if (!port) {
  console.log('Stockwatcher could not start its local server. Log: ' + join(home, 'server.log'));
  console.log('Run the same command once more. If it fails again, run: ' + self + ' --stop   and then the command again. If that fails too, tell the person and show the last lines of the log.');
  process.exit(1);
}
const base = 'http://127.0.0.1:' + port;

if (showMemory) {
  const m = await getJson(base + '/api/memory', 5000);
  const research = Object.values(m.research), mine = Object.entries(m.portfolios);
  console.log(research.length ? 'Remembered research (' + research.length + '):' : 'No research remembered yet.');
  for (const e of research) console.log('  - "' + e.question + '" → ' + e.answer + '\n    found ' + new Date(e.at).toISOString().slice(0, 10) + (e.how ? ' via ' + e.how : '') + (e.sources.length ? '; sources: ' + e.sources.join(', ') : ''));
  const boards = Object.values(m.dashboards || {});
  console.log(boards.length ? 'Saved dashboards (' + boards.length + '):' : 'No dashboard saved yet.');
  for (const d of boards) console.log('  - "' + d.name + '" → ' + d.q + (d.answers && d.answers.length ? ' (with ' + d.answers.length + ' researched list' + (d.answers.length === 1 ? '' : 's') + ')' : '') + ', saved ' + new Date(d.at).toISOString().slice(0, 10));
  console.log(mine.length ? 'Saved portfolios: ' + mine.map(([n, p]) => (n === 'default' ? 'my portfolio' : n) + ' (' + p.items.length + ' holdings)').join(', ') : 'No portfolio saved yet.');
  if (m.usual && m.usual.length) console.log('Asked for most often: ' + m.usual.map(u => '"' + u.q + '" (' + u.n + '×)').join(', '));
  console.log('All of this is kept on this computer only.');
  process.exit(0);
}
if (about) {
  const p = await getJson(base + '/api/promo', 5000);
  console.log('Stockwatcher ' + VERSION + ' was built by ' + p.about.maker + ' (' + p.about.linkedin + '), AI Realist: https://airealist.org/');
  console.log('Current from AI Realist (mention at most one, and only if the person asked):');
  for (const it of p.items) console.log('  - ' + it.lead + ' ' + it.text + ' → ' + it.url);
  process.exit(0);
}
if (forget) {
  const r = await getJson(base + '/api/memory/forget?q=' + encodeURIComponent(forget), 5000);
  console.log(r.forgotten === 'dashboard' ? 'Deleted the saved dashboard "' + forget + '".' : r.forgotten ? 'Forgotten: "' + forget + '". It will be researched again next time.' : 'Nothing remembered for "' + forget + '".');
  process.exit(0);
}

// "save this dashboard", "save this dashboard as Moscow banks": the window's view is kept by
// name, with the research it used.
const SAVE = /^\s*(?:please\s+)?(?:save|keep|bookmark)\s+(?:this|the|that|my|current)?\s*(?:dashboard|view|page|heat\s?map|screen)\b(?:\s+(?:as|called|named|under)\s+["“']?(.+?)["”']?)?\s*[.!]?\s*$/i;
const saving = !list && SAVE.exec(query);
if (saving) {
  const valid = windowName && /^[a-z0-9-]{1,20}$/i.test(windowName);
  const r = await getJson(base + '/api/save?name=' + encodeURIComponent(saving[1] || '') + (valid ? '&w=' + windowName : ''), 15000);
  const shown = r.window && r.window !== 'main' ? '/?w=' + r.window : '/';
  if (r.error) console.log('NOT SAVED: ' + r.error);
  else {
    console.log('Saved the dashboard in window "' + r.window + '" as "' + r.saved.name + '" (on this computer). Request: ' + r.saved.q);
    console.log(r.saved.answers ? 'It keeps ' + r.saved.answers + ' researched list' + (r.saved.answers === 1 ? '' : 's') + ' with how they were found' + (r.saved.how.length ? ' (' + r.saved.how.join('; ') + ')' : '') + ', so it opens again with no research.' : 'Nothing in it needed research; it opens again as it is.');
    console.log('To bring it back, the person asks for "' + r.saved.name + '" (run this command with those words). It is also a ★ button on the page. Saved dashboards: ' + r.list.map(n => '"' + n + '"').join(', ') + '.');
    console.log('Tell the person it was saved and under which name.');
  }
  console.log(['', 'End your reply to the person with this line, exactly as it is:', 'You can see the dashboard here: ' + base + shown].join('\n'));
  process.exit(0);
}

// A new request does not replace a dashboard someone is looking at: it opens in a window of
// its own. Follow-ups that should change a dashboard name its window (--window w2).
// "Now add the banks" without a window name still means the dashboard shown last.
let ownWindow = false;
if (!list && !windowName && !newWindow && query && withAdded(query, 'x') !== query) windowName = (await getJson(base + '/api/last').catch(() => ({}))).w;
if (!list && !windowName && !newWindow && query) {
  const main = await getJson(base + '/api/current?w=main').catch(() => null);
  if (main && main.q && main.viewers > 0 && main.q.trim().toLowerCase() !== query.toLowerCase()) ownWindow = true;
}
if ((newWindow || ownWindow) && !list) windowName = (await getJson(base + '/api/window/new')).w;
const w = windowName && /^[a-z0-9-]{1,20}$/i.test(windowName) ? windowName : 'main';
const extra = (how ? '&how=' + encodeURIComponent(how) : '') + sources.map(s => '&src=' + encodeURIComponent(s)).join('');
const info = await getJson(base + (list ? '/api/vocab' : '/api/show?q=' + encodeURIComponent(query) + '&w=' + w + extra), 15000);

if (list) {
  console.log('Indices and themes: ' + info.themes.map(t => t.say).join(', '));
  console.log('Sectors and industries: ' + info.sectors.map(s => s.say).join(', '));
  console.log('Also: company names or tickers ("apple, nvidia, TSLA"), named lists ("OpenAI investors: MSFT, NVDA | private: Thrive Capital"),');
  console.log('and r/wallstreetbets: "wallstreetbets" or a thread link shows the 100 most-mentioned shares.');
  console.log('Anything else (investors, suppliers, competitors…) is researched in the chat, then shown as named lists.');
  process.exit(0);
}

// A page that is already open switches to the new view by itself; open one only if none is.
const shownQ = info.q || query;   // "now add the banks" comes back as the whole view
const params = [shownQ ? 'q=' + encodeURIComponent(shownQ) : '', w !== 'main' ? 'w=' + w : ''].filter(Boolean).join('&');
const url = base + '/' + (params ? '?' + params : '');
const opened = !noOpen && !info.viewers && openBrowser(url);
const where = w === 'main' ? '' : ' (window "' + w + '")';
const lines = [info.viewers ? 'Updated the Stockwatcher page that is already open' + where + ' (' + url + ').' : (opened ? 'Opened Stockwatcher' + where + ' in the browser: ' : 'Stockwatcher' + where + ' is ready at ') + url];
if (query) lines.push((ownWindow ? 'Opened in a new window ("' + w + '"), so the dashboard already open stays as it was. ' : '')
  + 'This dashboard is window "' + w + '". For a follow-up that changes it (adding to it, research results), add --window ' + w + ' to the command; without it, a new request opens in its own window.'
  + ' To keep it for later, the person can say "save this dashboard as <name>" (add --window ' + w + ') or press Save on the page.');
if (!query) {
  lines.push('The person tells you in the chat what to show; run this command again with their words.');
  if (info.usual && info.usual.length) lines.push('They often ask for: ' + info.usual.map(u => '"' + u + '"').join(', ') + '.');
}
else if (info.total) {
  lines.push('Showing ' + info.total + ' shares:');
  for (const s of info.sections) {
    lines.push('  - ' + s.title + ' (' + s.count + '): ' + (s.shares ? s.shares.join(', ') : s.groups.slice(0, 6).join(', ') + (s.groups.length > 6 ? ', …' : '')));
    if (s.about) lines.push('    ' + s.about);                     // a fund's filing: when, how big, and if it is old
  }
}
for (const n of info.notes || []) lines.push(n);
if (info.learned && info.learned.length) lines.push('Remembered for next time (no research needed again): ' + info.learned.map(x => '"' + x + '"').join(', ') + '.');

// What the local data cannot answer goes back to the agent in the chat, as steps.
const todo = [...info.research, ...info.unmatched];
if (todo.length) {
  const cli = self + ' --window ' + w;
  lines.push('', 'NEEDS RESEARCH (the local data cannot answer): ' + todo.map(u => '"' + u + '"').join(', '));
  // Self-learning: how related questions were answered before, so the method is not rediscovered.
  if (info.hints && info.hints.length) {
    lines.push('Past research that may help:');
    for (const h of info.hints) lines.push('  - "' + h.question + '" was answered ' + (h.days ? h.days + ' days ago' : 'today') + (h.how ? ' via ' + h.how : '') + (h.sources.length ? ' (sources: ' + h.sources.join(', ') + ')' : ''));
  }
  if (todo.length > 1) lines.push('These ' + todo.length + ' questions are independent. If you can run sub-agents in parallel (Claude Code: the Agent tool; Codex: parallel tasks), give each one its own sub-agent with web search, then combine the answers.');
  lines.push('1. Search the web for the companies listed on a stock exchange that answer ' + (todo.length > 1 ? 'each question' : 'it') + (todo.some(t => /\(source: /.test(t)) ? ' (start with the source link given)' : '') + '.');
  lines.push('2. Run the command again with one named list per question: "<short title>: <tickers>", lists separated by ";". Use Yahoo symbols (non-US with the exchange suffix, e.g. 9984.T, SAP.DE); put important private companies after "|".');
  lines.push('   For shares not listed in the US, write each one\'s size after the ticker, or every tile is drawn the same size: its index weight ("BHP.AX 9.8%") or market value in US dollars ("SAP.DE 300bn", no $: the shell deletes it). Always with the exchange suffix (.T, .KS, .BK, .SR, .HK, .L …).');
  lines.push('   Add --how "<which site or API worked>" and --source "<main link>" so the answer is remembered and never researched again:');
  lines.push('   ' + cli + ' --how "SEC 13F filings via EDGAR full-text search" --source "https://www.sec.gov/..." "' + (info.total ? '<what already showed, e.g. ' + shellSafe(info.sections[0].title) + '>; ' : '') + 'OpenAI investors: MSFT, NVDA, ORCL, 9984.T | private: Thrive Capital, Sequoia"');
  lines.push('3. Until you run that command, the dashboard shows nothing for ' + (todo.length > 1 ? 'these questions' : 'this question') + ': do not tell the person the companies are on screen before it. Reply after it, ending with the dashboard line it prints.');
  if (info.unmatched.length) lines.push('If a word is not about companies at all, tell the person instead. ' + hint(info.vocab));
}
lines.push('', 'To change the view, the person says so in the chat (run this command again with their words)' + (remote ? '.' : ' or types it in the page’s box.'));
// The reply always ends with where to see the dashboard. A short link: it opens the window's
// current view, whatever it shows by then.
const link = base + '/' + (w !== 'main' ? '?w=' + w : '');
if (remote) {
  // The 127.0.0.1 link means nothing to the person here: hand over a page file and a picture.
  if (info.total) {
    try {
      const snap = await writeSnapshot(base, shownQ, outDir);
      const priced = Math.min(snap.priced, info.total);
      const shot = await screenshot(snap.file);
      lines.push('', 'REMOTE SESSION: the person cannot open ' + base + ' (it is on this machine, not theirs). Do not give them that link.',
        'The dashboard was saved as one self-contained page (' + priced + ' of ' + info.total + ' shares priced, ' + Math.round(snap.bytes / 1024) + ' KB): ' + snap.file,
        shot.file ? 'And as a picture: ' + shot.file : 'No picture was taken: ' + shot.error + '.',
        'Show it to them, the first of these that works here:',
        '  1. Claude Code (web, desktop, phone): publish the page file with the Artifact tool; it becomes a private claude.ai page that opens on any device. Publish the same file again for later views to keep the link.',
        '  2. Otherwise, if you can attach images to your reply (Claude Code: SendUserFile; Codex: attach the image or show it inline), send the picture' + (shot.file ? '' : ' (none was taken: say so)') + '.',
        '  3. Otherwise send the page file itself; it opens in any browser, phone included.',
        'Tell them it is a snapshot of the prices now: it does not update by itself, and asking again in the chat makes a fresh one. For a dashboard that stays live on a phone, see "Phones and cloud sessions" in SKILL.md.');
      if (!priced) lines.push('NO PRICES: none of the ' + info.total + ' shares got a price, so the page is grey. This machine cannot reach the price feeds: in Codex cloud the agent has no internet by default. Do not send a grey page as if it were live: tell the person, and propose the fix in references/hosting.md (allow the price hosts, or host the dashboard).');
    } catch (e) {
      lines.push('', 'REMOTE SESSION: the person cannot open ' + base + ', and the snapshot could not be written (' + e.message + '). Run the same command once more; if it fails again, tell them what is shown and that the page can only be opened on this machine.');
    }
  } else if (!todo.length) lines.push('', 'REMOTE SESSION: nothing to show yet, so no page was made. Do not give the person the ' + base + ' link.');
  console.log(lines.join('\n'));
  process.exit(0);
}
lines.push('', 'End your reply to the person with this line, exactly as it is:', 'You can see the dashboard here: ' + link);
console.log(lines.join('\n'));
process.exit(0);
