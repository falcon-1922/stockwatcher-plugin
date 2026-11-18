#!/usr/bin/env node
// Launch the installed CLI against disposable, offline data. Never stop a server unless
// its health PID matches a startup entry written to this run's private log.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VERSION } from './lib/server.mjs';

const cli = fileURLToPath(new URL('./stockwatcher.mjs', import.meta.url));
const runCli = promisify(execFile);
const query = 'real estate stocks';

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`);
  return response;
}

async function startupEntry(logFile) {
  const log = await readFile(logFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const entry = log.match(/listening on (http:\/\/127\.0\.0\.1:\d+) \(pid (\d+)\)/);
  return entry && { base: entry[1], pid: Number(entry[2]) };
}

async function stopTestServer({ base, pid }) {
  const health = await (await request(base + '/api/health')).json();
  assert.equal(health.app, 'stockwatcher');
  assert.equal(health.pid, pid, 'Refusing to stop a process outside this test');
  const result = await (await request(base + '/api/stop')).json();
  assert.equal(result.stopping, true);
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await request(base + '/api/health');
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return;
      throw error;
    }
    await delay(100);
  }
  throw new Error(`Test server still listening at ${base}`);
}

async function smokeTest() {
  const port = await freePort();
  const home = await mkdtemp(join(tmpdir(), 'stockwatcher-smoke-'));
  const logFile = join(home, 'server.log');
  const env = {
    ...process.env,
    STOCKWATCHER_HOME: home,
    STOCKWATCHER_DATA: join(home, 'data'),
    STOCKWATCHER_OFFLINE: '1',
    STOCKWATCHER_IDLE_MS: '15000',
  };

  try {
    const { stdout } = await runCli(process.execPath, [cli, '--port', String(port), '--no-open', query], {
      env,
      timeout: 12000,
    });
    const instance = await startupEntry(logFile);
    assert.ok(instance, 'No server started with the isolated test configuration');
    const { base, pid } = instance;
    assert.ok(stdout.includes(`You can see the dashboard here: ${base}/`), stdout);
    const health = await (await request(base + '/api/health')).json();
    assert.equal(health.app, 'stockwatcher');
    assert.equal(health.pid, pid);
    assert.equal(health.version, VERSION);
    assert.ok(health.stocks > 0, 'Bundled stock list is empty');
    const page = await request(base + '/');
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.match(await page.text(), /Stockwatcher/i);
    const current = await (await request(base + '/api/current')).json();
    assert.equal(current.q, query);
    const dashboard = await (await request(base + '/api/dashboard?q=' + encodeURIComponent(current.q))).json();
    const realEstate = dashboard.universe.find(section => section.title === 'Real estate');
    assert.ok(realEstate?.groups.some(group => group.stocks.length > 0), 'Real estate sector has no stocks');
    assert.deepEqual(dashboard.unmatched, []);
    assert.deepEqual(dashboard.research, []);
  } catch (error) {
    if (error.stdout) console.error(error.stdout.trim());
    if (error.stderr) console.error(error.stderr.trim());
    const log = await readFile(logFile, 'utf8').catch(() => '');
    if (log) console.error(log.trim());
    throw error;
  } finally {
    try {
      const instance = await startupEntry(logFile);
      if (instance) await stopTestServer(instance);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

try {
  await smokeTest();
  console.log('PASS: launcher, dashboard, Real estate sector, and graceful shutdown');
} catch (error) {
  console.error('Stockwatcher smoke test failed:', error);
  process.exitCode = 1;
}
