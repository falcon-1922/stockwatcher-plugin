#!/usr/bin/env node
// The background server. Started by stockwatcher.mjs; not meant to be run by hand.
//   node serve.mjs --port 4317
// Stops itself after three hours without a request.
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadThemes } from './lib/indices.mjs';
import { join } from 'node:path';
import { createServer } from './lib/server.mjs';
import { loadIndex } from './lib/stockindex.mjs';
import { createPriceCache } from './lib/pricecache.mjs';
import { yahooState } from './lib/prices.mjs';
import { createSocial } from './lib/social.mjs';
import { createPortfolios } from './lib/portfolio.mjs';
import { createMemory } from './lib/memory.mjs';
import { createPromo } from './lib/promo.mjs';
import { createActive } from './lib/active.mjs';
import { createMoex } from './lib/moex.mjs';
import { createYQuote } from './lib/yquote.mjs';
import { createNames } from './lib/names.mjs';
import { homeDir, dataDir, DEFAULT_PORT } from './lib/home.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const i = process.argv.indexOf('--port');
const port = +(i > 0 ? process.argv[i + 1] : DEFAULT_PORT);
const home = homeDir();
const IDLE_MS = +(process.env.STOCKWATCHER_IDLE_MS || 3 * 3600_000);
const log = m => console.error(new Date().toISOString().slice(11, 19) + ' ' + m);

// STOCKWATCHER_OFFLINE=1 (tests): every outside request fails at once.
// STOCKWATCHER_NO_YAHOO=1: use Nasdaq only (US listings).
const fetchImpl = process.env.STOCKWATCHER_OFFLINE === '1' ? async () => { throw new Error('offline'); } : fetch;
if (process.env.STOCKWATCHER_NO_YAHOO === '1') yahooState.pausedUntil = Infinity;

const themes = loadThemes(join(root, 'data'));
// The stock list ships gzipped; registries that take text files only (ClawHub) get it as plain JSON.
const bundled = ['index.json.gz', 'index.json'].map(f => join(root, 'data', f)).find(p => existsSync(p)) || join(root, 'data', 'index.json.gz');
const index = loadIndex({ bundledPath: bundled, cachePath: join(home, 'index.json.gz'), fetchImpl, log });
const prices = createPriceCache({ fetchImpl, log, file: join(home, 'prices.json') });
// The MOEX Russia index ships with the weights of the day it was built; the exchange's own
// figures replace them at start and every minute.
const moex = process.env.STOCKWATCHER_OFFLINE === '1' ? null : createMoex({ fetchImpl, log });
if (moex) moex.keepIndexFresh(themes.find(t => t.id === 'imoex'));

const quit = why => { log(why + ', stopping'); prices.flush(); setTimeout(() => process.exit(0), 50); };
let idle;
const touch = () => { clearTimeout(idle); idle = setTimeout(() => quit('idle'), IDLE_MS); };
process.on('SIGTERM', () => quit('SIGTERM'));
process.on('SIGINT', () => quit('SIGINT'));
// A fault in one background task (a feed answering nonsense, a disk that is full) is logged;
// it must not take the dashboard down.
process.on('unhandledRejection', e => log('background task failed: ' + (e && e.stack || e)));
process.on('uncaughtException', e => log('unexpected error: ' + (e && e.stack || e)));
// What must survive (research memory, the person's portfolios, windows) lives in the data
// folder, not the cache: the OS may empty caches.
const data = dataDir();
const server = createServer({
  pagePath: join(root, 'assets', 'dashboard.html'), index, themes, prices, log, viewsFile: join(data, 'views.json'),
  memory: createMemory(join(data, 'memory.json'), undefined, log),
  promo: createPromo({ fetchImpl, log, file: join(home, 'promo.json'), bundledPath: join(root, 'data', 'promo.json'), offline: process.env.STOCKWATCHER_OFFLINE === '1' }),
  social: process.env.STOCKWATCHER_OFFLINE === '1' ? null : createSocial({ fetchImpl, log }),
  portfolios: process.env.STOCKWATCHER_OFFLINE === '1' ? null : createPortfolios({ fetchImpl, log, file: join(home, 'portfolios.json') }),
  active: process.env.STOCKWATCHER_OFFLINE === '1' ? null : createActive({ fetchImpl, log }),
  live: process.env.STOCKWATCHER_OFFLINE === '1' || process.env.STOCKWATCHER_NO_YAHOO === '1' ? null : createYQuote({ fetchImpl, log }),
  moex, themesAt: () => (moex ? moex.state.indexAt : 0),
  names: process.env.STOCKWATCHER_OFFLINE === '1' ? null : createNames({ fetchImpl, log, file: join(home, 'names.json') }),
  onActivity: touch,
  onStop: () => quit('stop requested'),
});
server.on('error', e => { log('cannot listen on ' + port + ': ' + e.code); process.exit(3); });
server.listen(port, '127.0.0.1', () => { touch(); log('listening on http://127.0.0.1:' + port + ' (pid ' + process.pid + ')'); });
