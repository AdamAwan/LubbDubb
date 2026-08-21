import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RUNWAY,
  readRunway,
  runwayPass,
  validateRunwayPolicy,
  type RunwayInput,
  type RunwayPolicy,
} from '../src/supply/runway.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { HumanTask, Issue, IssueRun, Plan } from '../src/types.js';

/**
 * The runway lens.
 *
 * Every state below is one a running deployment reaches perhaps once a month,
 * which is exactly why they are proved here rather than watched for: a warning
 * that never fires and a warning that cannot fire look identical from the
 * cockpit. Three claims carry the feature and each has a case of its own — that
 * an empty queue is reported whatever the history says, that too little history
 * refuses to invent a duration, and that the notice does not flap.
 *
 * The deployment is the one the design note works through: three slots, a
 * forty-minute median goal. One goal is therefore worth 13⅓ minutes of runway.
 */

const NOW = '2026-08-21T09:00:00.000Z';
const WATCH = 'lubbdubb-watch';

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Issue #${number}`,
    body: '',
    labels: [WATCH],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

/** A completed run of `minutes`, so a fixture states the median it is building. */
function run(originRef: string, minutes: number | null): IssueRun {
  const started = Date.parse('2026-08-20T09:00:00.000Z');
  return {
    originRef,
    issueNumber: Number(originRef.split(':')[1]),
    title: originRef,
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    startedAt: new Date(started).toISOString(),
    completedAt: minutes === null ? null : new Date(started + minutes * 60_000).toISOString(),
    outcome: null,
    dismissedAt: null,
    dismissNote: null,
    updatedAt: NOW,
  };
}

/** `n` completed runs, all forty minutes, so the median is exactly forty. */
function history(n: number): IssueRun[] {
  return Array.from({ length: n }, (_, i) => run(`issue:${900 + i}`, 40));
}

function task(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: 'ht_1',
    title: 'A thing only you can do',
    detail: null,
    originRef: null,
    partId: null,
    kind: 'ask',
    status: 'open',
    resolution: null,
    agentId: null,
    taskId: null,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    dismissedAt: null,
    ...over,
  };
}

function input(over: Partial<RunwayInput> = {}): RunwayInput {
  return {
    policy: DEFAULT_RUNWAY,
    issues: [],
    pickup: {
      policy: { watchLabel: WATCH, priorityLabels: {}, defaultPriority: 1 },
      cooldown: DEFAULT_COOLDOWN,
      now: NOW,
      tasks: [],
      recentDecisions: [],
      openPrs: [],
      headroom: 0,
      paused: false,
    },
    runs: history(5),
    humanTasks: [],
    cap: 3,
    standing: false,
    ...over,
  };
}

// --- the buckets -----------------------------------------------------------

test('an untagged issue is reservoir, not supply', () => {
  const r = readRunway(
    input({
      issues: [issue(1, { labels: [] }), issue(2, { labels: [] }), issue(3)],
      pickup: { ...input().pickup, headroom: 3 },
    }),
  );
  assert.equal(r.reservoir, 2);
  assert.equal(r.queued, 1);
});

test('a capacity-blocked issue counts as queued — more work than slots is the healthy reading', () => {
  // Headroom zero, so every watched issue reports `blocked` rather than
  // `eligible`. A count that dropped them would report a full backlog as a
  // drought on precisely the fleet that is working hardest.
  const r = readRunway(input({ issues: Array.from({ length: 14 }, (_, i) => issue(i + 1)) }));
  assert.equal(r.queued, 14);
  assert.equal(r.state, 'healthy');
});

test('an unwatched container is a way in, and never double-counts its children', () => {
  // The Feature and its two stories are all untagged. The stories are already in
  // the reservoir under their own numbers, so the Feature adds a cascade to point
  // at rather than two more units of work.
  const feature = issue(10, {
    labels: [],
    issueType: 'Feature',
    children: [
      { number: 11, title: 'a', issueType: 'User Story', workItemState: 'New', state: 'open' },
      { number: 12, title: 'b', issueType: 'User Story', workItemState: 'New', state: 'open' },
    ],
  });
  const r = readRunway(
    input({
      issues: [
        feature,
        issue(11, { labels: [], issueType: 'User Story' }),
        issue(12, { labels: [], issueType: 'User Story' }),
      ],
      pickup: {
        ...input().pickup,
        policy: { watchLabel: WATCH, priorityLabels: {}, defaultPriority: 1, containerTypes: ['Feature'] },
      },
    }),
  );
  assert.equal(r.reservoir, 2);
  assert.equal(r.reservoirContainers, 1);
});

// --- the states ------------------------------------------------------------

test('thin: below the warn band, with the arithmetic in the detail', () => {
  // Three in flight, one waiting: four goals at 13⅓ minutes each is 53 minutes,
  // inside the one-hour warn band.
  const r = readRunway(
    input({
      issues: [
        issue(1, { linkedPrNumber: 7 }),
        issue(2, { linkedPrNumber: 8 }),
        issue(3, { linkedPrNumber: 9 }),
        issue(4),
      ],
      pickup: {
        ...input().pickup,
        openPrs: [7, 8, 9].map((n) => ({
          number: n,
          title: `pr ${n}`,
          branch: `issue/${n - 6}`,
          baseBranch: 'main',
          author: 'x',
          labels: [],
          draft: false,
          merged: false,
          mergeable: true,
          checks: [],
          reviews: [],
          comments: [],
          updatedAt: NOW,
        })) as never,
      },
    }),
  );
  assert.equal(r.state, 'thin');
  assert.equal(r.inflight, 3);
  assert.equal(r.queued, 1);
  assert.equal(r.runwayMinutes, 53);
  assert.match(r.headline, /About 53 minutes of work queued/);
});

test('dry: an empty queue is its own state, not a small runway', () => {
  const r = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  assert.equal(r.state, 'dry');
  assert.equal(r.runwayMinutes, null);
  assert.match(r.headline, /Nothing is queued behind the fleet/);
});

test('starved beats dry: a free slot with nothing to put in it is already idle', () => {
  const r = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 2 } }));
  assert.equal(r.state, 'starved');
  assert.equal(r.idleSlots, 2);
  assert.match(r.headline, /slots are idle/);
});

test('starved and dry need no history at all', () => {
  // The whole point of putting them above `unknown`: a deployment two days old
  // with empty slots is genuinely starved, and withholding that until five goals
  // have completed silences the warning for the week it is most useful.
  const r = readRunway(input({ issues: [], runs: history(1), pickup: { ...input().pickup, headroom: 2 } }));
  assert.equal(r.state, 'starved');
  assert.equal(r.medianLeadMinutes, null);
});

test('unknown: too little history refuses to invent a duration', () => {
  const r = readRunway(input({ issues: [issue(1), issue(2)], runs: history(2) }));
  assert.equal(r.state, 'unknown');
  assert.equal(r.runwayMinutes, null);
  assert.match(r.headline, /Not enough history/);
  assert.match(r.detail, /2 goals have completed/);
});

test('a paused fleet is not starved — somebody stopped it', () => {
  const r = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0, paused: true } }));
  assert.equal(r.state, 'dry');
  assert.equal(r.idleSlots, 0);
});

// --- the second direction --------------------------------------------------

test('latent supply leads the sentence when the fleet is stopped upstream of itself', () => {
  const plans = [{ id: 'plan_1', originRef: 'issue:212', status: 'awaiting_approval' }] as unknown as Plan[];
  const r = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 2, plans } }));
  assert.equal(r.state, 'starved');
  assert.equal(r.latent.plans, 1);
  assert.equal(r.headline, 'The fleet is waiting on you, not on work');
  assert.match(r.detail, /1 plan awaiting approval is standing/);
});

test('the debt clause never counts the runway row itself', () => {
  const r = readRunway(
    input({
      issues: [],
      humanTasks: [task({ id: 'a' }), task({ id: 'b', kind: 'supply', title: 'Nothing is queued behind the fleet' })],
      pickup: { ...input().pickup, headroom: 1 },
    }),
  );
  assert.equal(r.debt, 1);
});

// --- the pass --------------------------------------------------------------

test('healthy files nothing and settles a standing row', () => {
  const reading = readRunway(input({ issues: [issue(1), issue(2), issue(3), issue(4), issue(5), issue(6)] }));
  assert.equal(reading.state, 'healthy');
  const steps = runwayPass({
    reading,
    existing: [task({ id: 'ht_x', kind: 'supply', title: 'About 53 minutes of work queued' })],
    enabled: true,
  });
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['settle'],
  );
});

test('a state change replaces the row rather than stacking a second one', () => {
  const reading = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  const steps = runwayPass({
    reading,
    existing: [task({ id: 'ht_x', kind: 'supply', title: 'About 53 minutes of work queued' })],
    enabled: true,
  });
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['settle', 'file'],
  );
  assert.equal(steps[1]?.kind === 'file' && steps[1].title, 'Nothing is queued behind the fleet');
});

test('a row already standing under this wording is re-filed, so its figures refresh', () => {
  const reading = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  const steps = runwayPass({
    reading,
    existing: [task({ id: 'ht_x', kind: 'supply', title: reading.headline })],
    enabled: true,
  });
  // No settle: the wording is unchanged, so it is the same row. One file, which
  // `recordHumanTask` folds onto it — the detail moves, the id does not, and the
  // notification chain therefore stays quiet.
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['file'],
  );
});

test('an answered row is not raised again under the same wording', () => {
  const reading = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  const steps = runwayPass({
    reading,
    existing: [task({ id: 'ht_x', kind: 'supply', title: reading.headline, status: 'done' })],
    enabled: true,
  });
  assert.deepEqual(steps, []);
});

test('switched off files nothing and still drains the bench', () => {
  const reading = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  const steps = runwayPass({
    reading,
    existing: [task({ id: 'ht_x', kind: 'supply', title: 'About 53 minutes of work queued' })],
    enabled: false,
  });
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['settle'],
  );
});

// --- hysteresis ------------------------------------------------------------

test('a standing row survives a partial recovery — the flap the second threshold exists to stop', () => {
  // Twelve goals is 2h 40m: back above the one-hour warn band, still below the
  // three-hour clear band. Standing, it stays thin; not standing, it would never
  // have filed at that figure in the first place.
  const twelve = Array.from({ length: 12 }, (_, i) => issue(i + 1));
  assert.equal(readRunway(input({ issues: twelve, standing: true })).state, 'thin');
  assert.equal(readRunway(input({ issues: twelve, standing: false })).state, 'healthy');
});

// --- the policy ------------------------------------------------------------

test('a clear threshold at or below the warn threshold is refused at load', () => {
  const bad: RunwayPolicy = { ...DEFAULT_RUNWAY, warnHours: 2, clearHours: 2 };
  assert.throws(() => validateRunwayPolicy(bad), /clearHours/);
  assert.throws(() => validateRunwayPolicy({ ...DEFAULT_RUNWAY, warnHours: 0 }), /warnHours/);
  assert.throws(() => validateRunwayPolicy({ ...DEFAULT_RUNWAY, minimumRuns: 0 }), /minimumRuns/);
  assert.doesNotThrow(() => validateRunwayPolicy(DEFAULT_RUNWAY));
});

test('the median is a median, so one long goal cannot raise the fleet’s own threshold', () => {
  const runs = [...history(4), run('issue:999', 4000)];
  const r = readRunway(input({ issues: [issue(1)], runs }));
  assert.equal(r.medianLeadMinutes, 40);
});

// -- through the harness ------------------------------------------------------

function build(over: Partial<RunwayPolicy> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runway-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      // The gate off, so every open issue is watched and the fixtures below say
      // what they mean without a tag on each one.
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      // Two slots and nothing dispatchable, so the pulse leaves headroom behind
      // and the reading is about supply rather than about capacity.
      maxConcurrentAgents: 2,
      runway: { ...DEFAULT_RUNWAY, ...over },
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

test('a pulse over an empty world files the row, and the next one settles it once work arrives', async () => {
  const system = build();
  const world = new FakeWorldStore(system.store);

  await system.harness.runCycle('manual');
  const filed = system.store.listHumanTasksOfKind('supply');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.status, 'open');
  // Fleet-wide: the row is about the pipeline, not about a goal, and an origin
  // here would file it onto whichever goal happened to be last in the world.
  assert.equal(filed[0]!.originRef, null);
  assert.equal(filed[0]!.agentId, null);
  assert.equal(filed[0]!.partId, null);

  // A second pulse over the same world keeps one row under one id — the detail
  // refreshes, the id does not, which is what keeps the notification quiet.
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listHumanTasksOfKind('supply').map((t) => t.id),
    [filed[0]!.id],
  );

  // Enough work to put the runway back above the clear band. There is no
  // completed history, so the reading is `unknown` — which files nothing and
  // settles what was standing, because a fleet with a full queue is not one
  // anybody needs telling about.
  world.mutate((w) => {
    for (let n = 1; n <= 12; n += 1)
      w.issues.push({
        id: `i${n}`,
        number: n,
        title: `Goal ${n}`,
        body: '',
        labels: [],
        state: 'open',
        linkedPrNumber: null,
      });
  });
  await system.harness.runCycle('manual');
  const settled = system.store.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /recovered/);
});

test('switched off, a pulse files nothing and drains what was standing', async () => {
  const on = build();
  await on.harness.runCycle('manual');
  const standing = on.store.listHumanTasksOfKind('supply');
  assert.equal(standing.length, 1);

  const off = build({ enabled: false });
  await off.harness.runCycle('manual');
  assert.deepEqual(off.store.listHumanTasksOfKind('supply'), []);
});
