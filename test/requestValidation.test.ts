import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
    dispatcher: 'rule',
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
  const pr = await app.inject({ method: 'POST', url: '/api/prs/abc/exclude', payload: { excluded: true } });
  assert.equal(pr.statusCode, 400);
  assert.deepEqual(pr.json(), { error: 'invalid PR number' });

  await app.close();
  system.store.close?.();
});

test('a route that answers off the store still does so before reading its body', async () => {
  const system = build();
  const { app } = await buildApp(system);

  // Promote reads the finding first: one that does not exist is a 404 whatever
  // the body says, which is the order the hand-written route answered in.
  const missing = await app.inject({
    method: 'POST',
    url: '/api/findings/nope/promote',
    payload: { kind: 'nonsense' },
  });
  assert.equal(missing.statusCode, 404);

  const { finding } = system.store.recordFinding('a1', 't1', 'issue:12', {
    kind: 'duplicate',
    ref: 'issue:41',
    summary: 'same as #41',
  });
  const badBody = await app.inject({
    method: 'POST',
    url: `/api/findings/${finding.id}/promote`,
    payload: { kind: 'nonsense' },
  });
  assert.equal(badBody.statusCode, 400);
  assert.deepEqual(badBody.json(), { error: "kind must be 'code' or 'desk'" });

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

test('/api/inject checks the payload its kind implies, not just that a kind is present', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const good = await app.inject({
    method: 'POST',
    url: '/api/inject',
    payload: { kind: 'new_pr', number: 7, title: 'a PR', branch: 'feature/7' },
  });
  assert.equal(good.statusCode, 200);

  // A known kind missing the fields it names used to reach the connector typed as
  // though it carried them.
  for (const payload of [{}, { kind: 'no_such_kind' }, { kind: 'ci_failed' }, { kind: 'ci_failed', prNumber: 'x' }]) {
    const res = await app.inject({ method: 'POST', url: '/api/inject', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }

  await app.close();
  system.store.close?.();
});

test('no route reads req.params or req.body through a type assertion', () => {
  // The claim the whole change rests on: an `as` on request input types every
  // field a handler then reads as though something validated it. Asserted on the
  // source rather than intended, so the 45th route cannot quietly reintroduce one.
  //
  // `req.query` is deliberately out of scope: both of its two sites assert the
  // value to `unknown` and test its type before use, so the assertion claims
  // nothing about the data.
  const source = readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const assertions = [...source.matchAll(/req\.(params|body)[^\n]*\bas\b/g)].map((m) => m[0]);
  assert.deepEqual(assertions, [], 'read these through readRequest and a zod schema instead');
});
