import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { deliveryHold } from '../src/delivery/delivery.js';
import { issueOriginRef } from '../src/issueOrigins.js';
import type { CockpitState } from '../src/wire.js';
import type { GoalCriteriaVersion, Issue } from '../src/types.js';
import { seedProposedPlan } from './support/revealGate.js';

// → docs/spec/16-http-api.md

interface Harness {
  system: System;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  close: () => Promise<void>;
}

async function harness(enabled: boolean): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-criteria-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    userId: 'operator',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    prediction: { enabled: false },
    goalCriteria: { enabled },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  return {
    system,
    app,
    close: async () => {
      await app.close();
      system.store.close();
    },
  };
}

function post(
  h: Harness,
  number: number,
  body: Record<string, string>,
): Promise<{ statusCode: number; json: () => never }> {
  return h.app.inject({ method: 'POST', url: `/api/goals/${number}/criteria`, payload: body }) as never;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 4));
}

function dispatchPart(h: Harness, number: number): void {
  h.system.store.tasks.createTask({
    kind: 'code',
    title: 'part one',
    prompt: 'p',
    branch: `feat/${number}`,
    originRef: issueOriginRef('part', number, 'whole'),
  });
}

test('the three standings derive through the route at each boundary', async () => {
  const h = await harness(true);
  try {
    seedProposedPlan(h.system, 41);
    const ref = issueOriginRef('root', 41);

    // Every stamp here is `new Date().toISOString()` at millisecond resolution, and
    // the whole sitting fits inside one millisecond — so the boundaries have to be
    // put a real instant apart for the derivation to have anything to derive against.
    assert.equal((await post(h, 41, { text: 'before anything' })).statusCode, 200);
    await tick();

    h.system.predictions.recordReveal(ref);
    await tick();
    assert.equal((await post(h, 41, { text: 'after reading the plan' })).statusCode, 200);
    await tick();

    dispatchPart(h, 41);
    await tick();
    assert.equal(
      (await post(h, 41, { text: 'after work started', reason: 'the ticket was ambiguous' })).statusCode,
      200,
    );

    const read = await h.app.inject({ method: 'GET', url: '/api/goals/41/criteria' });
    assert.equal(read.statusCode, 200);
    const body = read.json() as {
      current: GoalCriteriaVersion & { standing: string };
      versions: (GoalCriteriaVersion & { standing: string })[];
    };
    assert.deepEqual(
      body.versions.map((v) => v.standing),
      ['pre-reveal', 'post-reveal', 'post-work'],
    );
    assert.equal(body.current.version, 3);
    assert.equal(body.current.standing, 'post-work');
  } finally {
    await h.close();
  }
});

test('an edit appends: the first version is untouched and the chain points back', async () => {
  const h = await harness(true);
  try {
    seedProposedPlan(h.system, 42);
    const ref = issueOriginRef('root', 42);
    assert.equal((await post(h, 42, { text: 'the button is primary' })).statusCode, 200);
    const first = h.system.store.goalCriteria.listCriteriaVersions(ref)[0]!;

    assert.equal((await post(h, 42, { text: 'the button is primary and the dialog closes' })).statusCode, 200);

    const chain = h.system.store.goalCriteria.listCriteriaVersions(ref);
    assert.equal(chain.length, 2);
    assert.equal(chain[0]!.text, 'the button is primary', 'nothing rewrites a version that stands');
    assert.equal(chain[0]!.authoredAt, first.authoredAt, 'and nothing restamps it');
    assert.equal(chain[0]!.id, first.id);
    assert.equal(chain[1]!.supersedes, first.id);
    assert.equal(chain[1]!.version, 2);
    assert.equal(chain[1]!.author, 'operator', 'the author is the credential the harness posts under');
  } finally {
    await h.close();
  }
});

test('a post-work edit is refused without a reason and accepted with one', async () => {
  const h = await harness(true);
  try {
    seedProposedPlan(h.system, 43);
    const ref = issueOriginRef('root', 43);
    dispatchPart(h, 43);

    const refused = await post(h, 43, { text: 'a late thought' });
    assert.equal(refused.statusCode, 400);
    assert.match(JSON.stringify(refused.json()), /reason is required/);
    assert.equal(h.system.store.goalCriteria.listCriteriaVersions(ref).length, 0, 'the refusal wrote nothing');

    const accepted = await post(h, 43, { text: 'a late thought', reason: 'the customer changed their mind' });
    assert.equal(accepted.statusCode, 200);
    assert.equal(h.system.store.goalCriteria.currentCriteria(ref)?.reason, 'the customer changed their mind');
  } finally {
    await h.close();
  }
});

test('drift is not a WorldEvent: a standing delivery verdict survives it', async () => {
  const h = await harness(true);
  try {
    seedProposedPlan(h.system, 44);
    const ref = issueOriginRef('root', 44);
    dispatchPart(h, 44);
    h.system.store.verdicts.recordDelivery({ originRef: ref, summary: 'shipped', by: 'operator' });

    const issue: Issue = {
      id: 'i-44',
      number: 44,
      title: 'Goal 44',
      body: '',
      labels: [],
      state: 'open',
      url: '',
      updatedAt: new Date().toISOString(),
    } as unknown as Issue;

    const before = h.system.store.world.listWorldEvents();
    const heldBefore = deliveryHold(h.system.store.verdicts.getDelivery(ref), issue, { signals: before });
    assert.ok(heldBefore, 'the goal is parked on its delivery before the drift is recorded');

    assert.equal((await post(h, 44, { text: 'a changed oracle', reason: 'we learnt something' })).statusCode, 200);

    const after = h.system.store.world.listWorldEvents();
    assert.equal(after.length, before.length, 'recording drift wrote no world event');
    assert.deepEqual(
      after.map((e) => e.id),
      before.map((e) => e.id),
    );

    const delivery = h.system.store.verdicts.getDelivery(ref);
    assert.ok(delivery, 'the delivery row was not cleared');
    assert.ok(
      deliveryHold(delivery, issue, { signals: after }),
      'the goal is still parked — a drift record written as a WorldEvent would have handed it back to the fleet',
    );

    const drift = h.system.store.goalCriteria.listCriteriaDrift();
    assert.equal(drift.length, 1, 'and the drift is recorded, on its own table');
    assert.equal(drift[0]!.originRef, ref);
    assert.equal(drift[0]!.reason, 'we learnt something');

    const state = (await h.app.inject({ method: 'GET', url: '/api/state' })).json() as CockpitState;
    assert.equal(state.criteriaDrift?.length, 1, 'and it reaches the cockpit as its own wire list');
  } finally {
    await h.close();
  }
});

test('with the key off nothing is mounted and the wire list is absent', async () => {
  const h = await harness(false);
  try {
    seedProposedPlan(h.system, 45);
    assert.equal((await post(h, 45, { text: 'anything' })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/goals/45/criteria' })).statusCode, 404);

    const state = (await h.app.inject({ method: 'GET', url: '/api/state' })).json() as CockpitState;
    assert.ok(!('criteriaDrift' in state), 'the flag is read at the wire payload, and off means absent');
  } finally {
    await h.close();
  }
});
