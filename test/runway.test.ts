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
import { goalFingerprint } from '../src/intake/appraisal.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { Store } from '../src/store/store.js';
import { RunwayDesk } from '../src/supply/runwayDesk.js';
import type { EscalationSpan, HumanTask, Issue, IssueAppraisal, IssueRun, Plan } from '../src/types.js';

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
    escalations: [],
    cap: 3,
    standing: false,
    ...over,
  };
}

function gate(n: number, over: Partial<IssueAppraisal> = {}): IssueAppraisal {
  const target = issue(n);
  return {
    originRef: `issue:${n}`,
    verdict: 'workable',
    proposedProfile: 'deep',
    goalRef: goalFingerprint(target.title, target.body),
    decidedAt: at(10),
    profileAnsweredAt: null,
    ...over,
  } as unknown as IssueAppraisal;
}

const START = Date.parse('2026-08-20T09:00:00.000Z');

function at(minutes: number): string {
  return new Date(START + minutes * 60_000).toISOString();
}

function hold(originRef: string, from: number, mins: number | null, over: Partial<HumanTask> = {}): HumanTask {
  return task({
    id: `ht_${originRef}_${from}`,
    kind: 'close_out',
    originRef,
    createdAt: at(from),
    resolvedAt: mins === null ? null : at(from + mins),
    status: mins === null ? 'open' : 'done',
    ...over,
  });
}

function span(over: Partial<EscalationSpan> = {}): EscalationSpan {
  return { createdAt: at(0), answeredAt: null, originRef: null, prNumber: null, open: true, ...over };
}

function one(originRef: string, minutes: number, over: Partial<IssueRun> = {}): IssueRun[] {
  return [{ ...run(originRef, minutes), ...over }];
}

const ONE_RUN: RunwayPolicy = { ...DEFAULT_RUNWAY, minimumRuns: 1 };

test('a hold is subtracted from the lead time — the median is fleet time, not calendar time', () => {
  const r = readRunway(input({ policy: ONE_RUN, runs: one('issue:1', 100), humanTasks: [hold('issue:1', 20, 30)] }));
  assert.equal(r.medianLeadMinutes, 70);
  assert.equal(r.medianHeldMinutes, 30);
});

test('overlapping holds are unioned, never summed — over-subtracting is the same bug pointed the other way', () => {
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      humanTasks: [hold('issue:1', 10, 40), hold('issue:1', 30, 40, { id: 'ht_b' })],
    }),
  );
  assert.equal(r.medianHeldMinutes, 60);
  assert.equal(r.medianLeadMinutes, 40);
});

test('a hold still standing runs to the end of the run and no further', () => {
  const r = readRunway(input({ policy: ONE_RUN, runs: one('issue:1', 100), humanTasks: [hold('issue:1', 60, null)] }));
  assert.equal(r.medianHeldMinutes, 40);
  assert.equal(r.medianLeadMinutes, 60);
});

test('a goal whose whole span is one hold is dropped, not counted as zero work', () => {
  const r = readRunway(
    input({
      issues: [issue(1)],
      runs: [...history(4), run('issue:500', 40)],
      humanTasks: [hold('issue:500', 0, 40)],
    }),
  );
  assert.equal(r.completedRuns, 4);
  assert.equal(r.unmeasuredRuns, 1);
  assert.equal(r.medianLeadMinutes, null);
  assert.equal(r.state, 'unknown');
});

test('`unknown` counts the population the median was taken over, never the raw completed rows', () => {
  const covered = readRunway(
    input({
      issues: [issue(1)],
      runs: history(8),
      humanTasks: history(8).map((r, i) => hold(r.originRef, 0, 40, { id: `ht_${i}` })),
    }),
  );
  assert.equal(covered.state, 'unknown');
  assert.equal(covered.completedRuns, 0);
  assert.equal(covered.unmeasuredRuns, 8);
  assert.ok(
    !/\b([5-9]|\d{2,}) goals? ha[sv]e? completed\b/.test(covered.detail),
    `the sentence must not state a completed count at or above minimumRuns: ${covered.detail}`,
  );
  assert.match(covered.detail, /0 of 8 completed goals left fleet time to measure/);

  const zeroLength = readRunway(input({ issues: [issue(1)], runs: history(8).map((r) => ({ ...r, completedAt: r.startedAt })) })); // prettier-ignore
  assert.equal(zeroLength.state, 'unknown');
  assert.equal(zeroLength.completedRuns, 0);
  assert.equal(zeroLength.unmeasuredRuns, 8);
  assert.match(zeroLength.detail, /0 of 8 completed goals left fleet time to measure/);
});

test('a burn notice and a standalone ask are not holds — the fleet is working through both', () => {
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      humanTasks: [
        hold('issue:1', 0, 100, { id: 'ht_burn', kind: 'burn' }),
        hold('issue:1', 0, 100, { id: 'ht_ask', kind: 'ask' }),
      ],
    }),
  );
  assert.equal(r.medianLeadMinutes, 100);
  assert.equal(r.medianHeldMinutes, 0);

  const part = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      humanTasks: [hold('issue:1', 0, 100, { id: 'ht_part', kind: 'ask', partId: 'part_1' })],
    }),
  );
  assert.equal(part.medianLeadMinutes, null);
});

test('an escalation reaches its goal through the pull request the run recorded', () => {
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100, { linkedPrNumber: 42 }),
      escalations: [span({ prNumber: 42, createdAt: at(20), answeredAt: at(80), open: false })],
    }),
  );
  assert.equal(r.medianHeldMinutes, 60);

  const dismissed = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100, { linkedPrNumber: 42 }),
      escalations: [span({ prNumber: 42, createdAt: at(20), answeredAt: null, open: false })],
    }),
  );
  assert.equal(dismissed.medianHeldMinutes, 0);
});

test('the profile gate is a hold, and the runway row is never one', () => {
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, appraisals: [gate(1, { profileAnsweredAt: at(70) })] },
      humanTasks: [task({ id: 'ht_s', kind: 'supply', originRef: 'issue:1', createdAt: at(0), resolvedAt: at(100) })],
    }),
  );
  assert.equal(r.medianHeldMinutes, 60);
  assert.equal(r.medianLeadMinutes, 40);
});

test('fleet time puts the warn band back in range — the same queue reads healthy on calendar time', () => {
  const runs = Array.from({ length: 5 }, (_, i) => run(`issue:${600 + i}`, 24 * 60));
  const holds = runs.map((r, i) => hold(r.originRef, 60, 22 * 60, { id: `ht_${i}` }));
  const queue = { issues: [issue(1), issue(2)], cap: 5, runs };

  const fleet = readRunway(input({ ...queue, humanTasks: holds }));
  assert.equal(fleet.medianLeadMinutes, 120);
  assert.equal(fleet.medianHeldMinutes, 22 * 60);
  assert.equal(fleet.runwayMinutes, 48);
  assert.equal(fleet.state, 'thin');
  assert.match(fleet.detail, /median goal of fleet time/);
  assert.match(fleet.detail, /median calendar span is 24h/);

  const calendar = readRunway(input({ ...queue, humanTasks: [] }));
  assert.equal(calendar.medianLeadMinutes, 24 * 60);
  assert.equal(calendar.runwayMinutes, 576);
  assert.equal(calendar.state, 'healthy');
});

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
  const r = readRunway(input({ issues: Array.from({ length: 14 }, (_, i) => issue(i + 1)) }));
  assert.equal(r.queued, 14);
  assert.equal(r.state, 'healthy');
});

test('an unwatched container is a way in, and never double-counts its children', () => {
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

test('thin: below the warn band, with the arithmetic in the detail', () => {
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
  assert.match(r.headline, /The queue is thinning/);
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
  assert.match(r.headline, /Slots are idle with nothing to take/);
});

test('starved and dry need no history at all', () => {
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

test('an unanswered profile proposal is not a hold — the goal shipped, so it was not held', () => {
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, appraisals: [gate(1)] },
    }),
  );
  assert.equal(r.medianHeldMinutes, 0);
  assert.equal(r.medianLeadMinutes, 100);
});

test('a rewritten ticket released the gate, and the bucket and the subtraction agree about that', () => {
  const stale = gate(1, { goalRef: 'notthetickettheyread', profileAnsweredAt: at(70) });
  const held = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, appraisals: [gate(1, { profileAnsweredAt: at(70) })] },
    }),
  );
  const released = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, appraisals: [stale] },
    }),
  );
  assert.equal(held.medianHeldMinutes, 60);
  assert.equal(released.medianHeldMinutes, 0);
  assert.equal(released.medianLeadMinutes, 100);
});

test('every headline is a function of the state alone, so no figure can move it', () => {
  const cases: { state: string; a: RunwayInput; b: RunwayInput }[] = [
    {
      state: 'starved',
      a: input({ issues: [], pickup: { ...input().pickup, headroom: 1 }, cap: 3 }),
      b: input({ issues: [], pickup: { ...input().pickup, headroom: 3 }, cap: 3 }),
    },
    {
      state: 'dry',
      a: input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }),
      b: input({ issues: [issue(1, { labels: [] })], pickup: { ...input().pickup, headroom: 0 } }),
    },
    {
      state: 'thin',
      a: input({ issues: [issue(1), issue(2), issue(3)] }),
      b: input({ issues: [issue(1), issue(2), issue(3), issue(4)] }),
    },
    {
      state: 'healthy',
      a: input({ issues: Array.from({ length: 9 }, (_, i) => issue(i + 1)) }),
      b: input({ issues: Array.from({ length: 14 }, (_, i) => issue(i + 1)) }),
    },
    {
      state: 'unknown',
      a: input({ policy: { ...DEFAULT_RUNWAY, minimumRuns: 50 }, issues: [issue(1)] }),
      b: input({ policy: { ...DEFAULT_RUNWAY, minimumRuns: 50 }, issues: [issue(1), issue(2)] }),
    },
  ];
  for (const c of cases) {
    const a = readRunway(c.a);
    const b = readRunway(c.b);
    assert.equal(a.headline, b.headline, `${c.state}: the headline moved with the figures`);
    assert.notEqual(a.detail, b.detail, `${c.state}: the two readings are the same reading`);
  }
});

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

test('a thin fleet whose queue drifts keeps one row, and so notifies once', () => {
  const queues = [
    [1, 2, 3],
    [1, 2, 3, 4],
    [1, 2, 3],
    [1, 2],
  ];
  const titles = new Set<string>();
  let standing: HumanTask | null = null;
  for (const q of queues) {
    const reading = readRunway(input({ issues: q.map((n) => issue(n)) }));
    assert.equal(reading.state, 'thin');
    const steps = runwayPass({ reading, existing: standing ? [standing] : [], enabled: true });
    assert.deepEqual(
      steps.map((s) => s.kind),
      ['file'],
      `queue of ${q.length}: the row was replaced rather than refreshed`,
    );
    const filed = steps[0];
    if (filed?.kind !== 'file') throw new Error('unreachable');
    titles.add(filed.title);
    standing = task({ id: 'ht_x', kind: 'supply', title: filed.title });
  }
  assert.equal(titles.size, 1);
});

test('a row already standing under this wording is re-filed, so its figures refresh', () => {
  const reading = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  const steps = runwayPass({
    reading,
    existing: [task({ id: 'ht_x', kind: 'supply', title: reading.headline })],
    enabled: true,
  });
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

test('the desk’s own supersede is not an answer: the same state files again, on one row', () => {
  const dry = readRunway(input({ issues: [], pickup: { ...input().pickup, headroom: 0 } }));
  const healthy = readRunway(input({ issues: [1, 2, 3, 4, 5, 6].map((n) => issue(n)) }));
  assert.equal(dry.state, 'dry');
  assert.equal(healthy.state, 'healthy');

  const first = runwayPass({ reading: dry, existing: [], enabled: true });
  assert.deepEqual(
    first.map((s) => s.kind),
    ['file'],
  );
  const filed = task({ id: 'ht_x', kind: 'supply', title: dry.headline });
  const settle = runwayPass({ reading: healthy, existing: [filed], enabled: true });
  assert.equal(settle[0]?.kind, 'settle');
  const settled = task({
    ...filed,
    status: 'done',
    resolution: settle[0]?.kind === 'settle' ? settle[0].resolution : null,
  });

  const again = runwayPass({ reading: dry, existing: [settled], enabled: true });
  assert.deepEqual(
    again.map((s) => s.kind),
    ['reopen'],
    'the fleet is dry a second time and the bench says so',
  );
  assert.equal(again[0]?.kind === 'reopen' && again[0].taskId, 'ht_x');

  const answered = task({ id: 'ht_x', kind: 'supply', title: dry.headline, status: 'done' });
  assert.deepEqual(runwayPass({ reading: dry, existing: [answered], enabled: true }), []);
});

test('a fleet that goes dry twice files twice, through the real desk and store', () => {
  const store = new Store(':memory:');
  const desk = new RunwayDesk(store, DEFAULT_RUNWAY);
  const deskInput = (issues: Issue[]) => {
    const full = input({ issues });
    return { issues: full.issues, pickup: full.pickup, cap: full.cap };
  };
  const empty: Issue[] = [];
  const stocked = [1, 2, 3, 4, 5, 6].map((n) => issue(n));

  const openSupply = () => store.listHumanTasksOfKind('supply').filter((t) => t.status === 'open');

  assert.equal(desk.run(deskInput(empty)).state, 'dry');
  assert.equal(openSupply().length, 1, 'the first dry spell is on the bench');
  assert.equal(desk.run(deskInput(stocked)).state, 'unknown');
  assert.equal(openSupply().length, 0, 'and the recovery clears it');

  assert.equal(desk.run(deskInput(empty)).state, 'dry');
  assert.equal(openSupply().length, 1, 'the second one is on it too — silence here is the bug');
  assert.equal(store.listHumanTasksOfKind('supply').length, 1, 'on one row, never a second describing one fleet');
  assert.ok(
    store.listHumanTasks().some((t) => t.kind === 'supply' && t.status === 'open'),
    'and on the bench feed the cockpit actually draws',
  );

  store.close();
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

test('a standing row survives a partial recovery — the flap the second threshold exists to stop', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => issue(i + 1));
  assert.equal(readRunway(input({ issues: twelve, standing: true })).state, 'thin');
  assert.equal(readRunway(input({ issues: twelve, standing: false })).state, 'healthy');
});

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

function build(over: Partial<RunwayPolicy> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runway-'));
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
  assert.equal(filed[0]!.originRef, null);
  assert.equal(filed[0]!.agentId, null);
  assert.equal(filed[0]!.partId, null);

  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listHumanTasksOfKind('supply').map((t) => t.id),
    [filed[0]!.id],
  );

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

test('the band reads a standing supply row off the whole bench, not the hundred-row feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runway-cap-'));
  const dbPath = join(dir, 'runway.sqlite');
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath,
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 2,
      runway: DEFAULT_RUNWAY,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );

  const world = new FakeWorldStore(system.store);
  const queue = (from: number, to: number): void =>
    world.mutate((w) => {
      for (let n = from; n <= to; n += 1)
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

  queue(1, 2);

  let clock = Date.parse('2026-08-01T00:00:00.000Z');
  const history = new Store(dbPath, () => new Date(clock).toISOString());
  for (let n = 101; n <= 105; n += 1) {
    const run = {
      originRef: `issue:${n}`,
      issueNumber: n,
      title: `Done ${n}`,
      body: '',
      labels: [],
      linkedPrNumber: null,
      workItemState: null,
    };
    history.recordIssueRun({ ...run, complete: false });
    clock += 40 * 60_000;
    history.recordIssueRun({ ...run, complete: true });
    clock += 60_000;
  }
  history.close();

  await system.harness.runCycle('manual');
  const standing = system.store.listHumanTasksOfKind('supply');
  assert.equal(standing.length, 1);
  assert.equal(standing[0]!.status, 'open');

  queue(3, 6);
  await system.harness.runCycle('manual');
  assert.equal(system.store.listHumanTasksOfKind('supply')[0]!.status, 'open');
  assert.equal(buildStateSnapshot(system).runway.state, 'thin');

  for (let n = 0; n < 101; n += 1)
    system.store.recordHumanTask({
      title: `Close out ${n}`,
      detail: 'x',
      agentId: null,
      taskId: null,
      originRef: `issue:${1000 + n}`,
      kind: 'close_out',
    });
  assert.equal(
    system.store.listHumanTasks().some((t) => t.kind === 'supply' && t.status === 'open'),
    false,
    'the capped feed has lost the standing row — which is the whole hazard',
  );

  assert.equal(system.store.listHumanTasksOfKind('supply')[0]!.status, 'open');
  assert.equal(buildStateSnapshot(system).runway.state, 'thin');

  await system.harness.runCycle('manual');
  assert.equal(system.store.listHumanTasksOfKind('supply')[0]!.status, 'open');
});
