import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { completionsToRecord, isGoalComplete } from '../src/floor/completions.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import type { Issue } from '../src/types.js';

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-floor-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

// -- the store row -----------------------------------------------------------

test('a floor completion upserts, freezes completed_at, and survives a re-record', () => {
  const store = new Store(':memory:');
  assert.deepEqual(store.listFloorCompletions(), []);

  store.recordFloorCompletion({ originRef: 'issue:12', issueNumber: 12, title: 'Add the thing' });
  const first = store.listFloorCompletions();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.dismissedAt, null);
  const completedAt = first[0]!.completedAt;

  // A later pulse re-records it with a fresher title; the completion instant holds.
  store.recordFloorCompletion({ originRef: 'issue:12', issueNumber: 12, title: 'Add the thing, renamed' });
  const again = store.listFloorCompletions();
  assert.equal(again.length, 1, 'one row, not two');
  assert.equal(again[0]!.title, 'Add the thing, renamed');
  assert.equal(again[0]!.completedAt, completedAt, 'completed_at is frozen across re-records');
  store.close();
});

test('dismissing is one-way, idempotent, and never resurrected by a re-record', () => {
  const store = new Store(':memory:');
  store.recordFloorCompletion({ originRef: 'issue:12', issueNumber: 12, title: 'x' });

  assert.equal(store.dismissFloorCompletion('issue:12'), true, 'the first dismissal changes the row');
  assert.equal(store.dismissFloorCompletion('issue:12'), false, 'a second is a no-op');
  assert.equal(store.dismissFloorCompletion('issue:99'), false, 'an unrecorded goal cannot be dismissed');
  assert.ok(store.listFloorCompletions()[0]!.dismissedAt, 'the dismissal stands');

  // A dismissed goal that re-completes stays dismissed — the operator cleared it.
  store.recordFloorCompletion({ originRef: 'issue:12', issueNumber: 12, title: 'x' });
  assert.ok(store.listFloorCompletions()[0]!.dismissedAt, 'a re-record does not un-dismiss');
  store.close();
});

// -- the pure fold -----------------------------------------------------------

test('isGoalComplete reads any of the four completion signals, but not more_work', () => {
  const none = { retrospectiveOrigins: [], conclusions: [], deliveries: [], shortfalls: [], plans: [] };
  assert.equal(isGoalComplete(12, none), false);

  assert.equal(isGoalComplete(12, { ...none, retrospectiveOrigins: ['issue:12'] }), true, 'a write-up');
  assert.equal(
    isGoalComplete(12, {
      ...none,
      deliveries: [
        {
          originRef: 'issue:12',
          summary: '',
          by: 'assessor',
          agentId: null,
          taskId: null,
          decidedAt: 'T',
          updatedAt: 'T',
        },
      ],
    }),
    true,
    'a delivery',
  );
  assert.equal(
    isGoalComplete(12, {
      ...none,
      conclusions: [
        {
          originRef: 'issue:12',
          verdict: 'done',
          note: '',
          by: 'agent',
          agentId: null,
          taskId: null,
          createdAt: 'T',
          updatedAt: 'T',
        },
      ],
    }),
    true,
    'a done conclusion',
  );
  assert.equal(
    isGoalComplete(12, {
      ...none,
      conclusions: [
        {
          originRef: 'issue:12',
          verdict: 'more_work',
          note: '',
          by: 'agent',
          agentId: null,
          taskId: null,
          createdAt: 'T',
          updatedAt: 'T',
        },
      ],
    }),
    false,
    'more_work is not a finished goal',
  );
  assert.equal(
    isGoalComplete(12, {
      ...none,
      plans: [
        {
          id: 'p1',
          originRef: 'issue:12',
          title: '',
          status: 'complete',
          createdAt: 'T',
          updatedAt: 'T',
          discussing: false,
        } as never,
      ],
    }),
    true,
    'a complete plan',
  );
  assert.equal(
    isGoalComplete(12, {
      ...none,
      plans: [
        {
          id: 'p1',
          originRef: 'issue:12',
          title: '',
          status: 'active',
          createdAt: 'T',
          updatedAt: 'T',
          discussing: false,
        } as never,
      ],
    }),
    false,
    'an active plan is not done',
  );
});

// The two faces of reading the conclusion and the plan raw instead of asking the
// one resolver: an operator argued with by a derivation, and an assessor's
// verdict losing to the stale `done` of the agent it was assessing.
test('a standing verdict of more_work outranks every piece of evidence', () => {
  const base = { retrospectiveOrigins: ['issue:12'], conclusions: [], deliveries: [], shortfalls: [], plans: [] };
  assert.equal(isGoalComplete(12, base), true, 'the write-up alone is enough');

  assert.equal(
    isGoalComplete(12, {
      ...base,
      shortfalls: [
        {
          originRef: 'issue:12',
          cause: 'plan',
          partSlug: null,
          summary: 'nothing was delivered — the fix is absent from the delivered state',
          by: 'assessor',
          agentId: null,
          taskId: null,
          decidedAt: 'T',
          updatedAt: 'T',
        },
      ],
    }),
    false,
    'a standing shortfall was not consulted at all before',
  );

  assert.equal(
    isGoalComplete(12, {
      ...base,
      retrospectiveOrigins: [],
      conclusions: [
        {
          originRef: 'issue:12',
          verdict: 'more_work',
          note: 'there is more here',
          by: 'operator',
          agentId: null,
          taskId: null,
          createdAt: 'T',
          updatedAt: 'T',
        },
      ],
      plans: [{ id: 'p1', originRef: 'issue:12', title: '', status: 'complete', discussing: false } as never],
    }),
    false,
    "a complete plan used to argue with the operator's own toggle",
  );
});

// The observed defect, end to end: worked `single`, the agent declared done, an
// accepted shortfall sent the plan back to `planning` — and the next pulse minted
// a completion for a goal whose only PR was still open.
test('a goal whose plan is being re-drawn is not minted as complete', () => {
  const signals = {
    retrospectiveOrigins: ['issue:12'],
    deliveries: [],
    shortfalls: [],
    conclusions: [
      {
        originRef: 'issue:12',
        verdict: 'done' as const,
        note: 'delivered in PR #31226',
        by: 'agent' as const,
        agentId: null,
        taskId: null,
        createdAt: 'T',
        updatedAt: 'T',
      },
    ],
    plans: [{ id: 'p1', originRef: 'issue:12', title: '', status: 'planning', discussing: false } as never],
  };
  assert.equal(isGoalComplete(12, signals), false);
  assert.deepEqual(completionsToRecord([issue()], signals), [], 'and so nothing is recorded');

  // The boundary: the gate is on minting, never on a goal that genuinely finished.
  // Once the replan lands and its parts merge, the same signals mint it again.
  const settled = {
    ...signals,
    plans: [{ id: 'p1', originRef: 'issue:12', title: '', status: 'complete', discussing: false } as never],
  };
  assert.equal(isGoalComplete(12, settled), true);
});

test('completionsToRecord names the finished live issues, with their titles', () => {
  const signals = { retrospectiveOrigins: ['issue:12'], conclusions: [], deliveries: [], shortfalls: [], plans: [] };
  const record = completionsToRecord([issue(), issue({ number: 13, id: 'i13', title: 'Other' })], signals);
  assert.deepEqual(record, [{ originRef: 'issue:12', issueNumber: 12, title: 'Add the thing' }]);
});

// -- the pulse records it ----------------------------------------------------

test('the pulse records a finished goal while it is still live', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  await system.harness.runCycle('manual');
  assert.deepEqual(system.store.listFloorCompletions(), [], 'an unfinished goal records nothing');

  // Deliver it, then a pulse records the completion off the live world issue.
  system.store.recordDelivery({
    originRef: 'issue:12',
    summary: 'shipped',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });
  await system.harness.runCycle('manual');
  const rows = system.store.listFloorCompletions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'Add the thing', 'the title is captured while the issue is live');
  assert.equal(rows[0]!.dismissedAt, null);
  system.store.close();
});

// -- what the cockpit is served ----------------------------------------------

test('the snapshot marks a present completed issue and synthesizes a forgotten one', async () => {
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Present goal' });
  await system.harness.runCycle('manual');

  // #12 is still in the world and finished — it rides the world list, flagged.
  store.recordDelivery({ originRef: 'issue:12', summary: 'shipped', by: 'assessor', agentId: null, taskId: null });
  await system.harness.runCycle('manual');

  // #99 finished and then left the world (closed by hand): seed the record and a
  // report directly, since the fake keeps its issues and cannot drop one.
  store.recordFloorCompletion({ originRef: 'issue:99', issueNumber: 99, title: 'Forgotten goal' });
  store.recordRetrospective({
    originRef: 'issue:99',
    summary: 'It shipped in two parts.',
    document: '# done',
    agentId: 'a1',
    taskId: 't1',
  });

  const built = await buildApp(system);
  const app = built.app;
  const res = await app.inject({ method: 'GET', url: '/api/state' });
  const body = res.json();

  const present = (body.world.issues as { number: number; completion?: { dismissed: boolean } }[]).find(
    (i) => i.number === 12,
  );
  assert.ok(present?.completion, 'a present finished issue carries its completion');
  assert.equal(present!.completion!.dismissed, false);

  const forgotten = body.floorCompletions as {
    number: number;
    title: string;
    state: string;
    completion?: { dismissed: boolean };
    retrospective?: { summary: string };
  }[];
  const one = forgotten.find((i) => i.number === 99);
  assert.ok(one, 'a forgotten finished goal is synthesized so its report stays reachable');
  assert.equal(one!.title, 'Forgotten goal');
  assert.equal(one!.state, 'closed');
  assert.equal(one!.completion?.dismissed, false);
  assert.equal(one!.retrospective?.summary, 'It shipped in two parts.', 'its report rides the synthesized issue');

  await app.close();
  store.close();
});

test('dismissing takes a completion off the floor, and it persists', async () => {
  const system = build();
  const { store } = system;
  store.recordFloorCompletion({ originRef: 'issue:99', issueNumber: 99, title: 'Forgotten goal' });

  const built = await buildApp(system);
  const app = built.app;

  const before = (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(
    (before.floorCompletions as { number: number }[]).some((i) => i.number === 99),
    true,
    'retained before dismissal',
  );

  const dismiss = await app.inject({ method: 'POST', url: '/api/issues/99/floor-dismiss' });
  assert.equal(dismiss.statusCode, 200);
  assert.equal(dismiss.json().ok, true);

  const after = (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(
    (after.floorCompletions as { number: number }[]).some((i) => i.number === 99),
    false,
    'gone after dismissal',
  );
  assert.ok(store.listFloorCompletions()[0]!.dismissedAt, 'the dismissal persisted to the store');

  // Idempotent: nothing left to dismiss.
  const again = await app.inject({ method: 'POST', url: '/api/issues/99/floor-dismiss' });
  assert.equal(again.statusCode, 409);

  await app.close();
  store.close();
});
