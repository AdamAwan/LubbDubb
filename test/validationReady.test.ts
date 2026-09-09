import { deskSettled } from '../src/benchSettlement.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validationReadyPass } from '../src/validation/ready.js';
import { ValidationReadyDesk } from '../src/validation/readyDesk.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { HumanTask, Issue, IssueDelivery, ValidationCheck } from '../src/types.js';

function delivery(number: number, over: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: 'PR #40 landed it',
    detail: null,
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
    ...over,
  };
}

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Goal ${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function check(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    originRef: 'issue:12',
    id: 'merged-branch-gone',
    letter: 'A',
    seq: 0,
    title: 'A squash-merged part branch is gone on both sides',
    do: 'Run the harness against the fixture repo…',
    expect: 'No issue/284/reap ref, locally or on the remote.',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    claimedBy: null,
    claimedAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
    ...over,
  };
}

function task(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: 'hum_1',
    title: 'Run the validation checks for issue #12',
    detail: null,
    originRef: 'issue:12',
    partId: null,
    kind: 'validate',
    agentId: null,
    taskId: null,
    status: 'open',
    resolution: null,
    createdAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
    resolvedAt: null,
    dismissedAt: null,
    ...over,
  };
}

const pass = (over: Partial<Parameters<typeof validationReadyPass>[0]> = {}) =>
  validationReadyPass({
    issues: [],
    deliveries: [],
    shortfalls: [],
    sheetRows: new Map(),
    existing: [],
    checks: new Map(),
    opened: null,
    watchCleared: null,
    ...over,
  });

const checksOn = (...checks: ValidationCheck[]) => new Map([['issue:12', checks]]);

test('a delivered goal with an unrun check owes somebody a run', () => {
  const steps = pass({
    issues: [issue(12, { title: 'Ship the thing', url: 'https://tracker/12' })],
    deliveries: [delivery(12)],
    checks: checksOn(check()),
  });
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.kind, 'file');
  assert.equal(step.kind === 'file' && step.originRef, 'issue:12');
  assert.equal(step.kind === 'file' && step.title, 'Run the validation checks for issue #12');
  const detail = step.kind === 'file' ? step.detail : '';
  assert.match(detail, /Ship the thing/);
  assert.match(detail, /A\. \*\*A squash-merged part branch is gone on both sides\*\*/);
  assert.match(detail, /https:\/\/tracker\/12/);
});

test('nothing delivered owes nothing, however many checks are declared', () => {
  assert.deepEqual(pass({ issues: [issue(12)], deliveries: [], checks: checksOn(check()) }), []);
});

test('a goal that declared no checks files nothing', () => {
  assert.deepEqual(pass({ issues: [issue(12)], deliveries: [delivery(12)] }), []);
});

test('a launch the assessor sent back owes nothing — there is nothing delivered to validate', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check()),
    shortfalls: [
      {
        originRef: 'issue:12',
        cause: 'part',
        partSlug: null,
        summary: 'the migration never ran',
        detail: null,
        by: 'assessor',
        agentId: null,
        taskId: null,
        decidedAt: '2026-08-11T11:00:00.000Z',
        updatedAt: '2026-08-11T11:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(steps, []);
});

test('a check with the fleet is not on the bench, and a hand-back puts it straight back', () => {
  const handed = check({ actor: 'fleet' });
  assert.deepEqual(pass({ issues: [issue(12)], deliveries: [delivery(12)], checks: checksOn(handed) }), []);

  const back = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check({ actor: 'human', handbackNote: 'no account on the staging console' })),
  });
  assert.equal(back.length, 1);
  assert.equal(back[0]!.kind, 'file');
  assert.match(back[0]!.kind === 'file' ? back[0]!.detail : '', /no account on the staging console/);
});

test('a check handed over again is off the bench, note or no note', () => {
  const again = check({ actor: 'fleet', handbackNote: 'no account on the staging console' });
  assert.deepEqual(pass({ issues: [issue(12)], deliveries: [delivery(12)], checks: checksOn(again) }), []);
});

test('a failed check and a deferred one are both still a person’s to deal with', () => {
  for (const state of ['failed', 'deferred'] as const) {
    const steps = pass({
      issues: [issue(12)],
      deliveries: [delivery(12)],
      checks: checksOn(check({ state, resultNote: 'the test environment is rebuilt on Thursday' })),
    });
    assert.equal(steps.length, 1, `${state} is not a settlement`);
    assert.equal(steps[0]!.kind, 'file');
  }
});

test('a superseded check owes nothing — an amendment withdrew the ask', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check({ supersededReason: 'the fixture went away with part two' })),
  });
  assert.deepEqual(steps, []);
});

test('a standing row is re-filed each pulse, which is what keeps the detail current', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check(), check({ id: 'second', letter: 'B', state: 'passed' })),
    existing: [task()],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, 'file');
  const detail = steps[0]!.kind === 'file' ? steps[0]!.detail : '';
  assert.match(detail, /1 check for you to run — of 2 checks in all/);
  assert.doesNotMatch(detail, /second/);
});

test('a settled row is never re-filed — a decline stays declined, and its detail is left alone', () => {
  for (const status of ['done', 'declined'] as const) {
    const steps = pass({
      issues: [issue(12)],
      deliveries: [delivery(12)],
      checks: checksOn(check()),
      existing: [task({ status, resolution: 'we validated this by hand before the release' })],
    });
    assert.deepEqual(steps, [], `${status} is a settlement, and the sweep does not write over it`);
  }
});

test('the last check being recorded settles the obligation', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check({ state: 'passed' }), check({ id: 'second', letter: 'B', state: 'waived' })),
    existing: [task()],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind === 'settle' && steps[0]!.status, 'done');
  assert.match(steps[0]!.kind === 'settle' ? steps[0]!.resolution : '', /nothing is left for you to run/);
});

test('handing the remainder to the fleet settles it too, and says so', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check({ actor: 'fleet' })),
    existing: [task()],
  });
  assert.equal(steps.length, 1);
  assert.match(steps[0]!.kind === 'settle' ? steps[0]!.resolution : '', /with the fleet/);
});

test('an empty world settles nothing — this row is not a reading of the tracker', () => {
  const steps = pass({ issues: [], deliveries: [delivery(12)], checks: checksOn(check()), existing: [task()] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, 'file');
  assert.match(steps[0]!.kind === 'file' ? steps[0]!.detail : '', /^This goal is delivered/);
});

test('clearing the delivery retracts the obligation rather than leaving it standing', () => {
  const steps = pass({ issues: [issue(12)], deliveries: [], checks: checksOn(check()), existing: [task()] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind === 'settle' && steps[0]!.status, 'declined');
  assert.match(steps[0]!.kind === 'settle' ? steps[0]!.resolution : '', /back into production/);
});

test('a re-delivered goal is asked again — the retraction was the harness, not an answer', () => {
  const retracted = pass({ issues: [issue(12)], deliveries: [], checks: checksOn(check()), existing: [task()] });
  const resolution = retracted[0]!.kind === 'settle' ? retracted[0]!.resolution : '';
  assert.ok(deskSettled({ ...task(), resolution }), 'the retraction says who settled it');

  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check()),
    existing: [task({ status: 'declined', resolution })],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, 'reopen');
  assert.match(steps[0]!.kind === 'reopen' ? steps[0]!.detail : '', /A\. \*\*A squash-merged part branch/);
});

test('an operator’s own decline on a re-delivered goal still stands', () => {
  for (const status of ['done', 'declined'] as const) {
    const steps = pass({
      issues: [issue(12)],
      deliveries: [delivery(12)],
      checks: checksOn(check()),
      existing: [task({ status, resolution: 'we validated this by hand before the release' })],
    });
    assert.deepEqual(steps, [], `a ${status} an operator wrote is the last thing said about the row`);
  }
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vready-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 0,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

test('a pulse files the validate row, and the next one settles it once the results are in', async () => {
  const system = build();
  const world = new FakeWorldStore(system.store);
  world.mutate((w) => {
    w.issues.push(issue(12, { title: 'Ship the thing' }));
  });
  system.store.ingestValidation('issue:12', {
    checks: [
      {
        id: 'merged-branch-gone',
        seq: 0,
        title: 'A squash-merged part branch is gone on both sides',
        do: 'Run the harness against the fixture repo…',
        expect: 'No reap ref, locally or on the remote.',
        uses: [],
        covers: [],
        fleetCandidate: false,
        candidateWhy: null,
      },
    ],
    resources: [],
    supersededReason: 'the plan no longer declares it',
    amendNote: 'the plan was re-read',
  });

  await system.harness.runCycle('manual');
  assert.deepEqual(system.store.listHumanTasksOfKind('validate'), []);

  system.store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  await system.harness.runCycle('manual');
  const filed = system.store.listHumanTasksOfKind('validate');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.status, 'open');
  assert.equal(filed[0]!.originRef, 'issue:12');
  assert.equal(filed[0]!.agentId, null);
  assert.equal(filed[0]!.partId, null);

  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listHumanTasksOfKind('validate').map((t) => t.id),
    [filed[0]!.id],
  );

  system.store.recordValidationResult('issue:12', 'merged-branch-gone', {
    state: 'passed',
    note: 'ran it against the fixture repo',
    by: 'operator',
  });
  await system.harness.runCycle('manual');
  const settled = system.store.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /nothing is left for you to run/);
});

test('clearing the last delivery retracts the row, with nothing else on the board', () => {
  const system = build();
  const desk = new ValidationReadyDesk(system.store);
  system.store.ingestValidation('issue:12', {
    checks: [
      {
        id: 'merged-branch-gone',
        seq: 0,
        title: 'A squash-merged part branch is gone on both sides',
        do: 'Run the harness against the fixture repo…',
        expect: 'No reap ref, locally or on the remote.',
        uses: [],
        covers: [],
        fleetCandidate: false,
        candidateWhy: null,
      },
    ],
    resources: [],
    supersededReason: 'the plan no longer declares it',
    amendNote: 'the plan was re-read',
  });

  system.store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  desk.run({ issues: [issue(12)] });
  const filed = system.store.listHumanTasksOfKind('validate');
  assert.equal(filed.length, 1);

  system.store.clearDelivery('issue:12');
  desk.run({ issues: [issue(12)] });
  const settled = system.store.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'declined');
  assert.match(settled.resolution ?? '', /back into production/);
});

test('a gated goal is not asked to validate until its work has arrived somewhere', () => {
  const checks = checksOn(check({ state: 'unrun' }));
  const held = pass({ issues: [issue(12)], deliveries: [delivery(12)], checks, opened: new Set() });
  assert.deepEqual(held, []);

  const opened = pass({ issues: [issue(12)], deliveries: [delivery(12)], checks, opened: new Set(['issue:12']) });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.kind, 'file');
});

test('a gate never holds a row already filed, so results still settle it', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    checks: checksOn(check({ state: 'passed' })),
    existing: [task({ originRef: 'issue:12' })],
    opened: new Set(),
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.kind, 'settle');
});
