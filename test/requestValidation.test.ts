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

// Issue #223 — the REST surface reads its params and body through zod rather than
// asserting them. These cover the seam itself, the wordings the routes lost when
// their hand-written checks went, and the two orderings a route depends on.

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
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

  // A body-only route leaves `params` undefined rather than parsing something
  // nobody asked about.
  const bodyOnly = readRequest({ params: { id: 'a1' }, body: {} }, { body: Body });
  assert.equal(bodyOnly.ok && bodyOnly.params, undefined);

  // Params before body: a request naming no such item is refused for *that*,
  // whatever else its body got wrong.
  const bad = readRequest({ params: { number: 'abc' }, body: { note: 7 } }, { params: IssueNumberParams, body: Body });
  assert.deepEqual(bad, { ok: false, error: 'invalid issue number' });
});

test('a missing body is read as an empty one, so an all-optional body may be omitted', () => {
  const Body = z.object({ note: optionalText('note') });
  const absent = readRequest({ params: {} }, { body: Body });
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.ok && absent.body, {});

  // …but a required field still refuses by name rather than by "Required".
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
    // A half the caller declared no schema for reads back undefined — the same
    // answer `params` gives here, and what the generic defaults to.
    query: undefined,
  });
  // Blank and absent are one state — every route taking one falls back to its own
  // default for both.
  assert.equal(readRequest({ body: { summary: '   ' } }, { body: Body }).ok, true);
  const blank = readRequest({ body: { summary: '   ' } }, { body: Body });
  assert.equal(blank.ok && blank.body.summary, undefined);
  // The deliberate tightening: a field the caller clearly meant to set is no
  // longer silently ignored.
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
    { url: '/api/issues/abc/assay', payload: { verdict: 'workable' } },
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
  // The content-type parser refuses before any handler runs, so `checked` never
  // sees these — the property it holds has to be held by the error handler too.
  // A 500 here would tell the caller to retry a request it will never fix, and
  // put a row in the Errors panel for every truncated body on the port.
  const recorded: string[] = [];
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: (entry) => recorded.push(entry.message),
  });
  const { app } = await buildApp(system);
  // Registered before the first inject, which is what makes the instance listen.
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

  // A genuine route throw still is one, which is the distinction the handler draws.
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

  // The exit route reads the claim first: one that does not exist is a 404 whatever
  // the body says, which is the order the route it replaced answered in.
  const missing = await app.inject({
    method: 'POST',
    url: '/api/knowledge/facts/nope/exit',
    payload: { exit: 'nonsense' },
  });
  assert.equal(missing.statusCode, 404);

  const raised = system.store.proposeFact(
    {
      claim: 'same as #41',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'both describe the same rate limiter',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: 'issue:41',
      where: null,
    },
    { agentId: 'a1', taskId: 't1', goalRef: 'issue:12', sessionId: null, words: 'seen once' },
  );
  assert.ok(raised.outcome !== 'barred');
  const badBody = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${raised.fact.id}/exit`,
    payload: { exit: 'nonsense' },
  });
  assert.equal(badBody.statusCode, 400);
  assert.match((badBody.json() as { error: string }).error, /exit must be one of docs/);

  await app.close();
  system.store.close?.();
});

test('the shortfall route keeps an absent cause and an explicit null apart', async () => {
  const system = build();
  const { app } = await buildApp(system);

  // Absent: an unplanned issue that simply is not finished names no cause.
  const recorded = await app.inject({ method: 'POST', url: '/api/issues/12/shortfall', payload: {} });
  assert.equal(recorded.statusCode, 200);
  assert.equal(recorded.json().shortfall.cause, null);
  assert.ok(system.store.getShortfall('issue:12'));

  // Explicit null: the same value in JSON, the opposite act.
  const cleared = await app.inject({ method: 'POST', url: '/api/issues/12/shortfall', payload: { cause: null } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().shortfall, null);
  assert.equal(system.store.getShortfall('issue:12'), null);

  // The one cross-field rule on this surface.
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
  // The claim the whole change rests on: an `as` on request input types every
  // field a handler then reads as though something validated it. Asserted on the
  // source rather than intended, so the 45th route cannot quietly reintroduce one.
  //
  // Since #237 this walks `src/server/routes/` plus the two files that still hold
  // request-reading code (`app.ts`'s auth hook, `validation.ts` itself), so a
  // route group added as a new module is covered on the day it is written.
  //
  // `req.query`'s two remaining sites (the artifact routes) assert the value to
  // `unknown` and test its type before use, so the assertion claims nothing about
  // the data. Since #329 a query string can be *declared* instead — `checked`
  // takes a `query` schema — and a route whose parameters are filters should:
  // those are the half an operator hand-edits in the address bar, so they are the
  // half that most wants validating.
  const assertions = routeSources().flatMap(([file, source]) =>
    [...source.matchAll(/req\.(params|body)[^\n]*\bas\b/g)].map((m) => `${file}: ${m[0]}`),
  );
  assert.deepEqual(assertions, [], 'read these through readRequest and a zod schema instead');
});

test('no route reads a request itself — every one takes checked input', () => {
  // The half of #223 that used to be held by nothing but this file's own grep
  // (issue #237). A handler *handed* `params` and `body` has no raw request to
  // assert about and no `if (!input.ok)` to forget, which is why the 36 verbatim
  // copies of the 400 line are gone: `checked` is the only caller of
  // `readRequest` left, so the refusal path is one path by construction rather
  // than by 36 correct repetitions.
  //
  // A route that needs the body read *after* a 404/409 (`/api/findings/:id/*`,
  // `/api/work/:ref/file`) applies `checked` by hand a second time rather than
  // reaching past it, so those are covered by this too.
  const callers = routeSources()
    .filter(([, source]) => /\breadRequest\(/.test(source))
    .map(([file]) => file);
  assert.deepEqual(callers, [], 'wrap the handler in `checked` instead of reading the request');
});

/** Every source that declares a route, as `[name relative to src/server/, text]`. */
function routeSources(): [string, string][] {
  const server = new URL('../src/server/', import.meta.url);
  const files = ['app.ts'];
  for (const entry of readdirSync(new URL('routes/', server)).sort()) {
    if (entry.endsWith('.ts')) files.push(`routes/${entry}`);
  }
  return files.map((file) => [file, readFileSync(new URL(file, server), 'utf8')]);
}
