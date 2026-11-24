
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { startBrowser, until } from './browser.mjs';
import { startMock, testToken, secondToken, demoAccount, uuid } from './mocks/mock.mjs';

export { assert, until, testToken, secondToken, demoAccount, uuid };
export const api = '/api/v1/nominal-accounts';
export const path = {
  beneficiaries: api + '/beneficiaries', scoring: '/api/v2/nominal-accounts/beneficiaries/scoring',
  incoming: api + '/incoming-transactions', payments: api + '/payments',
  transfers: api + '/virtual-accounts/transfers', balances: api + '/virtual-accounts/balances',
  holds: api + '/virtual-accounts/holds', deals: api + '/deals', statement: '/api/v1/statement',
};

const repo = resolve(import.meta.dirname, '../..');
const artifacts = join(import.meta.dirname, '.artifacts');

async function freePort() {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

function replaceOnce(text, original, replacement) {
  const parts = text.split(original);
  assert.equal(parts.length, 2, 'Точка настройки локального прокси: ' + original);
  return parts.join(replacement);
}

async function startRelay(upstream, port, { dist = join(repo, 'dist'), trusted = '' } = {}) {
  let commands = await readFile(join(repo, 'server.commands'), 'utf8');
  commands = replaceOnce(commands, '$port = 8765', '$port = ' + port);
  commands = replaceOnce(commands, 'try { Start-Process -FilePath "$origin/" } catch { Write-Warning "Open manually: $origin/" }', '');
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
    windowsHide: true,
    env: { ...process.env, TBANK_UI_DIST: dist, TBANK_UI_TRUSTED_PROXY: trusted, TBANK_UI_MOCK_PROXY: upstream },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  child.stdin.on('error', error => { diagnostics += error.message; });
  child.on('error', error => { diagnostics += error.message; });
  child.stdin.end(commands);
  const origin = 'http://127.0.0.1:' + port;
  try {
    const run = await until(async () => {
      if (child.exitCode !== null) throw new Error(diagnostics);
      try {
        const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(650) });
        const id = await response.text();
        return response.ok && /^[a-f0-9]{32}$/.test(id) && id;
      } catch { return false; }
    }, 'локальный прокси', 12000);
    return { child, origin, run };
  } catch (error) {
    child.kill();
    throw new Error(error.message + '\n' + diagnostics);
  }
}

async function closeRelay(relay) {
  if (relay?.child.exitCode !== null) return;
  const exited = once(relay.child, 'exit');
  relay.child.kill();
  await exited;
}

export function requestLocal(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, agent: false }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        let payload = raw;
        try { payload = JSON.parse(raw); } catch {}
        resolve({
          http: response.statusCode, status: payload?.responseCode ?? response.statusCode,
          data: payload?.responseBody ?? payload, headers: response.headers,
        });
      });
    });
    request.setTimeout(26000, () => request.destroy(new Error('Тайм-аут локального запроса')));
    request.on('error', reject);
    request.end(body);
  });
}

async function createEnvironment(large, profile) {
  const trace = [];
  const faults = [];
  const mock = await startMock({ large, trace, faults });
  let relay, browser;
  async function close() {
    try {
      await browser?.close();
    } finally {
      await closeRelay(relay);
      mock.server.closeAllConnections();
      await new Promise(resolve => mock.server.close(resolve));
    }
  }
  try {
    relay = await startRelay(mock.origin, await freePort());
    browser = await startBrowser(profile, await freePort());
    await browser.send('Page.navigate', { url: relay.origin + '/' });
    await browser.wait('#settings-link');
    return {
      ...browser, mock, trace, faults, origin: relay.origin, close,
      after(method, path, options) { faults.push({ method, path, phase: 'after', status: 502, ...options }); },
      before(method, path, status, body, options) { faults.push({ method, path, phase: 'before', status, body, ...options }); },
      calls(method, path) { return trace.filter(request => request.method === method && request.path === path); },
      async withStartupConfig(config, { trusted = '', mockOrigin = '', legacy = false }, action) {
        const fixture = await mkdtemp(join(dirname(profile), 'relay-'));
        const dist = join(fixture, 'dist');
        let configuredRelay;
        try {
          await cp(join(repo, 'dist'), dist, { recursive: true });
          await writeFile(join(fixture, legacy ? 'proxy-origin.txt' : 'proxy.cfg'), config, 'utf8');
          configuredRelay = await startRelay(mockOrigin, await freePort(), { dist, trusted });
          return await action(configuredRelay);
        } finally {
          await closeRelay(configuredRelay);
          assert.equal(dirname(fixture), dirname(profile));
          await rm(fixture, { recursive: true, force: true });
        }
      },
      async relay(path, { method = 'GET', headers = {}, body, raw } = {}) {
        const json = raw ?? (body === undefined ? undefined : JSON.stringify(body));
        const composed = {
          'X-TBank-Run': relay.run, 'X-TBank-Proxy-Origin': mock.origin, 'X-TBank-Environment': 'mock',
          Authorization: 'Bearer ' + testToken, bankAccountId: uuid(990),
          ...(method === 'GET' ? {} : { Origin: relay.origin }),
          ...(json === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }),
          ...headers,
        };
        for (const name of Object.keys(composed)) if (composed[name] === null) delete composed[name];
        return requestLocal(relay.origin + '/api/relay' + path, { method, headers: composed, body: json });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function normalized(route) {
  return route.replace(/^\/qa-gateway/, '').replace(/\{[^}]+\}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, '{id}');
}

export async function coverage(trace) {
  const readme = await readFile(join(repo, 'README.md'), 'utf8');
  const expected = new Set();
  const steps = '/deals/{dealId}/steps/{stepId}';
  for (const [, method, original] of readme.matchAll(/(?:^|[\s\`])(GET|POST|PUT|DELETE) (\/[A-Za-z0-9_{}\/-]+)/gm)) {
    let route = original;
    if (route.startsWith('/deponents') || route.startsWith('/recipients')) route = steps + route;
    if (!route.startsWith('/api/')) route = api + route;
    expected.add(method + ' ' + normalized(route));
  }
  const succeeded = new Set(trace.filter(call => call.status >= 200 && call.status < 300)
    .map(call => call.method + ' ' + normalized(call.path)));
  const missing = [...expected].filter(route => !succeeded.has(route));
  assert(expected.size > 0, 'В README отсутствуют операции для сверки.');
  assert.deepEqual(missing, [], 'Маршруты README без успешного запроса');
  return { operations: expected.size };
}

export async function run(groups, { large, filter }) {
  if (process.platform !== 'win32') throw new Error('Для прогона требуется Windows с локальным прокси проекта.');
  await mkdir(artifacts, { recursive: true });
  const runDir = await mkdtemp(join(artifacts, 'run-'));
  const profile = join(runDir, 'edge');
  const results = [];
  const suite = await createEnvironment(large, profile);
  let fatal;
  try {
    for (const test of groups) {
      if (filter && !test.id.startsWith('AUTH-01') && !filter.test(test.id)) continue;
      const started = Date.now();
      const offset = suite.trace.length;
      try {
        const details = await test.run(suite);
        results.push({ id: test.id, title: test.title, status: 'PASS', ms: Date.now() - started, details });
        console.log('PASS', test.id, test.title);
      } catch (error) {
        const statuses = await suite.evaluate(() => [...document.querySelectorAll('[role=status]')]
          .filter(node => node.getClientRects().length && node.textContent.trim())
          .map(node => ({ id: node.id, text: node.textContent.trim() }))).catch(() => []);
        const requests = suite.trace.slice(offset).map(({ method, url, status, delivery }) => ({ method, url, status, delivery }));
        results.push({ id: test.id, title: test.title, status: 'FAIL', ms: Date.now() - started, error: error.stack, statuses, requests });
        console.error('FAIL', test.id, test.title, '\n ', error.message, '\n ', JSON.stringify(statuses));
        break;
      }
    }
    assert.deepEqual(suite.exceptions, [], 'Необработанные исключения браузера');
    assert.deepEqual(suite.faults, [], 'Остались неиспользованные сценарии сбоя');
  } catch (error) {
    fatal = error;
    console.error(error);
  } finally {
    await suite.close();
    assert.equal(dirname(profile), runDir);
    await rm(profile, { recursive: true, force: true, maxRetries: 4 }).catch(error => {
      console.warn('Не удалось удалить временный профиль Edge:', error.message);
    });
    const output = join(runDir, 'results.json');
    await writeFile(output, JSON.stringify({ large, filter: filter?.source, results, fatal: fatal?.stack }, null, 2) + '\n');
    console.log('Результаты:', output);
  }
  if (fatal || results.some(result => result.status === 'FAIL')) process.exitCode = 1;
  else console.log('Успешно:', results.length);
}

export function test(id, title, run) { return { id, title, run }; }
