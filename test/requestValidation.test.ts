import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { IdParams, IssueNumberParams, optionalText, readRequest, requiredBoolean } from '../src/server/validation.js';
import { z } from 'zod';
import { repoPath } from './support/paths.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

test('readRequest parses only the halves a route declares, params first', () => {
  const Body = z.object({ note: optionalText('note') });
  const both = readRequest({ params: { id: 'a1' }, body: { note: '  hi  ' } }, { params: IdParams, body: Body });
  assert.equal(both.ok, true);
  assert.deepEqual(both.ok && both.params, { id: 'a1' });
  assert.deepEqual(both.ok && both.body, { note: 'hi' });

  const bodyOnly = readRequest({ params: { id: 'a1' }, body: {} }, { body: Body });
  assert.equal(bodyOnly.ok && bodyOnly.params, undefined);

  const bad = readRequest({ params: { number: 'abc' }, body: { note: 7 } }, { params: IssueNumberParams, body: Body });
  assert.deepEqual(bad, { ok: false, error: 'invalid issue number' });
});

test('a missing body is read as an empty one, so an all-optional body may be omitted', () => {
  const Body = z.object({ note: optionalText('note') });
  const absent = readRequest({ params: {} }, { body: Body });
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.ok && absent.body, {});

  const required = readRequest({}, { body: z.object({ ok: requiredBoolean('ok must be a boolean') }) });
  assert.deepEqual(required, { ok: false, error: 'ok must be a boolean' });
});

test('requiredBoolean words absence and a wrong type identically', () => {
  const Body = z.object({ excluded: requiredBoolean('excluded must be a boolean') });
  for (const body of [{}, { excluded: 'yes' }, { excluded: null }]) {
    const read = readRequest({ body }, { body: Body });
    assert.deepEqual(read, { ok: false, error: 'excluded must be a boolean' }, JSON.stringify(body));
  }
});

test('optional text trims, reads blank as absent, and refuses a non-string by name', () => {
  const Body = z.object({ summary: optionalText('summary') });
  assert.deepEqual(readRequest({ body: { summary: '  done  ' } }, { body: Body }), {
    ok: true,
    params: undefined,
    body: { summary: 'done' },
    query: undefined,
  });
  assert.equal(readRequest({ body: { summary: '   ' } }, { body: Body }).ok, true);
  const blank = readRequest({ body: { summary: '   ' } }, { body: Body });
  assert.equal(blank.ok && blank.body.summary, undefined);
  assert.deepEqual(readRequest({ body: { summary: 12 } }, { body: Body }), {
    ok: false,
    error: 'summary must be a string',
  });
});

test('the number-param routes refuse a non-numeric path, each in its own words', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const issueRoutes = [
    { url: '/api/issues/abc/watch', payload: { watched: true } },
    { url: '/api/issues/abc/conclusion', payload: { verdict: 'done' } },
    { url: '/api/issues/abc/appraisal', payload: { verdict: 'workable' } },
    { url: '/api/issues/abc/delivered', payload: { delivered: true } },
    { url: '/api/issues/abc/shortfall', payload: { cause: 'goal' } },
    { url: '/api/issues/abc/dismiss-run', payload: {} },
  ];
  for (const route of issueRoutes) {
    const res = await app.inject({ method: 'POST', url: route.url, payload: route.payload });
    assert.equal(res.statusCode, 400, route.url);
    assert.deepEqual(res.json(), { error: 'invalid issue number' }, route.url);
  }
  const pr = await app.inject({ method: 'POST', url: '/api/prs/abc/watch', payload: { watched: true } });
  assert.equal(pr.statusCode, 400);
  assert.deepEqual(pr.json(), { error: 'invalid PR number' });

  await app.close();
  system.store.close?.();
});

test('a body that is not JSON is refused 400, and is nobody’s fault but the caller’s', async () => {
  const recorded: string[] = [];
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: (entry) => recorded.push(entry.message),
  });
  const { app } = await buildApp(system);
  app.post('/api/boom', async () => {
    throw new Error('the harness broke');
  });

  const routes = [
    { method: 'POST' as const, url: '/api/issues/12/watch' },
    { method: 'DELETE' as const, url: '/api/work/issue:12/ignore' },
  ];
  for (const route of routes) {
    for (const payload of ['{"watched":', '']) {
      const res = await app.inject({
        ...route,
        payload,
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(res.statusCode, 400, `${route.method} ${route.url} with ${JSON.stringify(payload)}`);
    }
  }
  assert.deepEqual(recorded, [], 'a malformed request is not a harness fault');

  const boom = await app.inject({ method: 'POST', url: '/api/boom', payload: {} });
  assert.equal(boom.statusCode, 500);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0] ?? '', /POST \/api\/boom failed: the harness broke/);

  await app.close();
  system.store.close?.();
});

test('a route that answers off the store still does so before reading its body', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const missing = await app.inject({
    method: 'POST',
    url: '/api/work/pr:404/file',
    payload: { title: 42 },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as { error: string }).error, 'no such work item');

  await app.close();
  system.store.close();
});

test('the shortfall route keeps an absent cause and an explicit null apart', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const recorded = await app.inject({ method: 'POST', url: '/api/issues/12/shortfall', payload: {} });
  assert.equal(recorded.statusCode, 200);
  assert.equal(recorded.json().shortfall.cause, null);
  assert.ok(system.store.verdicts.getShortfall('issue:12'));

  const cleared = await app.inject({ method: 'POST', url: '/api/issues/12/shortfall', payload: { cause: null } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().shortfall, null);
  assert.equal(system.store.verdicts.getShortfall('issue:12'), null);

  const noSlug = await app.inject({ method: 'POST', url: '/api/issues/12/shortfall', payload: { cause: 'part' } });
  assert.equal(noSlug.statusCode, 400);
  assert.deepEqual(noSlug.json(), { error: 'cause "part" needs the part slug in `part`' });

  const badCause = await app.inject({ method: 'POST', url: '/api/issues/12/shortfall', payload: { cause: 'vibes' } });
  assert.equal(badCause.statusCode, 400);
  assert.deepEqual(badCause.json(), { error: 'cause must be null or one of plan, part, goal' });

  await app.close();
  system.store.close?.();
});

test('no route reads req.params or req.body through a type assertion', () => {
  const assertions = routeSources().flatMap(([file, source]) =>
    [...source.matchAll(/req\.(params|body)[^\n]*\bas\b/g)].map((m) => `${file}: ${m[0]}`),
  );
  assert.deepEqual(assertions, [], 'read these through readRequest and a zod schema instead');
});

test('no route reads a request itself — every one takes checked input', () => {
  const callers = routeSources()
    .filter(([, source]) => /\breadRequest\(/.test(source))
    .map(([file]) => file);
  assert.deepEqual(callers, [], 'wrap the handler in `checked` instead of reading the request');
});

const STOCK = /^(Required|Expected |Invalid enum value|Invalid discriminator|String must|Number must|Array must)/;

const JUNK: Record<string, unknown> = {
  state: 1,
  slug: 1,
  criterion: 1,
  ref: 1,
  note: 1,
  until: 1,
  reason: 1,
  title: 1,
  prompt: 1,
  claim: 1,
  bar: 1,
  response: 1,
  answers: [1],
  met: 'yes',
  interrupt: 'yes',
  resolution: 'zzz',
  target: 'zzz',
  kind: 'zzz',
  exit: 'zzz',
  result: 'zzz',
  to: 'zzz',
  reach: 'zzz',
  outcome: 'zzz',
  cause: 'zzz',
  action: 'zzz',
};

test('no route refuses in zod stock text — every field states its own refusal', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const stock: string[] = [];
  for (const url of writeRoutes()) {
    for (const payload of [{}, JUNK]) {
      for (const method of ['POST', 'DELETE'] as const) {
        const res = await app.inject({ method, url, payload });
        if (res.statusCode !== 400) continue;
        const { error } = res.json() as { error: string };
        for (const message of error.split('; ')) if (STOCK.test(message)) stock.push(`${method} ${url} :: ${message}`);
      }
    }
  }
  assert.deepEqual(stock, [], 'give each of these fields a message that names it');

  const filters = [
    'watch=maybe',
    'tracking=zzz',
    'order=random',
    'state=' + 'x'.repeat(81),
    'feature=' + 'x'.repeat(21),
    'cursor=' + 'x'.repeat(65),
  ];
  for (const filter of filters) {
    const res = await app.inject({ method: 'GET', url: `/api/tickets?${filter}` });
    assert.equal(res.statusCode, 400, `?${filter} should refuse`);
    const { error } = res.json() as { error: string };
    assert.ok(!STOCK.test(error), `?${filter} refuses in zod's words: ${error}`);
    assert.ok(error.startsWith(filter.split('=')[0] ?? ''), `?${filter} must name its parameter: ${error}`);
  }

  await app.close();
  system.store.close?.();
});

function writeRoutes(): string[] {
  const urls = new Set<string>();
  for (const [, source] of routeSources()) {
    for (const m of source.matchAll(/app\.(?:post|delete)\(\s*\n?\s*'([^']+)'/g)) {
      const path = m[1];
      if (path === undefined) continue;
      urls.add(path.replace(/:(\w+)/g, (_, name: string) => (name === 'number' ? '12' : 'zzz')));
    }
  }
  return [...urls].sort();
}

function routeSources(): [string, string][] {
  const server = repoPath('src/server');
  const files = ['app.ts'];
  for (const entry of readdirSync(join(server, 'routes')).sort()) {
    if (entry.endsWith('.ts')) files.push(`routes/${entry}`);
  }
  return files.map((file) => [file, readFileSync(join(server, file), 'utf8')]);
}

test('the validation routes refuse a missing account by naming the field each one takes', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const routes = [
    { verb: 'result', field: 'note', payload: { result: 'failed' } },
    { verb: 'defer', field: 'reason', payload: {} },
    { verb: 'waive', field: 'reason', payload: {} },
  ];
  for (const route of routes) {
    const url = `/api/issues/12/validation/a-check/${route.verb}`;
    for (const payload of [route.payload, { ...route.payload, [route.field]: '   ' }]) {
      const res = await app.inject({ method: 'POST', url, payload });
      assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
      const { error } = res.json() as { error: string };
      assert.ok(error.startsWith(`${route.field} is required`), `${url} refuses by naming ${route.field}: ${error}`);
    }
    const accepted = await app.inject({
      method: 'POST',
      url,
      payload: { ...route.payload, [route.field]: 'it is waiting on the staging rebuild' },
    });
    assert.equal(accepted.statusCode, 409, `${url} passes validation once ${route.field} is given`);
  }

  await app.close();
  system.store.close?.();
});
