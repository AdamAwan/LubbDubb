import { deskSettled } from '../src/benchSettlement.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeOutPass } from '../src/delivery/closeOut.js';
import { DeliveryCloseOutDesk } from '../src/delivery/closeOutDesk.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import type { GoalValidation } from '../src/validation/goal.js';
import type { HumanTask, Issue, IssueDelivery, ValidationVerdict } from '../src/types.js';

function verdict(over: Partial<ValidationVerdict> = {}): ValidationVerdict {
  return { state: 'clear', total: 0, passed: 0, failed: 0, unrun: 0, deferred: 0, waived: 0, ...over };
}

/**
 * The step after the launch: the ticket a delivered goal leaves open.
 *
 * The property to hold on to while reading these: the obligation is a **row**,
 * not a reading of the tracker. The harness may settle it because it can see the
 * item, but a decline is the operator's and no world state overrides it — so
 * every question below is asked twice, once about what the world says and once
 * about what the row already said.
 */

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
    // Null is "no environment gates the close", which is every deployment that
    // has not configured one — an empty set would withhold every row instead.
    opened: null,
    validating: new Set(),
    ...over,
  });

// -- filing -------------------------------------------------------------------

test('a delivered goal whose ticket is still open owes a close', () => {
  const steps = pass({ issues: [issue(12, { url: 'https://tracker/12' })], deliveries: [delivery(12)] });
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.kind, 'file');
  assert.equal(step.kind === 'file' && step.originRef, 'issue:12');
  // The headline is the ask, not the goal's own title: a ticket renamed under
  // the row must not read as a second thing to do.
  assert.equal(step.kind === 'file' && step.title, 'Close issue #12 in the tracker');
  assert.match(step.kind === 'file' ? step.detail : '', /https:\/\/tracker\/12/);
});

test('nothing is owed when the tracker already stopped listing it open', () => {
  // The GitHub shape: a merged "Closes #12" took the issue with it, so the world
  // never carries it and no obligation was ever raised.
  assert.deepEqual(pass({ issues: [issue(9)], deliveries: [delivery(12)] }), []);
  // The Azure shape: the work item is still reported, in a closed state.
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
  // Idempotence here is `recordHumanTask`'s dedup, not silence. The step has to
  // come back on every pulse, because the detail is where the goal's validation
  // flag lands and the row is the surface an operator closes the ticket from.
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

  // Filed while the plan was clear. A planner then declares a check nobody has
  // run — the damaging direction, because the row an operator is about to close
  // the ticket from would otherwise still say nothing is outstanding.
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
  // And back: a warning that outlives the checks passing is one nobody reads.
  assert.doesNotMatch(detailOf(clear), /Validation is not clear/);
});

test('a gate holds a new row and never un-files a standing one', () => {
  const held = { issues: [issue(12)], deliveries: [delivery(12)] };
  // Neither gate lets a first row through …
  assert.deepEqual(pass({ ...held, opened: new Set<string>() }), []);
  assert.deepEqual(pass({ ...held, validating: new Set(['issue:12']) }), []);
  // … and neither takes back one already filed. An arrival that stops being
  // reported, or a validate row re-opened, must not blank the close-out's detail.
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
  // The operator took the settled record off the bench while the item is still
  // listed open, which is the one shape a delete would have got wrong: the sweep
  // finds its own row by looking for it, so a deleted one comes straight back and
  // the dismissal reads as a button that does nothing.
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    existing: [
      task({ status: 'done', resolvedAt: '2026-08-11T11:00:00.000Z', dismissedAt: '2026-08-11T12:00:00.000Z' }),
    ],
  });
  assert.deepEqual(steps, []);
});

// -- settling -----------------------------------------------------------------

test('the tracker closing the item settles the obligation, both ways it can look', () => {
  const closed = pass({ issues: [issue(12, { state: 'closed' })], deliveries: [delivery(12)], existing: [task()] });
  assert.deepEqual(closed, [
    { kind: 'settle', taskId: 'hum_1', status: 'done', resolution: 'the tracker shows it closed' },
  ]);

  // Gone from the open set is the same fact on a provider that reports open
  // issues only — and the note says what was observed rather than who did it.
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
  // Declined rather than deleted, for the reason an amended plan declines the
  // human part it dropped: the row is the account of why it stopped being owed.
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
  // Worse here than on the validate side: `close_out` is the row that says the goal
  // is finished, and its absence looks exactly like a goal never delivered at all.
  assert.match(steps[0]!.kind === 'reopen' ? steps[0]!.detail : '', /issue #12|Close/i);

  // And a retracted row whose ticket has since closed is not reopened to ask for a
  // close nobody owes — the settle arms above already discharge that one.
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

// -- through the harness ------------------------------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-closeout-'));
  return buildSystem(
    loadConfig({
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
    // Two, so the world is never empty: a provider that read *nothing* is the one
    // case the gone-arm refuses to act on, and it must not be what this proves.
    w.issues.push(issue(12, { title: 'Ship the thing' }), issue(13));
  });
  system.store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });

  await system.harness.runCycle('manual');
  const filed = system.store.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.status, 'open');
  assert.equal(filed[0]!.originRef, 'issue:12');
  // Nobody asked for it — not an agent, not an operator. That null is the whole
  // of what "the harness filed this" means on the row.
  assert.equal(filed[0]!.agentId, null);
  // It blocks nothing: no part backs it.
  assert.equal(filed[0]!.partId, null);

  // A second pulse against the same world adds nothing and touches nothing.
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listHumanTasksOfKind('close_out').map((t) => t.id),
    [filed[0]!.id],
  );
  // The row is re-filed rather than skipped, so `updated_at` moves — which is
  // the mechanism, not a side effect. `listHumanTasks` orders on `created_at`,
  // so the refresh does not reorder the bench.
  assert.equal(system.store.getHumanTask(filed[0]!.id)!.status, 'open');

  // Someone closes it in the tracker, and GitHub's issues provider stops
  // reporting it at all.
  world.mutate((w) => {
    w.issues = w.issues.filter((i) => i.number !== 12);
  });
  await system.harness.runCycle('manual');
  const settled = system.store.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /no longer lists it open/);
});

test('a database written before the sweep existed reads its rows as asks', () => {
  const store = new Store(':memory:');
  const { task: ask } = store.recordHumanTask({
    title: 'Rotate the deploy key',
    detail: null,
    originRef: 'issue:12',
    agentId: 'agent-1',
    taskId: 'task-1',
  });
  assert.equal(ask.kind, 'ask');
  // And the kind is what the sweep keys on, so an ask on the same origin is
  // neither found nor settled by it.
  assert.deepEqual(store.listHumanTasksOfKind('close_out'), []);
  new DeliveryCloseOutDesk(store).run({ issues: [] });
  assert.equal(store.getHumanTask(ask.id)!.status, 'open');
});

test('clearing the last delivery retracts the row, with nothing else on the board', () => {
  // The retraction reads the standing rows, not the deliveries, so it is the one
  // arm with work to do precisely when nothing is delivered. A desk that reads the
  // deliveries first and returns on an empty list therefore retracts only while
  // some *unrelated* goal happens to still be parked — which is a harness working
  // one goal at a time never retracting at all.
  const store = new Store(':memory:');
  const desk = new DeliveryCloseOutDesk(store);

  store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  desk.run({ issues: [issue(12)] });
  const filed = store.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);

  store.clearDelivery('issue:12');
  desk.run({ issues: [issue(12)] });
  const settled = store.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'declined');
  assert.match(settled.resolution ?? '', /back into production/);
});

// -- the sequence -------------------------------------------------------------

test('the close is not asked for while validation is still somebody’s', () => {
  const held = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    validating: new Set(['issue:12']),
  });
  // The bench asks for one thing at a time. Filed together, the two rows say "run
  // these checks" and "close this ticket" in the same breath, and the second is an
  // invitation to skip the first.
  assert.deepEqual(held, [], 'the close is the step after validation, not beside it');

  const after = pass({ issues: [issue(12)], deliveries: [delivery(12)], validating: new Set() });
  assert.equal(after.length, 1);
  assert.equal(after[0]?.kind, 'file');
});

test('a validate row settled by hand releases the close, whatever the checks say', () => {
  // Read from the bench rather than from the verdict: a `flagged` verdict would
  // hold the close for good on a goal with one failing check, and the operator's
  // way of saying "I am done with this" is the row.
  const steps = pass({ issues: [issue(12)], deliveries: [delivery(12)], validating: new Set(['issue:99']) });
  assert.equal(steps.length, 1, 'another goal’s open validate row holds nothing here');
});

// -- the environment gate -----------------------------------------------------

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
  // The freeze is only visible with `recordHumanTask` in the loop, so this one
  // goes through the desk rather than the pass. The damaging direction is the
  // one it drives: the row is filed while the plan is clear, and a check is
  // declared afterwards.
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
  store.recordValidationResult('issue:12', 'a', { state: 'passed', note: 'it works', by: 'operator' });
  store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });

  const desk = new DeliveryCloseOutDesk(store);
  desk.run(world);
  const filed = store.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);
  assert.doesNotMatch(filed[0]!.detail ?? '', /Validation is not clear/);

  // A planner amends the block and declares a second check nobody has run. The
  // goal is flagged from this pulse on, and the row an operator closes the
  // ticket from has to say so.
  store.amendValidation('issue:12', {
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
    store.listHumanTasksOfKind('close_out').map((t) => t.id),
    [filed[0]!.id],
    'one row under one id — the refresh is a repeat, not a second obligation',
  );
  assert.match(store.getHumanTask(filed[0]!.id)!.detail ?? '', /1 never run, of 2/);

  // And back: a warning that outlives the check passing is one nobody reads.
  store.recordValidationResult('issue:12', 'b', { state: 'passed', note: 'it works', by: 'operator' });
  desk.run(world);
  assert.doesNotMatch(store.getHumanTask(filed[0]!.id)!.detail ?? '', /Validation is not clear/);
});
