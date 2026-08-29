import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { hydrationMaxAgeMs, type ReadPlan } from '../src/world/readPlan.js';
import { HydrationCache } from '../src/integrations/hydrationCache.js';
import type { WorldSnapshot } from '../src/types.js';

/**
 * **Event-driven ingress** — the harness hearing about a review comment or a
 * finished build as it happens, from a webhook it did not have to poll for.
 *
 * What these hold, in the order the risk runs:
 *
 * - a delivery that is not verified is **refused**, and verification is over the
 *   raw bytes rather than a re-serialisation of them;
 * - a verified delivery invalidates **exactly** the entity it names — the whole
 *   reason stage 1's cache is per-entity;
 * - a deployment with no ingress secret is **unaffected in every respect**;
 * - and a flood of deliveries is not a flood of cycles.
 *
 * → `docs/spec/30-ingress.md`
 */

const SECRET = 'a-shared-webhook-secret';
const BASIC = 'hooks:s3cret';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    // Every cycle in this file is one the test asked for or one a delivery caused;
    // none is the timer's doing.
    heartbeatIntervalMs: 999_999,
    idleHeartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

/**
 * A system with the ingress secrets **stated**, not inherited. Without that the
 * endpoint is configured or not according to whether whoever runs the suite happens
 * to have a webhook wired up in their own environment — and `worktrees` is faked for
 * the standing reason: a cycle that dispatched would otherwise cut a real branch in
 * the checkout the suite is running in.
 */
function build(opts: { secrets?: { github?: string; azure?: string }; config?: Partial<Config> } = {}): System {
  return buildSystem(testConfig(opts.config), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    ingressSecrets: opts.secrets ?? { github: SECRET, azure: BASIC },
  });
}

/** The header GitHub sends: HMAC-SHA256 of the exact bytes, hex, behind `sha256=`. */
function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

/** Capture the plan the pulse hands the world read, by standing in front of it. */
function capturePlans(system: System): ReadPlan[] {
  const seen: ReadPlan[] = [];
  const connector = system.connector as { getState: (plan?: ReadPlan) => Promise<WorldSnapshot> };
  const original = connector.getState.bind(system.connector);
  connector.getState = async (plan?: ReadPlan): Promise<WorldSnapshot> => {
    if (plan !== undefined) seen.push(plan);
    return original(plan);
  };
  return seen;
}

interface Delivery {
  url: string;
  payload: string;
  event?: string;
  signature?: string;
  authorization?: string;
  deliveryId?: string;
}

async function post(app: Awaited<ReturnType<typeof buildApp>>['app'], d: Delivery) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (d.event) headers['x-github-event'] = d.event;
  if (d.signature) headers['x-hub-signature-256'] = d.signature;
  if (d.authorization) headers.authorization = d.authorization;
  if (d.deliveryId) headers['x-github-delivery'] = d.deliveryId;
  return app.inject({ method: 'POST', url: d.url, payload: d.payload, headers });
}

/** A `pull_request_review` delivery for one pull request — the smallest real thing GitHub sends. */
function reviewOf(number: number): string {
  return JSON.stringify({ action: 'submitted', pull_request: { number }, review: { state: 'commented' } });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test('a correctly signed GitHub delivery is accepted and a wrong or absent signature is refused', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const payload = reviewOf(7);

  const good = await post(app, {
    url: '/ingress/github',
    payload,
    event: 'pull_request_review',
    signature: sign(payload),
  });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json(), { accepted: 1 });

  // Every way of getting it wrong answers the same 401 — which arm was hit is not a
  // distinction an unauthenticated caller may be told.
  const wrong = [
    undefined,
    'sha256=deadbeef',
    sign(payload, 'the-wrong-secret'),
    // The right signature for a *different* body: the shape of a captured signature
    // pasted onto a forged payload.
    sign(reviewOf(9)),
    // A prefix that is not the scheme, and a bare hex digest with no prefix at all.
    `sha1=${sign(payload).slice(7)}`,
    sign(payload).slice(7),
  ];
  for (const signature of wrong) {
    const res = await post(app, { url: '/ingress/github', payload, event: 'pull_request_review', signature });
    assert.equal(res.statusCode, 401, `signature ${String(signature).slice(0, 20)}… should have been refused`);
    assert.deepEqual(res.json(), { error: 'the delivery carried no valid credential' });
  }

  await app.close();
  system.store.close();
});

test('the signature is checked over the raw bytes, so a payload that does not round-trip still verifies', async () => {
  // `JSON.stringify(JSON.parse(x))` is not `x`: this body has a comment with an
  // emoji, a float, and keys in an order `stringify` would not reproduce from the
  // parsed value. A signature checked against a re-serialised body fails here and
  // nowhere in the tests that use ASCII — which is the whole reason this one exists.
  const payload = '{"pull_request":{"number":7},"action":"submitted","note":"ship it 🚢","score":1.50}';
  assert.notEqual(JSON.stringify(JSON.parse(payload)), payload, 'the fixture must not round-trip');

  const system = build();
  const { app } = await buildApp(system);
  const res = await post(app, {
    url: '/ingress/github',
    payload,
    event: 'pull_request_review',
    signature: sign(payload),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accepted: 1 });

  await app.close();
  system.store.close();
});

test('an Azure delivery is accepted on its basic credential and refused without it', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const payload = JSON.stringify({ eventType: 'git.pullrequest.updated', resource: { pullRequestId: 12 } });
  const ok = `Basic ${Buffer.from(BASIC, 'utf8').toString('base64')}`;

  const good = await post(app, { url: '/ingress/azure', payload, authorization: ok });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json(), { accepted: 1 });

  const wrong = [
    undefined,
    'Basic',
    `Basic ${Buffer.from('hooks:wrong', 'utf8').toString('base64')}`,
    // Not base64 of anything, and the credential in the clear — the two shapes a
    // hand-written client gets wrong.
    `Basic ${BASIC}`,
    `Bearer ${Buffer.from(BASIC, 'utf8').toString('base64')}`,
  ];
  for (const authorization of wrong) {
    const res = await post(app, { url: '/ingress/azure', payload, authorization });
    assert.equal(res.statusCode, 401, `authorization ${String(authorization)} should have been refused`);
  }

  await app.close();
  system.store.close();
});

test('a refused delivery is not a harness fault, and only the first of a run is recorded', async () => {
  // This port is reachable by anyone, so recording every refusal hands a stranger the
  // ability to fill the operator's Errors panel.
  const recorded: string[] = [];
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: (entry) => recorded.push(entry.message),
    ingressSecrets: { github: SECRET },
  });
  const { app } = await buildApp(system);
  const payload = reviewOf(7);

  for (let i = 0; i < 5; i++) {
    const res = await post(app, { url: '/ingress/github', payload, event: 'pull_request_review' });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(recorded.length, 1, 'exactly one row, however many refusals arrive');
  assert.match(recorded[0] ?? '', /inbound github delivery was refused/);

  // A body that is not JSON at all is the framework's refusal, and is recorded by
  // nobody — the same property `test/requestValidation.test.ts` holds for every other
  // route, on the one route where the caller is a stranger.
  for (const bad of ['{"pull_request":', '', '[]', '"a string"']) {
    const res = await post(app, {
      url: '/ingress/github',
      payload: bad,
      event: 'pull_request_review',
      signature: sign(bad),
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} should be a 400`);
  }
  assert.equal(recorded.length, 1, 'a malformed body is the caller’s fault, not the harness’s');

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// What a delivery invalidates
// ---------------------------------------------------------------------------

test('a delivery invalidates exactly the entity it names, and nothing else', async () => {
  // The debounce is parked so the trigger's own cycle never runs here: what is under
  // test is the plan the *next* read is built with, not when it happens.
  const system = build({ config: { ingress: { debounceMs: 999_999 } } as Partial<Config> });
  const plans = capturePlans(system);
  const { app } = await buildApp(system);

  const payload = reviewOf(7);
  const res = await post(app, {
    url: '/ingress/github',
    payload,
    event: 'pull_request_review',
    signature: sign(payload),
  });
  assert.equal(res.statusCode, 200);

  await system.harness.runCycle('manual');
  const plan = plans.at(-1);
  assert.ok(plan, 'the pulse built a read plan');
  assert.deepEqual([...(plan.fresh ?? [])], ['pr:7'], 'exactly the entity the delivery named');

  // And that is what the integrations are actually asked with: zero for the named
  // entity, the lane's own number for everything else. Zero is always past, so the
  // hydration cache drops that one entry — see the unit below.
  assert.equal(hydrationMaxAgeMs(plan, 'pr:7'), 0);
  assert.notEqual(hydrationMaxAgeMs(plan, 'pr:8'), 0);
  assert.notEqual(hydrationMaxAgeMs(plan, 'issue:7'), 0);

  // Drained by the read that used it: the next pulse invalidates nothing.
  await system.harness.runCycle('manual');
  assert.deepEqual([...(plans.at(-1)?.fresh ?? [])], []);

  await app.close();
  system.store.close();
});

test('an age bound of zero drops that one cache entry and leaves its neighbours', () => {
  // The mechanism the plan above relies on, held here rather than inferred: this is
  // the whole of "drop that entity's hydration".
  let now = 1_000;
  const cache = new HydrationCache<string>(() => now);
  cache.set(7, 'seven');
  cache.set(8, 'eight');
  now += 10;

  assert.equal(cache.get(7, 0), undefined, 'zero is always past');
  assert.equal(cache.get(8, 60_000), 'eight', 'and it touched nothing else');
  // Dropped rather than merely skipped, so the next read on any lane re-hydrates it.
  assert.equal(cache.get(7, 60_000), undefined);
});

test('each event kind names the entity it is actually about', async () => {
  const system = build({ config: { ingress: { debounceMs: 999_999 } } as Partial<Config> });
  const plans = capturePlans(system);
  const { app } = await buildApp(system);

  const azure = `Basic ${Buffer.from(BASIC, 'utf8').toString('base64')}`;
  const cases: { name: string; url: string; event?: string; body: unknown; refs: string[] }[] = [
    {
      name: 'pull_request',
      url: '/ingress/github',
      event: 'pull_request',
      body: { number: 3, pull_request: { number: 3 } },
      refs: ['pr:3'],
    },
    {
      name: 'review comment',
      url: '/ingress/github',
      event: 'pull_request_review_comment',
      body: { pull_request: { number: 4 } },
      refs: ['pr:4'],
    },
    { name: 'issues', url: '/ingress/github', event: 'issues', body: { issue: { number: 5 } }, refs: ['issue:5'] },
    // The one that has to be read carefully: GitHub numbers issues and pull requests
    // out of one sequence and delivers a comment on either as `issue_comment`.
    {
      name: 'comment on an issue',
      url: '/ingress/github',
      event: 'issue_comment',
      body: { issue: { number: 6 } },
      refs: ['issue:6'],
    },
    {
      name: 'comment on a pull request',
      url: '/ingress/github',
      event: 'issue_comment',
      body: { issue: { number: 6, pull_request: { url: 'https://api.github.com/…' } } },
      refs: ['pr:6'],
    },
    {
      name: 'check_suite',
      url: '/ingress/github',
      event: 'check_suite',
      body: { check_suite: { pull_requests: [{ number: 10 }, { number: 11 }, { number: 10 }] } },
      refs: ['pr:10', 'pr:11'],
    },
    // A fork's check names no pull request at all — the known blind spot, and it must
    // be a no-op rather than anything louder.
    {
      name: 'check_suite from a fork',
      url: '/ingress/github',
      event: 'check_suite',
      body: { check_suite: { pull_requests: [] } },
      refs: [],
    },
    { name: 'push', url: '/ingress/github', event: 'push', body: { ref: 'refs/heads/main' }, refs: [] },
    {
      name: 'ping',
      url: '/ingress/github',
      event: 'ping',
      body: { zen: 'Anything added dilutes everything else.' },
      refs: [],
    },
    {
      name: 'azure pull request',
      url: '/ingress/azure',
      body: { eventType: 'git.pullrequest.merged', resource: { pullRequestId: 21 } },
      refs: ['pr:21'],
    },
    {
      name: 'azure pull-request comment',
      url: '/ingress/azure',
      body: {
        eventType: 'ms.vss-code.git-pullrequest-comment-event',
        resource: { pullRequest: { pullRequestId: 22 } },
      },
      refs: ['pr:22'],
    },
    {
      name: 'azure work item',
      url: '/ingress/azure',
      body: { eventType: 'workitem.updated', resource: { id: 23 } },
      refs: ['issue:23'],
    },
    // Azure's build event carries no id — the number is in the branch it validated.
    {
      name: 'azure validation build',
      url: '/ingress/azure',
      body: { eventType: 'build.complete', resource: { sourceBranch: 'refs/pull/24/merge' } },
      refs: ['pr:24'],
    },
    {
      name: 'azure build on a normal branch',
      url: '/ingress/azure',
      body: { eventType: 'build.complete', resource: { sourceBranch: 'refs/heads/main' } },
      refs: [],
    },
  ];

  for (const c of cases) {
    const payload = JSON.stringify(c.body);
    const res = await post(app, {
      url: c.url,
      payload,
      event: c.event,
      signature: c.url.endsWith('github') ? sign(payload) : undefined,
      authorization: c.url.endsWith('azure') ? azure : undefined,
      // A fresh id each time, so the replay ledger never speaks for the mapping.
      deliveryId: `d-${c.name}`,
    });
    assert.equal(res.statusCode, 200, c.name);
    assert.deepEqual(res.json(), { accepted: c.refs.length }, c.name);

    await system.harness.runCycle('manual');
    assert.deepEqual([...(plans.at(-1)?.fresh ?? [])].sort(), [...c.refs].sort(), c.name);
  }

  await app.close();
  system.store.close();
});

test('a payload field naming an entity is never trusted as one', async () => {
  const system = build({ config: { ingress: { debounceMs: 999_999 } } as Partial<Config> });
  const plans = capturePlans(system);
  const { app } = await buildApp(system);

  // Every one of these is a verified delivery: the signature proves who wrote the
  // bytes and says nothing whatever about what is in them.
  const junk = [
    { pull_request: { number: -1 } },
    { pull_request: { number: 0 } },
    { pull_request: { number: 1.5 } },
    { pull_request: { number: 1e300 } },
    { pull_request: { number: '7' } },
    { pull_request: { number: null } },
    { pull_request: 7 },
    { pull_request: { number: { toString: 'no' } } },
    {},
  ];
  for (const body of junk) {
    const payload = JSON.stringify(body);
    const res = await post(app, {
      url: '/ingress/github',
      payload,
      event: 'pull_request_review',
      signature: sign(payload),
    });
    assert.equal(res.statusCode, 200, payload);
    assert.deepEqual(res.json(), { accepted: 0 }, payload);
  }

  // One delivery may name at most sixteen entities, however many it claims.
  const many = JSON.stringify({
    check_suite: { pull_requests: Array.from({ length: 500 }, (_, i) => ({ number: i + 1 })) },
  });
  const flood = await post(app, { url: '/ingress/github', payload: many, event: 'check_suite', signature: sign(many) });
  assert.deepEqual(flood.json(), { accepted: 16 });

  await system.harness.runCycle('manual');
  assert.equal((plans.at(-1)?.fresh ?? new Set()).size, 16, 'and no more than that reaches the read plan');

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// An unconfigured deployment
// ---------------------------------------------------------------------------

test('a deployment with no ingress secret is unaffected in every respect', async () => {
  const system = build({ secrets: {} });
  const plans = capturePlans(system);
  const cycles: string[] = [];
  system.harness.on('cycle:start', ({ source }) => cycles.push(source));
  const { app } = await buildApp(system);

  const payload = reviewOf(7);
  for (const url of ['/ingress/github', '/ingress/azure']) {
    const res = await post(app, {
      url,
      payload,
      event: 'pull_request_review',
      signature: sign(payload),
      authorization: `Basic ${Buffer.from(BASIC, 'utf8').toString('base64')}`,
    });
    // 404 rather than "ingress disabled": what this path answered before the endpoint
    // existed, and an endpoint that named the providers it listens for would be
    // telling an unauthenticated caller something it has no reason to.
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { error: 'not found' }, url);
  }

  // Nothing was marked and nothing fired. Generously past the default debounce.
  await tick(60);
  await system.harness.runCycle('manual');
  assert.deepEqual([...(plans.at(-1)?.fresh ?? [])], []);
  assert.deepEqual(cycles, ['manual'], 'no cycle but the one this test asked for');
  // And the lanes decide alone, exactly as they did before any of this existed.
  assert.equal(hydrationMaxAgeMs(plans.at(-1), 'pr:7'), system.config.hotReadMaxAgeMs);

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// What a delivery is allowed to cost
// ---------------------------------------------------------------------------

test('a flood of deliveries is not a flood of cycles', async () => {
  // A short debounce so the test does not wait, and a floor far longer than the test
  // runs — which is the point: whatever arrives after the first cycle waits for it.
  const system = build({ config: { ingress: { debounceMs: 20, minCycleGapMs: 600_000 } } as Partial<Config> });
  const cycles: string[] = [];
  system.harness.on('cycle:start', ({ source }) => cycles.push(source));
  const { app } = await buildApp(system);

  for (let i = 1; i <= 40; i++) {
    const payload = reviewOf(i);
    const res = await post(app, {
      url: '/ingress/github',
      payload,
      event: 'pull_request_review',
      signature: sign(payload),
      deliveryId: `flood-${i}`,
    });
    assert.equal(res.statusCode, 200);
  }
  await tick(120);
  assert.deepEqual(cycles, ['ingress'], 'forty deliveries, one cycle');

  // A further burst inside the floor buys nothing more, and — the half that matters —
  // is *held* rather than dropped: the trigger still has a pending fire.
  for (let i = 41; i <= 60; i++) {
    const payload = reviewOf(i);
    await post(app, {
      url: '/ingress/github',
      payload,
      event: 'pull_request_review',
      signature: sign(payload),
      deliveryId: `flood-${i}`,
    });
  }
  await tick(120);
  assert.deepEqual(cycles, ['ingress'], 'the floor holds the second burst');

  system.ingressCycles.stop();
  await app.close();
  system.store.close();
});

test('a replayed delivery is accepted and does nothing', async () => {
  const system = build({ config: { ingress: { debounceMs: 999_999 } } as Partial<Config> });
  const plans = capturePlans(system);
  const { app } = await buildApp(system);
  const payload = reviewOf(7);
  const delivery = {
    url: '/ingress/github',
    payload,
    event: 'pull_request_review',
    signature: sign(payload),
    deliveryId: 'once',
  };

  assert.deepEqual((await post(app, delivery)).json(), { accepted: 1 });
  // The same bytes and the same signature verify again — nothing in the signed
  // material is a timestamp — so the id is the only thing that tells them apart.
  assert.deepEqual((await post(app, delivery)).json(), { accepted: 0 });

  await system.harness.runCycle('manual');
  assert.deepEqual([...(plans.at(-1)?.fresh ?? [])], ['pr:7']);

  await app.close();
  system.store.close();
});

test('the endpoint’s own rate limit is spent by the endpoint, not by the caller', async () => {
  // Keyed to the route rather than to `req.ip`: a webhook arrives from a provider's
  // whole address range, and per-caller keying on a public port is a budget an
  // attacker multiplies by changing address. `inject` presents one address, so what
  // this holds is that the budget is finite and shared.
  const system = build({ config: { ingress: { requestsPerMinute: 3, debounceMs: 999_999 } } as Partial<Config> });
  const { app } = await buildApp(system);
  const payload = reviewOf(7);

  const codes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await post(app, {
      url: '/ingress/github',
      payload,
      event: 'pull_request_review',
      signature: sign(payload),
    });
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.deepEqual(codes.slice(3), [429, 429, 429], 'the budget is the endpoint’s and it runs out');

  await app.close();
  system.store.close();
});

test('a body larger than the configured bound is refused before it is read', async () => {
  const system = build({ config: { ingress: { maxBodyBytes: 2_048 } } as Partial<Config> });
  const { app } = await buildApp(system);
  const payload = JSON.stringify({ pull_request: { number: 7 }, pad: 'x'.repeat(4_096) });

  const res = await post(app, {
    url: '/ingress/github',
    payload,
    event: 'pull_request_review',
    signature: sign(payload),
  });
  assert.equal(res.statusCode, 413);

  await app.close();
  system.store.close();
});
