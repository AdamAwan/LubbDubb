import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { authorizeRequest, describeAuthAttempt, resolveCockpitToken } from '../src/server/auth.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-auth-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: true, tokenFile: join(dir, 'token') },
    ...overrides,
  });
}

/** The token this app is running with, lifted out of the URL it hands `main.ts`. */
function tokenOf(cockpitUrl: string | null): string {
  const token = cockpitUrl?.split('#t=')[1];
  assert.ok(token, 'buildApp should hand back a tokenised cockpit URL when auth is on');
  return token;
}

// ---------------------------------------------------------------------------
// The structural one. Every guarded route is guarded because the hook matches a
// path prefix rather than being opted into per route — so the assertion that
// matters is over the whole route table, read out of the source. A route added
// later is covered by this test on the day it is written, which is the property
// a hand-maintained list of paths cannot have.
// ---------------------------------------------------------------------------

type RouteMethod = 'GET' | 'POST' | 'DELETE';

/** Every `app.get`/`app.post`/`app.delete` path declared in `app.ts`, with params filled in. */
function declaredRoutes(): { method: RouteMethod; url: string }[] {
  const source = readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const routes: { method: RouteMethod; url: string }[] = [];
  for (const [, method, path] of source.matchAll(/\bapp\.(get|post|delete)\('([^']+)'/g)) {
    if (!method || !path) continue;
    routes.push({ method: method.toUpperCase() as RouteMethod, url: path.replace(/:[A-Za-z]+/g, '1') });
  }
  return routes;
}

test('every API route declared in app.ts refuses an unauthenticated request', async () => {
  const routes = declaredRoutes();
  // Guards the guard: a regex that silently stopped matching would make every
  // assertion below vacuous.
  assert.ok(routes.length >= 20, `expected to find the route table, found ${routes.length} routes`);
  assert.ok(routes.some((r) => r.url === '/api/jobs'));

  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);

  for (const route of routes) {
    // `/artifacts/:id` is the one route deliberately outside the `/api` prefix
    // (issue #129): a top-level browser navigation cannot carry the bearer header,
    // so the chip opens a route that authorizes itself with a per-flag capability
    // instead. The prefix guard therefore does *not* apply — but the route must
    // still refuse a bare request, which is what makes moving it out of `/api`
    // safe. Asserted here so it can't silently become reachable.
    if (route.url.startsWith('/artifacts/')) {
      const res = await app.inject({ method: route.method, url: route.url });
      assert.equal(res.statusCode, 401, `${route.url} must refuse a request carrying no capability`);
      continue;
    }
    assert.ok(route.url.startsWith('/api'), `unexpected non-API route ${route.url} — is it guarded?`);
    const res = await app.inject({ method: route.method, url: route.url });
    // 401 or 429: walking the whole table from one source spends the failure
    // budget partway through, and a throttled refusal is still a refusal. This
    // does not weaken the claim — the guard checks the *path* before the
    // throttle, so an unguarded route would answer 200/404 here and never 429.
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

  // A mutating route too — the guard must not be read-only by accident.
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
  // A malformed scheme is not a token.
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

  // No `web/dist` in a test checkout, so the shell 404s rather than 200s. What
  // matters is that it is *not* a 401: the page must load in order to
  // authenticate, and it carries no world state of its own.
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.notEqual(res.statusCode, 401);

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// The artifact navigation path (issue #129). A chip opens a new tab, which is a
// top-level navigation and cannot carry the bearer header — so the artifact route
// lives outside `/api` and authorizes itself with a per-flag capability minted
// into the snapshot. These assert the whole loop and, crucially, that the
// capability is unusable as a general cockpit credential.
// ---------------------------------------------------------------------------

test('a flagged artifact opens by navigation with only the capability the snapshot minted', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  // A real flagged file in an agent's worktree.
  const wt = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  writeFileSync(join(wt, 'report.html'), '<h1>Report</h1>');
  const task = system.store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = system.store.createAgent({ taskId: task.id, cwd: wt, pid: null });
  const flag = system.store.recordFlag(agent.id, { kind: 'report', label: 'report.html', ref: 'report.html' });

  // The cockpit reads the artifact URL out of the (bearer-authenticated) snapshot,
  // exactly as it would in the browser — capability and all.
  const state = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  const artifactUrl: string = state.json().artifactUrls[flag.id];
  assert.match(artifactUrl, /^\/artifacts\/[^?]+\?tk=/, 'the snapshot must ship a capability-bearing URL');

  // The navigation itself carries NO bearer header — a browser navigation cannot —
  // only the capability in the URL. This is the exact request that was 401ing.
  const nav = await app.inject({ method: 'GET', url: artifactUrl });
  assert.equal(nav.statusCode, 200, 'the capability alone must open the artifact');
  assert.equal(nav.body, '<h1>Report</h1>');
  // The sandbox CSP survives — agent-authored HTML still cannot script the cockpit.
  assert.match(nav.headers['content-security-policy'] as string, /sandbox/);

  // Without the capability the route refuses — moving it out of `/api` is only safe
  // because it guards itself.
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
  const task = system.store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = system.store.createAgent({ taskId: task.id, cwd: wt, pid: null });
  const a = system.store.recordFlag(agent.id, { kind: 'r', label: 'a', ref: 'a.html' });
  const b = system.store.recordFlag(agent.id, { kind: 'r', label: 'b', ref: 'b.html' });

  const state = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  const urls: Record<string, string> = state.json().artifactUrls;
  const cap = new URL(`http://x${urls[a.id]}`).searchParams.get('tk');
  assert.ok(cap, 'a capability should be present in the artifact URL');

  // Flag-scoped: a's capability opens a, never b.
  assert.equal((await app.inject({ method: 'GET', url: urls[a.id] })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/artifacts/${b.id}?tk=${encodeURIComponent(cap)}` })).statusCode,
    401,
    "one artifact's capability must not open another",
  );

  // Not a cockpit credential: the capability is refused against the guarded API,
  // both as a bearer token and as the WebSocket's `?t=` query token — so a leaked
  // capability can never be replayed against /api/state or /api/jobs.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${cap}` } })).statusCode,
    401,
  );
  assert.equal((await app.inject({ method: 'GET', url: `/api/state?t=${encodeURIComponent(cap)}` })).statusCode, 401);

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// Rebinding and cross-origin: the layer that makes a leaked token survivable.
// ---------------------------------------------------------------------------

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

  // The near-miss the check exists for: a name that merely *starts* with a
  // loopback name is somebody else's domain.
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

  // `null` is what a sandboxed frame sends — including the artifact route's own
  // agent-authored HTML.
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
  // Bound off-loopback, a LAN hostname is exactly what a legitimate client sends,
  // so the token carries the security alone. Asserted on the pure verdict because
  // the alternative is binding a real routable socket in a test.
  const req = { url: '/api/state', host: 'workstation.lan:4300', authorization: 'Bearer t' };
  assert.deepEqual(authorizeRequest(req, { token: 't', requireLoopbackHost: false, throttled: false }), { ok: true });
  assert.equal(authorizeRequest(req, { token: 't', requireLoopbackHost: true, throttled: false }).ok, false);
});

test('origin and host are answered before the token, so a leak never opens those doors', () => {
  // Order is the property: a refusal must not depend on the credential being
  // wrong, or a leaked token turns a rebinding attempt back into a way in.
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

  // The shape that made the old pattern backtrack polynomially: the scheme
  // followed by a long run of spaces and no value. Unauthenticated input, so the
  // cost of answering it has to stay linear.
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

  // Well past any plausible cockpit burst, and only refusals get here.
  for (let i = 0; i < 20; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer wrong' } });
    assert.equal(res.statusCode, 401, `attempt ${i + 1} should still be answered on its merits`);
  }

  // Budget spent: refused before the token is even compared.
  const throttled = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(throttled.statusCode, 429);

  // And the throttle is indiscriminate once tripped — this is a deliberate cost,
  // not an oversight: a correct token from a source that has just been guessing
  // waits out the window like everything else.
  const valid = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  assert.equal(valid.statusCode, 429);

  await app.close();
  system.store.close();
});

test('a busy cockpit never throttles itself — successes are not counted', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app, cockpitUrl } = await buildApp(system);
  const token = tokenOf(cockpitUrl);

  // Far more than the failure budget. Polling `/api/state` is what the cockpit
  // does continuously, and throttling that would be the bug.
  for (let i = 0; i < 60; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200, `poll ${i + 1} was throttled`);
  }

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// The live socket. Injected requests never exercise a real upgrade, and this is
// the surface that streams source code and agent output.
// ---------------------------------------------------------------------------

/**
 * Attempt a real WebSocket upgrade and report what the server answered:
 * `'upgraded'` for the 101, or the refusing status code.
 *
 * Raw `node:http` rather than a `ws` client, for two reasons. The question here
 * is only whether the *upgrade* is granted, which is an HTTP-level fact — no
 * frames are ever exchanged, so speaking the WebSocket protocol adds nothing.
 * And `ws` reaches the test only as a hoisted transitive dependency of
 * `@fastify/websocket`; importing it for real would make this test depend on
 * another package's dependency tree.
 */
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
      // An accepted upgrade hands over a live socket. Close it here or Fastify's
      // `close()` below waits on a connection nothing is using.
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

  // This is the only test that binds a real socket. A refused upgrade answers
  // 401 on a connection the client asked to upgrade, and those linger, so
  // `close()` alone waits for a drain that never comes.
  // No forced connection teardown here on purpose: closing cleanly is the
  // assertion. A refused upgrade leaves a socket that belongs to neither side's
  // bookkeeping, so without the `Connection: close` the guard sends, this line
  // hangs and the harness could never shut down after anyone probed `/ws`.
  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// Token resolution.
// ---------------------------------------------------------------------------

test('a minted token is 0600, persistent across restarts, and long enough to be uninteresting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-token-'));
  const file = join(dir, 'nested', 'cockpit-token');

  const first = resolveCockpitToken(file);
  assert.equal(first.source, 'minted');
  // 32 bytes of CSPRNG, base64url.
  assert.ok(first.token.length >= 43, `token is only ${first.token.length} chars`);
  assert.match(first.token, /^[A-Za-z0-9_-]+$/);

  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'token file must not be readable by other users');
  }

  // A restart reuses it, or every restart would invalidate every open cockpit.
  const second = resolveCockpitToken(file);
  assert.equal(second.source, 'file');
  assert.equal(second.token, first.token);
  assert.equal(readFileSync(file, 'utf8').trim(), first.token);
});

test('an empty token file is re-minted, and re-minting tightens its permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-token-'));
  const file = join(dir, 'cockpit-token');
  // A half-finished write from a killed boot — and world-readable, which is the
  // trap: `mode` applies only when a file is *created*, so writing into this one
  // would leave the fresh token readable by every user on the machine.
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

// ---------------------------------------------------------------------------
// The configuration that is never what anyone means.
// ---------------------------------------------------------------------------

test('binding a routable address with auth off is refused at config load', () => {
  assert.throws(
    () => loadConfig({ host: '0.0.0.0', auth: { enabled: false, tokenFile: '.lubbdubb/cockpit-token' } }),
    /Refusing to start/,
  );
  // Each half on its own is a supported choice.
  assert.doesNotThrow(() => loadConfig({ host: '0.0.0.0' }));
  assert.doesNotThrow(() => loadConfig({ auth: { enabled: false, tokenFile: '.lubbdubb/cockpit-token' } }));
});

test('auth.enabled survives a partial auth block in the config file', () => {
  // The deep-merge every other nested key gets: `{"auth": {"tokenFile": …}}`
  // must not read as "and disabled".
  const config = loadConfig({ auth: { tokenFile: 'somewhere/else' } as Config['auth'] });
  assert.equal(config.auth.enabled, true);
  assert.equal(config.auth.tokenFile, 'somewhere/else');
});

// ---------------------------------------------------------------------------
// The diagnosis. A refusal that says nothing is what let a `web/dist` built
// before the cockpit had token support 401 every request for an afternoon —
// server-side it is indistinguishable from a wrong token, and restarting the
// server and hard-refreshing the browser both leave it exactly as it was.
// ---------------------------------------------------------------------------

test('the first refusal of a run is recorded and names the credential channel', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);

  await app.inject({ method: 'GET', url: '/api/state' });
  const logged = system.store.listErrors().filter((e) => e.message.includes('cockpit refused'));
  assert.equal(logged.length, 1);
  // `none` is the whole diagnosis: the client sent nothing, so the token is not
  // the problem and no amount of re-copying it will help.
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

  // A locked-out cockpit polls, so recording every refusal would bury the first
  // under thousands of copies of itself.
  await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer hunter2' } });
  for (let i = 0; i < 5; i++) await app.inject({ method: 'GET', url: '/api/state' });

  const logged = system.store.listErrors().filter((e) => e.message.includes('cockpit refused'));
  assert.equal(logged.length, 1, 'only the first');
  assert.match(logged[0]?.detail ?? '', /credential=bearer/);
  assert.doesNotMatch(logged[0]?.detail ?? '', /hunter2/, 'the credential is described, never quoted');
  await app.close();
  system.store.close();
});

test('a present-but-unusable Authorization header is its own diagnosis', () => {
  // Folding this into `none` would send an operator hunting for a missing header
  // that is in fact being sent, with the wrong scheme.
  assert.match(describeAuthAttempt({ url: '/api/state', authorization: 'Token abc' }), /credential=malformed/);
  assert.match(describeAuthAttempt({ url: '/api/state' }), /credential=none/);
  assert.match(describeAuthAttempt({ url: '/ws?t=abc', queryToken: 'abc' }), /credential=query/);
  // A junk header does not invalidate a good `?t=` — the WebSocket's only channel.
  assert.match(
    describeAuthAttempt({ url: '/ws?t=abc', authorization: 'Token x', queryToken: 'abc' }),
    /credential=query/,
  );
});
