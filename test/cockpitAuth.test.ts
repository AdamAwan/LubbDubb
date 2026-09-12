import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import {
  authorizeRequest,
  createAuthThrottle,
  describeAuthAttempt,
  guardRequest,
  resolveCockpitToken,
} from '../src/server/auth.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { repoPath } from './support/paths.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-auth-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: true, tokenFile: join(dir, 'token') },
    ...overrides,
  });
}

function tokenOf(cockpitUrl: string | null): string {
  const token = cockpitUrl?.split('#t=')[1];
  assert.ok(token, 'buildApp should hand back a tokenised cockpit URL when auth is on');
  return token;
}

type RouteMethod = 'GET' | 'POST' | 'DELETE';

function declaredRoutes(): { method: RouteMethod; url: string }[] {
  const dir = repoPath('src/server/routes');
  const routes: { method: RouteMethod; url: string }[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const [, method, path] of source.matchAll(/\bapp\.(get|post|delete)\(\s*'([^']+)'/g)) {
      if (!method || !path) continue;
      routes.push({ method: method.toUpperCase() as RouteMethod, url: path.replace(/:[A-Za-z]+/g, '1') });
    }
  }
  return routes;
}

test('every API route declared under routes/ refuses an unauthenticated request', async () => {
  const routes = declaredRoutes();
  assert.ok(routes.length >= 20, `expected to find the route table, found ${routes.length} routes`);
  assert.ok(routes.some((r) => r.url === '/api/jobs'));

  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    ingressSecrets: {},
  });
  const { app } = await buildApp(system);

  for (const route of routes) {
    if (route.url.startsWith('/ingress/')) {
      const res = await app.inject({ method: route.method, url: route.url, payload: {} });
      assert.equal(res.statusCode, 404, `${route.url} must answer 404 with no ingress secret configured`);
      continue;
    }
    if (
      route.url.startsWith('/artifacts/') ||
      route.url.startsWith('/attachments/') ||
      route.url.startsWith('/local-validations/') ||
      route.url.startsWith('/validation-captures/')
    ) {
      const res = await app.inject({ method: route.method, url: route.url });
      assert.equal(res.statusCode, 401, `${route.url} must refuse a request carrying no capability`);
      continue;
    }
    assert.ok(route.url.startsWith('/api'), `unexpected non-API route ${route.url} — is it guarded?`);
    const res = await app.inject({ method: route.method, url: route.url });
    assert.ok(
      res.statusCode === 401 || res.statusCode === 429,
      `${route.method} ${route.url} answered ${res.statusCode}, expected a refusal`,
    );
  }

  await app.close();
  system.store.close();
});

test('the same routes answer normally once the token is presented', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  const state = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(state.statusCode, 200);
  assert.ok(Array.isArray(state.json().agents));

  const control = await app.inject({
    method: 'POST',
    url: '/api/control',
    headers: { authorization: `Bearer ${token}` },
    payload: { paused: true },
  });
  assert.equal(control.statusCode, 200);
  assert.equal(system.runtimeControl.paused, true);

  await app.close();
  system.store.close();
});

test('a wrong token is refused, and the comparison survives a length mismatch', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  for (const bad of ['', 'x', `${token}x`, token.slice(0, -1), token.toUpperCase()]) {
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${bad}` } });
    assert.equal(res.statusCode, 401, `token "${bad.slice(0, 8)}…" should have been refused`);
  }
  const basic = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Basic ${token}` } });
  assert.equal(basic.statusCode, 401);

  await app.close();
  system.store.close();
});

test('the SPA shell is deliberately not guarded — the token arrives in a fragment the browser never sends', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.notEqual(res.statusCode, 401);

  await app.close();
  system.store.close();
});

test('a flagged artifact opens by navigation with only the capability the snapshot minted', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  const wt = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  writeFileSync(join(wt, 'report.html'), '<h1>Report</h1>');
  const task = system.store.tasks.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = system.store.agents.createAgent({ taskId: task.id, cwd: wt, pid: null });
  const flag = system.store.agents.recordFlag(agent.id, { kind: 'report', label: 'report.html', ref: 'report.html' });

  const state = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  const artifactUrl: string = state.json().artifactUrls[flag.id];
  assert.match(artifactUrl, /^\/artifacts\/[^?]+\?tk=/, 'the snapshot must ship a capability-bearing URL');

  const nav = await app.inject({ method: 'GET', url: artifactUrl });
  assert.equal(nav.statusCode, 200, 'the capability alone must open the artifact');
  assert.equal(nav.body, '<h1>Report</h1>');
  assert.match(nav.headers['content-security-policy'] as string, /sandbox/);

  assert.equal((await app.inject({ method: 'GET', url: `/artifacts/${flag.id}` })).statusCode, 401);

  await app.close();
  system.store.close();
});

test('an artifact capability is scoped to one flag and is not a cockpit credential', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  const wt = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  writeFileSync(join(wt, 'a.html'), 'A');
  writeFileSync(join(wt, 'b.html'), 'B');
  const task = system.store.tasks.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = system.store.agents.createAgent({ taskId: task.id, cwd: wt, pid: null });
  const a = system.store.agents.recordFlag(agent.id, { kind: 'r', label: 'a', ref: 'a.html' });
  const b = system.store.agents.recordFlag(agent.id, { kind: 'r', label: 'b', ref: 'b.html' });

  const state = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  const urls: Record<string, string> = state.json().artifactUrls;
  const cap = new URL(`http://x${urls[a.id]}`).searchParams.get('tk');
  assert.ok(cap, 'a capability should be present in the artifact URL');

  assert.equal((await app.inject({ method: 'GET', url: urls[a.id] })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/artifacts/${b.id}?tk=${encodeURIComponent(cap)}` })).statusCode,
    401,
    "one artifact's capability must not open another",
  );

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${cap}` } })).statusCode,
    401,
  );
  assert.equal((await app.inject({ method: 'GET', url: `/api/state?t=${encodeURIComponent(cap)}` })).statusCode, 401);

  await app.close();
  system.store.close();
});

test('a non-loopback Host is refused even with a valid token (DNS rebinding)', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { authorization: `Bearer ${token}`, host: 'rebind.attacker.example:4300' },
    payload: { prompt: 'exfiltrate' },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /host/);

  const suffix = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${token}`, host: 'localhost.attacker.example' },
  });
  assert.equal(suffix.statusCode, 403);

  await app.close();
  system.store.close();
});

test('a cross-origin request is refused even with a valid token', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    payload: { prompt: 'exfiltrate' },
  });
  assert.equal(res.statusCode, 403);

  const opaque = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${token}`, origin: 'null' },
  });
  assert.equal(opaque.statusCode, 403);

  await app.close();
  system.store.close();
});

test('a loopback origin on another port is allowed, so the Vite dev proxy keeps working', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4300', 'http://[::1]:5173']) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { authorization: `Bearer ${token}`, origin },
    });
    assert.equal(res.statusCode, 200, `${origin} should be allowed`);
  }

  await app.close();
  system.store.close();
});

test('the Host check is dropped when the operator binds a routable address', () => {
  const req = { url: '/api/state', host: 'workstation.lan:4300', authorization: 'Bearer t' };
  assert.deepEqual(authorizeRequest(req, { token: 't', requireLoopbackHost: false, throttled: false }), { ok: true });
  assert.equal(authorizeRequest(req, { token: 't', requireLoopbackHost: true, throttled: false }).ok, false);
});

test('an origin matching the request host is allowed when bound off-loopback', () => {
  const req = {
    url: '/api/state',
    host: '100.117.182.27:4300',
    origin: 'http://100.117.182.27:4300',
    authorization: 'Bearer t',
  };
  assert.deepEqual(authorizeRequest(req, { token: 't', requireLoopbackHost: false, throttled: false }), { ok: true });

  const otherPort = {
    url: '/api/state',
    host: '100.117.182.27:4300',
    origin: 'http://100.117.182.27:9999',
    authorization: 'Bearer t',
  };
  assert.deepEqual(authorizeRequest(otherPort, { token: 't', requireLoopbackHost: false, throttled: false }), {
    ok: false,
    code: 403,
    error: 'cross-origin request refused',
  });

  const crossSite = {
    url: '/api/state',
    host: '100.117.182.27:4300',
    origin: 'https://evil.example',
    authorization: 'Bearer t',
  };
  assert.deepEqual(authorizeRequest(crossSite, { token: 't', requireLoopbackHost: false, throttled: false }), {
    ok: false,
    code: 403,
    error: 'cross-origin request refused',
  });
});

test('origin and host are answered before the token, so a leak never opens those doors', () => {
  const rebind = authorizeRequest(
    { url: '/api/state', host: 'evil.example', authorization: 'Bearer wrong' },
    { token: 'right', requireLoopbackHost: true, throttled: false },
  );
  assert.deepEqual(rebind, { ok: false, code: 403, error: 'host not allowed' });
});

test('the Bearer header is parsed without a backtracking regex', () => {
  const ask = (authorization: string) =>
    authorizeRequest(
      { url: '/api/state', host: 'localhost', authorization },
      { token: 'right', requireLoopbackHost: true, throttled: false },
    ).ok;

  assert.equal(ask('Bearer right'), true);
  assert.equal(ask('bearer right'), true, 'the scheme is case-insensitive');
  assert.equal(ask('Bearer    right'), true, 'padding between scheme and value is skipped');
  assert.equal(ask('Bearerright'), false);
  assert.equal(ask('Bearer '), false);
  assert.equal(ask(' right'), false);

  const started = process.hrtime.bigint();
  assert.equal(ask(`Bearer${' '.repeat(50_000)}`), false);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `parsing 50k spaces took ${elapsedMs.toFixed(0)}ms`);
});

test('a caller is shut out after repeated refusals, and successes never count toward it', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  for (let i = 0; i < 20; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer wrong' } });
    assert.equal(res.statusCode, 401, `attempt ${i + 1} should still be answered on its merits`);
  }

  const throttled = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(throttled.statusCode, 429);

  const valid = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  assert.equal(valid.statusCode, 429);

  await app.close();
  system.store.close();
});

test('a blocked source’s own requests do not extend its block', () => {
  const throttle = createAuthThrottle(3, 1_000);
  const attempt = (token: string) => ({ url: '/api/state', host: '127.0.0.1', authorization: `Bearer ${token}` });
  const guard = (token: string, now: number) =>
    guardRequest(attempt(token), { token: 'right', requireLoopbackHost: true, throttle, key: '::1', now });

  for (let i = 0; i < 3; i++) assert.equal(guard('wrong', i).ok, false, `attempt ${i + 1} is answered on its merits`);
  const shutOut = guard('wrong', 3);
  assert.equal(shutOut.ok, false);
  assert.equal(shutOut.ok === false && shutOut.code, 429);

  assert.equal(guard('right', 500).ok, false, 'still inside the window of the last credential refusal');

  for (let now = 4; now < 1_002; now += 100) guard('right', now);
  assert.equal(guard('right', 1_002).ok, true, 'the window drains whether or not the client kept knocking');
});

test('a busy cockpit never throttles itself — successes are not counted', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  for (let i = 0; i < 60; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200, `poll ${i + 1} was throttled`);
  }

  await app.close();
  system.store.close();
});

async function upgradeResult(port: number, query: string): Promise<'upgraded' | number | 'timeout'> {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: `/ws${query}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve('timeout');
    }, 5000);
    const settle = (result: 'upgraded' | number | 'timeout') => {
      clearTimeout(timer);
      resolve(result);
    };
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      settle('upgraded');
    });
    req.on('response', (res) => {
      res.resume();
      settle(res.statusCode ?? 0);
    });
    req.on('error', () => settle(0));
    req.end();
  });
}

test('the WebSocket upgrade is refused without a token and accepted with one', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };

  assert.equal(await upgradeResult(port, ''), 401);
  assert.equal(await upgradeResult(port, '?t=nope'), 401);
  assert.equal(await upgradeResult(port, `?t=${encodeURIComponent(token)}`), 'upgraded');

  await app.close();
  system.store.close();
});

test('a minted token is 0600, persistent across restarts, and long enough to be uninteresting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-token-'));
  const file = join(dir, 'nested', 'cockpit-token');

  const first = resolveCockpitToken(file);
  assert.equal(first.source, 'minted');
  assert.ok(first.token.length >= 43, `token is only ${first.token.length} chars`);
  assert.match(first.token, /^[A-Za-z0-9_-]+$/);

  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'token file must not be readable by other users');
  }

  const second = resolveCockpitToken(file);
  assert.equal(second.source, 'file');
  assert.equal(second.token, first.token);
  assert.equal(readFileSync(file, 'utf8').trim(), first.token);
});

test('an empty token file is re-minted, and re-minting tightens its permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-token-'));
  const file = join(dir, 'cockpit-token');
  writeFileSync(file, '   \n', { mode: 0o644 });

  const resolved = resolveCockpitToken(file);
  assert.equal(resolved.source, 'minted');
  assert.ok(resolved.token.length >= 43);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('LUBBDUBB_TOKEN wins and is never written to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-token-'));
  const file = join(dir, 'cockpit-token');
  process.env.LUBBDUBB_TOKEN = 'from-the-environment';
  try {
    const resolved = resolveCockpitToken(file);
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.token, 'from-the-environment');
    assert.equal(resolved.path, null);
    assert.equal(statSync(file, { throwIfNoEntry: false }), undefined, 'env token must not be persisted');
  } finally {
    delete process.env.LUBBDUBB_TOKEN;
  }
});

test('binding a routable address with auth off is refused at config load', () => {
  assert.throws(
    () => loadConfig({ host: '0.0.0.0', auth: { enabled: false, tokenFile: '.lubbdubb/cockpit-token' } }),
    /Refusing to start/,
  );
  assert.doesNotThrow(() => loadConfig({ host: '0.0.0.0' }));
  assert.doesNotThrow(() => loadConfig({ auth: { enabled: false, tokenFile: '.lubbdubb/cockpit-token' } }));
});

test('auth.enabled survives a partial auth block in the config file', () => {
  const config = loadConfig({ auth: { tokenFile: 'somewhere/else' } as Config['auth'] });
  assert.equal(config.auth.enabled, true);
  assert.equal(config.auth.tokenFile, 'somewhere/else');
});

test('the first refusal of a run is recorded and names the credential channel', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);

  await app.inject({ method: 'GET', url: '/api/state' });
  const logged = system.store.errors.listErrors().filter((e) => e.message.includes('cockpit refused'));
  assert.equal(logged.length, 1);
  assert.match(logged[0]?.detail ?? '', /credential=none/);
  assert.match(logged[0]?.detail ?? '', /path=\/api\/state/);
  await app.close();
  system.store.close();
});

test('later refusals are not recorded, and no refusal ever logs the presented token', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);

  await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer hunter2' } });
  for (let i = 0; i < 5; i++) await app.inject({ method: 'GET', url: '/api/state' });

  const logged = system.store.errors.listErrors().filter((e) => e.message.includes('cockpit refused'));
  assert.equal(logged.length, 1, 'only the first');
  assert.match(logged[0]?.detail ?? '', /credential=bearer/);
  assert.doesNotMatch(logged[0]?.detail ?? '', /hunter2/, 'the credential is described, never quoted');
  await app.close();
  system.store.close();
});

test('a present-but-unusable Authorization header is its own diagnosis', () => {
  assert.match(describeAuthAttempt({ url: '/api/state', authorization: 'Token abc' }), /credential=malformed/);
  assert.match(describeAuthAttempt({ url: '/api/state' }), /credential=none/);
  assert.match(describeAuthAttempt({ url: '/ws?t=abc', queryToken: 'abc' }), /credential=query/);
  assert.match(
    describeAuthAttempt({ url: '/ws?t=abc', authorization: 'Token x', queryToken: 'abc' }),
    /credential=query/,
  );
});
