import { deskSettled } from '../src/benchSettlement.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { closeOutPass } from '../src/delivery/closeOut.js';
import { DeliveryCloseOutDesk } from '../src/delivery/closeOutDesk.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { Store } from '../src/store/store.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import type { GoalValidation } from '../src/validation/goal.js';
import type { HumanTask, Issue, IssueDelivery, ValidationVerdict } from '../src/types.js';

function verdict(over: Partial<ValidationVerdict> = {}): ValidationVerdict {
  return { state: 'clear', total: 0, passed: 0, failed: 0, unrun: 0, deferred: 0, waived: 0, captured: 0, ...over };
}

function delivery(number: number, over: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: 'the docs landed with it',
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

function task(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: 'hum_1',
    title: 'Close issue #12 in the tracker',
    detail: null,
    originRef: 'issue:12',
    partId: null,
    kind: 'close_out',
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

const pass = (over: Partial<Parameters<typeof closeOutPass>[0]> = {}) =>
  closeOutPass({
    issues: [],
    deliveries: [],
    shortfalls: [],
    existing: [],
    validation: new Map(),
    opened: null,
    validating: new Set(),
    watch: new Map(),
    watchCleared: null,
    canClose: true,
    ...over,
  });

test('a delivered goal whose ticket is still open owes a close', () => {
  const steps = pass({ issues: [issue(12, { url: 'https://tracker/12' })], deliveries: [delivery(12)] });
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.kind, 'file');
  assert.equal(step.kind === 'file' && step.originRef, 'issue:12');
  assert.equal(step.kind === 'file' && step.title, 'Close issue #12 in the tracker');
  assert.match(step.kind === 'file' ? step.detail : '', /https:\/\/tracker\/12/);
});

test('nothing is owed when the tracker already stopped listing it open', () => {
  assert.deepEqual(pass({ issues: [issue(9)], deliveries: [delivery(12)] }), []);
  assert.deepEqual(pass({ issues: [issue(12, { state: 'closed' })], deliveries: [delivery(12)] }), []);
});

test('a launch the assessor sent back owes nothing', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
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

test('a standing row is re-filed each pulse, which is what keeps the detail current', () => {
  const steps = pass({ issues: [issue(12)], deliveries: [delivery(12)], existing: [task()] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, 'file');
  assert.equal(steps[0]!.kind === 'file' && steps[0]!.originRef, 'issue:12');
});

test('the re-filed detail follows the verdict, in both directions', () => {
  const world = { issues: [issue(12)], deliveries: [delivery(12)], existing: [task()] };
  const detailOf = (validation: Map<string, GoalValidation>): string => {
    const steps = pass({ ...world, validation });
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.kind, 'file');
    return steps[0]!.kind === 'file' ? steps[0]!.detail : '';
  };

  const clear: Map<string, GoalValidation> = new Map([
    ['issue:12', { verdict: verdict({ state: 'clear', total: 1, passed: 1 }), outstanding: [] }],
  ]);
  const flagged: Map<string, GoalValidation> = new Map([
    [
      'issue:12',
      { verdict: verdict({ state: 'flagged', total: 1, unrun: 1 }), outstanding: ['A. **Check a** — unrun'] },
    ],
  ]);

  assert.doesNotMatch(detailOf(clear), /Validation is not clear/);
  assert.match(detailOf(flagged), /Validation is not clear on this goal — 1 never run, of 1\./);
  assert.match(detailOf(flagged), /- A\. \*\*Check a\*\* — unrun/);
  assert.doesNotMatch(detailOf(clear), /Validation is not clear/);
});

test('a gate holds a new row and never un-files a standing one', () => {
  const held = { issues: [issue(12)], deliveries: [delivery(12)] };
  assert.deepEqual(pass({ ...held, opened: new Set<string>() }), []);
  assert.deepEqual(pass({ ...held, validating: new Set(['issue:12']) }), []);
  for (const over of [{ opened: new Set<string>() }, { validating: new Set(['issue:12']) }]) {
    const steps = pass({ ...held, existing: [task()], ...over });
    assert.equal(steps.length, 1, 'the standing row is still re-filed');
    assert.equal(steps[0]!.kind, 'file');
  }
});

test('a settled row is never re-filed — a decline stays declined', () => {
  for (const status of ['done', 'declined'] as const) {
    const steps = pass({
      issues: [issue(12)],
      deliveries: [delivery(12)],
      existing: [task({ status, resolution: 'it stays open until the release goes out' })],
    });
    assert.deepEqual(steps, [], `${status} is a settlement, and the sweep does not re-open it`);
  }
});

test("a dismissed row is still the sweep's row — clearing the bench does not re-raise the ask", () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    existing: [
      task({ status: 'done', resolvedAt: '2026-08-11T11:00:00.000Z', dismissedAt: '2026-08-11T12:00:00.000Z' }),
    ],
  });
  assert.deepEqual(steps, []);
});

test('the tracker closing the item settles the obligation, both ways it can look', () => {
  const closed = pass({ issues: [issue(12, { state: 'closed' })], deliveries: [delivery(12)], existing: [task()] });
  assert.deepEqual(closed, [
    { kind: 'settle', taskId: 'hum_1', status: 'done', resolution: 'the tracker shows it closed' },
  ]);

  const gone = pass({ issues: [issue(9)], deliveries: [delivery(12)], existing: [task()] });
  assert.deepEqual(gone, [
    { kind: 'settle', taskId: 'hum_1', status: 'done', resolution: 'the tracker no longer lists it open' },
  ]);
});

test('an empty world settles nothing — a provider that read nothing is not a tracker that closed everything', () => {
  assert.deepEqual(pass({ issues: [], deliveries: [delivery(12)], existing: [task()] }), []);
});

test('clearing the delivery retracts the obligation rather than leaving it standing', () => {
  const steps = pass({ issues: [issue(12)], deliveries: [], existing: [task()] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind === 'settle' && steps[0]!.status, 'declined');
  assert.match(steps[0]!.kind === 'settle' ? steps[0]!.resolution : '', /back into production/);
});

test('a re-delivered goal is asked to close again — the retraction was the harness', () => {
  const retracted = pass({ issues: [issue(12)], deliveries: [], existing: [task()] });
  const resolution = retracted[0]!.kind === 'settle' ? retracted[0]!.resolution : '';
  assert.ok(deskSettled({ ...task(), resolution }), 'the retraction says who settled it');

  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    existing: [task({ status: 'declined', resolution })],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, 'reopen');
  assert.match(steps[0]!.kind === 'reopen' ? steps[0]!.detail : '', /issue #12|Close/i);

  assert.deepEqual(
    pass({
      issues: [issue(12, { state: 'closed' })],
      deliveries: [delivery(12)],
      existing: [task({ status: 'declined', resolution })],
    }),
    [],
  );
});

test('an operator’s own answer on a re-delivered goal still stands', () => {
  for (const status of ['done', 'declined'] as const) {
    const steps = pass({
      issues: [issue(12)],
      deliveries: [delivery(12)],
      existing: [task({ status, resolution: 'it stays open until the release goes out' })],
    });
    assert.deepEqual(steps, [], `a ${status} an operator wrote is the last thing said about the row`);
  }
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-closeout-'));
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

test('a pulse files the close-out, and the next one settles it once the ticket goes', async () => {
  const system = build();
  const world = new FakeWorldStore(system.store);
  world.mutate((w) => {
    w.issues.push(issue(12, { title: 'Ship the thing' }), issue(13));
  });
  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });

  await system.harness.runCycle('manual');
  const filed = system.store.humanTasks.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.status, 'open');
  assert.equal(filed[0]!.originRef, 'issue:12');
  assert.equal(filed[0]!.agentId, null);
  assert.equal(filed[0]!.partId, null);

  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.humanTasks.listHumanTasksOfKind('close_out').map((t) => t.id),
    [filed[0]!.id],
  );
  assert.equal(system.store.humanTasks.getHumanTask(filed[0]!.id)!.status, 'open');

  world.mutate((w) => {
    w.issues = w.issues.filter((i) => i.number !== 12);
  });
  await system.harness.runCycle('manual');
  const settled = system.store.humanTasks.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /no longer lists it open/);
});

test('a database written before the sweep existed reads its rows as asks', () => {
  const store = new Store(':memory:');
  const { task: ask } = store.humanTasks.recordHumanTask({
    title: 'Rotate the deploy key',
    detail: null,
    originRef: 'issue:12',
    agentId: 'agent-1',
    taskId: 'task-1',
  });
  assert.equal(ask.kind, 'ask');
  assert.deepEqual(store.humanTasks.listHumanTasksOfKind('close_out'), []);
  new DeliveryCloseOutDesk(store).run({ issues: [] });
  assert.equal(store.humanTasks.getHumanTask(ask.id)!.status, 'open');
});

test('clearing the last delivery retracts the row, with nothing else on the board', () => {
  const store = new Store(':memory:');
  const desk = new DeliveryCloseOutDesk(store);

  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  desk.run({ issues: [issue(12)] });
  const filed = store.humanTasks.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);

  store.verdicts.clearDelivery('issue:12');
  desk.run({ issues: [issue(12)] });
  const settled = store.humanTasks.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'declined');
  assert.match(settled.resolution ?? '', /back into production/);
});

test('the close is not asked for while validation is still somebody’s', () => {
  const held = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    validating: new Set(['issue:12']),
  });
  assert.deepEqual(held, [], 'the close is the step after validation, not beside it');

  const after = pass({ issues: [issue(12)], deliveries: [delivery(12)], validating: new Set() });
  assert.equal(after.length, 1);
  assert.equal(after[0]?.kind, 'file');
});

test('a validate row settled by hand releases the close, whatever the checks say', () => {
  const steps = pass({ issues: [issue(12)], deliveries: [delivery(12)], validating: new Set(['issue:99']) });
  assert.equal(steps.length, 1, 'another goal’s open validate row holds nothing here');
});

test('a gated goal owes no close until its work has arrived somewhere', () => {
  const held = pass({ issues: [issue(12)], deliveries: [delivery(12)], opened: new Set() });
  assert.deepEqual(held, [], 'asking for the close before the work is checkable is asking too early');

  const opened = pass({ issues: [issue(12)], deliveries: [delivery(12)], opened: new Set(['issue:12']) });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.kind, 'file');
});

test('a gate never holds a row already filed, so a ticket closed by hand still settles', () => {
  const steps = pass({
    issues: [issue(12, { state: 'closed' })],
    deliveries: [delivery(12)],
    existing: [task({ originRef: 'issue:12' })],
    opened: new Set(),
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.kind, 'settle');
});

test("through a real store, the standing row's warning follows the goal's checks", () => {
  const store = new Store(':memory:');
  const world = { issues: [issue(12, { url: 'https://tracker/12' })] };
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    validation: { checks: [{ id: 'a', title: 'Check a', do: 'Do a.', expect: 'It works.' }] },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:12', title: 'Ship it' });
  store.validation.recordValidationResult('issue:12', 'a', { state: 'passed', note: 'it works', by: 'operator' });
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });

  const desk = new DeliveryCloseOutDesk(store);
  desk.run(world);
  const filed = store.humanTasks.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);
  assert.doesNotMatch(filed[0]!.detail ?? '', /Validation is not clear/);

  store.validation.amendValidation('issue:12', {
    checks: [
      {
        id: 'b',
        title: 'Check b',
        do: 'Do b.',
        expect: 'It works.',
        uses: [],
        covers: [],
        fleetCandidate: false,
        candidateWhy: null,
      },
    ],
    withdraw: [],
    resources: [],
    note: 'one more thing to prove',
  });
  desk.run(world);
  assert.deepEqual(
    store.humanTasks.listHumanTasksOfKind('close_out').map((t) => t.id),
    [filed[0]!.id],
    'one row under one id — the refresh is a repeat, not a second obligation',
  );
  assert.match(store.humanTasks.getHumanTask(filed[0]!.id)!.detail ?? '', /1 never run, of 2/);

  store.validation.recordValidationResult('issue:12', 'b', { state: 'passed', note: 'it works', by: 'operator' });
  desk.run(world);
  assert.doesNotMatch(store.humanTasks.getHumanTask(filed[0]!.id)!.detail ?? '', /Validation is not clear/);
});

test('the row states the way out the deployment actually has', () => {
  const closable = pass({ issues: [issue(12)], deliveries: [delivery(12)], canClose: true });
  assert.equal(closable.length, 1);
  assert.match((closable[0] as { detail: string }).detail, /\*\*Close the ticket\*\* here does it/);

  const manual = pass({ issues: [issue(12)], deliveries: [delivery(12)], canClose: false });
  assert.doesNotMatch((manual[0] as { detail: string }).detail, /Close the ticket/);
  assert.match((manual[0] as { detail: string }).detail, /Close it there/);
});

test('the close-out row closes its own ticket, and the close is an operator’s answer', async () => {
  const system = build();
  const world = new FakeWorldStore(system.store);
  world.mutate((w) => {
    w.issues.push(issue(12, { title: 'Ship the thing' }), issue(13));
  });
  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  await system.harness.runCycle('manual');
  const filed = system.store.humanTasks.listHumanTasksOfKind('close_out')[0]!;

  const { app } = await buildApp(system);
  const closed = await app.inject({ method: 'POST', url: `/api/human-tasks/${filed.id}/close-ticket` });
  assert.equal(closed.statusCode, 200);

  assert.equal(system.store.world.getWorldBaseline()!.issues.find((i) => i.number === 12)!.state, 'closed');

  const settled = system.store.humanTasks.getHumanTask(filed.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /Closed #12 in the tracker from the cockpit/);
  assert.equal(deskSettled(settled), false);

  await system.harness.runCycle('manual');
  assert.equal(system.store.humanTasks.getHumanTask(filed.id)!.status, 'done');

  const again = await app.inject({ method: 'POST', url: `/api/human-tasks/${filed.id}/close-ticket` });
  assert.equal(again.statusCode, 409);
  await app.close();
});

test('an ordinary ask has no ticket to close', async () => {
  const system = build();
  const { task: ask } = system.store.humanTasks.recordHumanTask({
    title: 'Plug the cable in',
    detail: null,
    originRef: null,
    kind: 'ask',
    agentId: null,
    taskId: null,
  });
  const { app } = await buildApp(system);
  const refused = await app.inject({ method: 'POST', url: `/api/human-tasks/${ask.id}/close-ticket` });
  assert.equal(refused.statusCode, 409);
  await app.close();
});
