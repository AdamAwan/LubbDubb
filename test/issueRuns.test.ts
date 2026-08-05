import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { isGoalComplete, retainedRunIssues, runsToRecord } from '../src/floor/runs.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import type { Issue, IssueRun, Task } from '../src/types.js';

// A run lives until the operator dismisses it, not until the tracker stops
// returning the issue (issue #234): the record, the union it feeds into the
// dispatcher's issue list, and the dismissal that ends both.

const NOW = '2026-07-28T12:00:00.000Z';

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
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

/** A finished pickup task — what `hasPriorWork` reads as "this goal has been worked". */
function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    originRef: 'issue:12',
    issueNumber: 12,
    title: 'Add the thing',
    body: 'please add the thing',
    labels: ['lubbdubb-watch'],
    linkedPrNumber: 31,
    workItemState: null,
    startedAt: NOW,
    completedAt: null,
    outcome: null,
    dismissedAt: null,
    updatedAt: NOW,
    ...over,
  };
}

const RECORD = {
  originRef: 'issue:12',
  issueNumber: 12,
  title: 'Add the thing',
  body: 'please add the thing',
  labels: ['lubbdubb-watch'],
  linkedPrNumber: null,
  workItemState: null,
  complete: false,
};

// -- the store row -----------------------------------------------------------

test('a run upserts, refreshes its snapshot, and freezes both instants', () => {
  const store = new Store(':memory:');
  assert.deepEqual(store.listIssueRuns(), []);

  store.recordIssueRun(RECORD);
  const first = store.listIssueRuns();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.completedAt, null, 'minted at pickup, with no completion');
  assert.equal(first[0]!.dismissedAt, null);
  assert.deepEqual(first[0]!.labels, ['lubbdubb-watch'], 'the labels ride the row, for the watch gates');
  const startedAt = first[0]!.startedAt;

  // A later pulse re-records it with a fresher snapshot and the goal now finished.
  store.recordIssueRun({ ...RECORD, title: 'Add the thing, renamed', body: 'reworded', complete: true });
  const again = store.listIssueRuns();
  assert.equal(again.length, 1, 'one row, not two');
  assert.equal(again[0]!.title, 'Add the thing, renamed');
  assert.equal(again[0]!.body, 'reworded', 'the snapshot tracks the live issue');
  assert.equal(again[0]!.startedAt, startedAt, 'started_at is frozen across re-records');
  const completedAt = again[0]!.completedAt;
  assert.ok(completedAt, 'the completion instant is stamped once the signals say so');

  // And a later pulse that no longer reads it as complete does not un-finish it.
  store.recordIssueRun(RECORD);
  assert.equal(store.listIssueRuns()[0]!.completedAt, completedAt, 'the completion instant is frozen too');
  store.close();
});

test('dismissing is one-way, idempotent, and stamps how the run ended', () => {
  const store = new Store(':memory:');
  store.recordIssueRun(RECORD);

  assert.equal(store.dismissIssueRun('issue:12'), true, 'the first dismissal changes the row');
  assert.equal(store.dismissIssueRun('issue:12'), false, 'a second is a no-op');
  assert.equal(store.dismissIssueRun('issue:99'), false, 'an unrecorded goal cannot be dismissed');
  const abandoned = store.listIssueRuns()[0]!;
  assert.ok(abandoned.dismissedAt, 'the dismissal stands');
  assert.equal(abandoned.outcome, 'abandoned', 'a run nothing had judged was abandoned');

  // A dismissed run that re-records stays dismissed — the operator ended it.
  store.recordIssueRun({ ...RECORD, complete: true });
  assert.ok(store.listIssueRuns()[0]!.dismissedAt, 'a re-record does not un-dismiss');

  // The other route in: a run the harness had judged finished.
  store.recordIssueRun({ ...RECORD, originRef: 'issue:13', issueNumber: 13, complete: true });
  store.dismissIssueRun('issue:13');
  assert.equal(store.listIssueRuns().find((r) => r.issueNumber === 13)!.outcome, 'judged');
  store.close();
});

// The migration nobody sees fail: a live database holds dismissals the operator
// has already made, and losing one puts every cleared card back on the floor —
// now with the dispatcher acting on it again.
test('floor_completions is carried into issue_runs, dismissals and all, then dropped', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-migrate-')), 'db.sqlite');
  const raw = new Database(path);
  raw.exec(`CREATE TABLE floor_completions (
    origin_ref TEXT PRIMARY KEY, issue_number INTEGER NOT NULL, title TEXT NOT NULL,
    completed_at TEXT NOT NULL, dismissed_at TEXT, updated_at TEXT NOT NULL);
    INSERT INTO floor_completions VALUES ('issue:7', 7, 'Kept', '${NOW}', NULL, '${NOW}');
    INSERT INTO floor_completions VALUES ('issue:8', 8, 'Cleared', '${NOW}', '${NOW}', '${NOW}');`);
  raw.close();

  const store = new Store(path);
  const rows = store.listIssueRuns();
  assert.equal(rows.length, 2, 'both rows carried');
  const kept = rows.find((r) => r.issueNumber === 7)!;
  assert.equal(kept.title, 'Kept');
  assert.equal(kept.startedAt, NOW, 'the only instant the old shape recorded dates both ends');
  assert.equal(kept.completedAt, NOW);
  assert.equal(kept.dismissedAt, null);
  const cleared = rows.find((r) => r.issueNumber === 8)!;
  assert.ok(cleared.dismissedAt, 'a dismissal the operator already made survives');
  assert.equal(cleared.outcome, 'judged', 'every old row was a completion');
  store.close();

  const check = new Database(path);
  const old = check.prepare(`SELECT name FROM sqlite_master WHERE name='floor_completions'`).get();
  assert.equal(old, undefined, 'the old table is gone, so the copy cannot run twice');
  check.close();

  // A second boot carries nothing and breaks nothing.
  const reopened = new Store(path);
  assert.equal(reopened.listIssueRuns().length, 2);
  reopened.close();
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
test('a goal whose plan is being re-drawn is not stamped complete', () => {
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
  assert.deepEqual(
    runsToRecord([issue()], [], signals),
    [],
    'and with no prior work either, nothing is recorded at all',
  );
  assert.equal(runsToRecord([issue()], [task()], signals)[0]!.complete, false, 'the run is minted, unfinished');

  // The boundary: the gate is on stamping, never on a goal that genuinely finished.
  const settled = {
    ...signals,
    plans: [{ id: 'p1', originRef: 'issue:12', title: '', status: 'complete', discussing: false } as never],
  };
  assert.equal(isGoalComplete(12, settled), true);
});

// The #234 change to what mints a row: pickup, not completion. A goal nobody
// finished is exactly the one an operator needs something to dismiss.
test('runsToRecord mints at pickup, with the snapshot a retained run is dispatched from', () => {
  const none = { retrospectiveOrigins: [], conclusions: [], deliveries: [], shortfalls: [], plans: [] };
  const worked = issue({ labels: ['lubbdubb-watch'], linkedPrNumber: 31 });

  assert.deepEqual(runsToRecord([worked], [], none), [], 'an untouched goal is not a run');
  const [record] = runsToRecord([worked], [task()], none);
  assert.equal(record!.complete, false, 'worked and unfinished is still a run');
  assert.equal(record!.body, 'please add the thing', 'the body rides it — the assessor and the retro read it');
  assert.deepEqual(record!.labels, ['lubbdubb-watch'], 'and the labels, for the watch gates');
  assert.equal(record!.linkedPrNumber, 31);

  // #203's arm, intact: a goal declared finished without the harness ever staffing
  // it is still worth retaining.
  const declared = { ...none, retrospectiveOrigins: ['issue:12'] };
  assert.equal(runsToRecord([worked], [], declared)[0]!.complete, true);
});

test('retainedRunIssues is the forgotten, undismissed runs — and only those', () => {
  const runs = [
    run(),
    run({ originRef: 'issue:13', issueNumber: 13, title: 'Live', dismissedAt: null }),
    run({ originRef: 'issue:14', issueNumber: 14, title: 'Ended', dismissedAt: NOW, outcome: 'abandoned' }),
  ];
  const retained = retainedRunIssues(runs, [issue({ number: 13, id: 'i13' })]);
  assert.deepEqual(
    retained.map((i) => i.number),
    [12],
    'the live issue speaks for itself and a dismissed run is over',
  );
  assert.equal(retained[0]!.state, 'closed');
  assert.equal(retained[0]!.body, 'please add the thing', "the stub carries the run's snapshot, not an empty body");
  assert.deepEqual(retained[0]!.labels, ['lubbdubb-watch']);
});

// -- the union, at the rule level --------------------------------------------

function dispatchCtx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

const closedIssue = issue({ state: 'closed' });

// The observed defect (#229 after PR #231 merged): the delivering PR carried
// `closes #N`, so the gap `issue-assess` fires in was zero — no delivery row was
// written, and `issue-retro`, whose only precondition is that row, never fired
// either. Satellite *Not yet built*, Manifest *Nothing written*, permanently.
test('a retained run is still assessed after its ticket closed', async () => {
  const assessor = new RuleDispatcher({}, {}, undefined, 'main', {}, { enabled: true }, {}, {}, { enabled: false });

  const closed = await assessor.decide(
    dispatchCtx({ world: { takenAt: NOW, pullRequests: [], issues: [closedIssue] }, tasks: [task()] }),
  );
  assert.deepEqual(
    closed.actions.filter((a) => a.type.startsWith('dispatch_')),
    [],
    "a closed issue nothing retains is not the harness's business",
  );

  const retained = await assessor.decide(
    dispatchCtx({
      world: { takenAt: NOW, pullRequests: [], issues: [closedIssue] },
      retainedIssues: [12],
      tasks: [task()],
    }),
  );
  const dispatched = retained.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1, 'the assessor runs on the run, not on the ticket');
  assert.equal(dispatched[0]!.originRef, 'issue:12:assess');
});

test('a retained run is written up after its ticket closed', async () => {
  const retro = new RuleDispatcher({}, {}, undefined, 'main', {}, { enabled: false }, {}, {}, { enabled: true });
  const plan = await retro.decide(
    dispatchCtx({
      world: { takenAt: NOW, pullRequests: [], issues: [closedIssue] },
      retainedIssues: [12],
      tasks: [task()],
      deliveries: [
        {
          originRef: 'issue:12',
          summary: 'shipped',
          by: 'assessor',
          agentId: null,
          taskId: null,
          decidedAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  );
  const dispatched = plan.actions.filter((a) => a.type === 'dispatch_desk_agent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.originRef, 'issue:12:retro');
});

// The other half of the union, and the reason it is a gate rather than a
// coincidence: a retained issue reads `closed`, which most rules refuse anyway.
// This one is asked of an *open* issue named as retained, so what is asserted is
// the gate itself rather than the state that usually stands in for it.
test('a retained run is never picked up again, whatever the tracker says about it', async () => {
  const dispatcher = new RuleDispatcher();
  const live = await dispatcher.decide(dispatchCtx({ world: { takenAt: NOW, pullRequests: [], issues: [issue()] } }));
  assert.equal(
    live.actions.filter((a) => a.type === 'dispatch_code_agent').length,
    1,
    'the same issue, not retained, is picked up',
  );

  const held = await dispatcher.decide(
    dispatchCtx({ world: { takenAt: NOW, pullRequests: [], issues: [issue()] }, retainedIssues: [12] }),
  );
  assert.deepEqual(
    held.actions.filter((a) => a.type.startsWith('dispatch_')),
    [],
    'a goal the harness has already run at does not get a fresh agent',
  );
});

// -- the pulse records it ----------------------------------------------------

test('the pulse mints a run for a goal it has work under, before anything finishes it', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  await system.harness.runCycle('manual');
  assert.deepEqual(system.store.listIssueRuns(), [], 'a goal nothing has started is not a run');

  // A finished pickup attempt on the issue — the funnel in front of pickup is on
  // by default, so this is seeded rather than waited for. The next pulse sees it
  // and mints the run, unfinished, which is the whole #234 change.
  const seeded = system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  system.store.updateTask(seeded.id, { status: 'done' });
  await system.harness.runCycle('manual');
  const rows = system.store.listIssueRuns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'Add the thing', 'the title is captured while the issue is live');
  assert.equal(rows[0]!.completedAt, null, 'nothing has judged it yet');
  assert.equal(rows[0]!.dismissedAt, null);

  // And the completion instant lands on the pulse after the verdict does.
  system.store.recordDelivery({
    originRef: 'issue:12',
    summary: 'shipped',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });
  await system.harness.runCycle('manual');
  assert.ok(system.store.listIssueRuns()[0]!.completedAt, 'the completion is stamped once a verdict stands');
  system.store.close();
});

// -- what the cockpit is served ----------------------------------------------

test("the snapshot marks a live goal's run and rebuilds a forgotten one", async () => {
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Present goal' });
  const seeded = store.createTask({
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  store.updateTask(seeded.id, { status: 'done' });
  await system.harness.runCycle('manual');

  // #99 ran and then left the world (closed by hand): seed the record and a report
  // directly, since the fake keeps its issues and cannot drop one.
  store.recordIssueRun({
    originRef: 'issue:99',
    issueNumber: 99,
    title: 'Forgotten goal',
    body: 'the goal, as it last stood',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    complete: true,
  });
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

  const present = (body.world.issues as { number: number; run?: { dismissed: boolean } }[]).find(
    (i) => i.number === 12,
  );
  assert.ok(present?.run, 'a goal the harness has worked carries its run');
  assert.equal(present!.run!.dismissed, false);

  const forgotten = body.retainedRuns as {
    number: number;
    title: string;
    body: string;
    state: string;
    pickup: { status: string; reasons: string[] };
    run?: { dismissed: boolean };
    retrospective?: { summary: string };
  }[];
  const one = forgotten.find((i) => i.number === 99);
  assert.ok(one, 'a forgotten run is rebuilt so its report stays reachable');
  assert.equal(one!.title, 'Forgotten goal');
  assert.equal(one!.body, 'the goal, as it last stood', 'and so is the goal itself');
  assert.equal(one!.state, 'closed');
  assert.equal(one!.run?.dismissed, false);
  // The chip reads the run, not the tracker: `done` would say "nothing to do"
  // about the one goal on the floor still waiting for the operator to end it.
  assert.equal(one!.pickup.status, 'retained');
  assert.deepEqual(one!.pickup.reasons, ['closed; run kept until you dismiss it']);
  assert.equal(one!.retrospective?.summary, 'It shipped in two parts.', 'its report rides the rebuilt issue');

  await app.close();
  store.close();
});

test('dismissing ends the run — the card goes and it persists', async () => {
  const system = build();
  const { store } = system;
  store.recordIssueRun({
    originRef: 'issue:99',
    issueNumber: 99,
    title: 'Forgotten goal',
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    complete: false,
  });

  const built = await buildApp(system);
  const app = built.app;

  const before = (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(
    (before.retainedRuns as { number: number }[]).some((i) => i.number === 99),
    true,
    'retained before dismissal — including an unfinished run, which #203 never recorded',
  );

  const dismiss = await app.inject({ method: 'POST', url: '/api/issues/99/dismiss-run' });
  assert.equal(dismiss.statusCode, 200);
  assert.equal(dismiss.json().ok, true);

  const after = (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(
    (after.retainedRuns as { number: number }[]).some((i) => i.number === 99),
    false,
    'gone after dismissal',
  );
  const row = store.listIssueRuns()[0]!;
  assert.ok(row.dismissedAt, 'the dismissal persisted to the store');
  assert.equal(row.outcome, 'abandoned', 'nothing had judged it, so that is how it ended');

  // Idempotent: nothing left to dismiss.
  const again = await app.inject({ method: 'POST', url: '/api/issues/99/dismiss-run' });
  assert.equal(again.statusCode, 409);

  await app.close();
  store.close();
});
