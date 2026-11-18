// Where the skill keeps its cache and log: $STOCKWATCHER_HOME, else the OS cache folder.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function homeDir(env = process.env, platform = process.platform) {
  if (env.STOCKWATCHER_HOME) return env.STOCKWATCHER_HOME;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'stockwatcher');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'stockwatcher');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stockwatcher');
}

// Where the skill keeps what it must not lose (research memory, saved portfolios, windows):
// a data folder the OS does not clean up, unlike the cache. $STOCKWATCHER_DATA overrides it;
// with $STOCKWATCHER_HOME set (tests) it lives inside that folder.
export function dataDir(env = process.env, platform = process.platform) {
  if (env.STOCKWATCHER_DATA) return env.STOCKWATCHER_DATA;
  if (env.STOCKWATCHER_HOME) return join(env.STOCKWATCHER_HOME, 'data');
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'stockwatcher');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'stockwatcher');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'stockwatcher');
}

export const DEFAULT_PORT = 4317;

// One number for the command, the server and the page. Keep .claude-plugin/plugin.json in step.
export const VERSION = '3.9.4';

// "3.10.0" is newer than "3.9.2": compared number by number.
export function isNewer(a, b) {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// How to open a link in the default browser. Windows: not "cmd /c start <url>", which cuts
// the link at every "&" (…?q=…&w=w2); the URL handler takes it whole.
export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
