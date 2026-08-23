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
import { goalFingerprint } from '../src/intake/assay.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { EscalationSpan, HumanTask, Issue, IssueAssay, IssueRun, Plan } from '../src/types.js';

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
    escalations: [],
    cap: 3,
    standing: false,
    ...over,
  };
}

/**
 * An assay proposing a profile on issue `n`, fingerprinted against the very
 * ticket {@link issue} builds — because a stale `goalRef` *releases* the gate,
 * which is the half `humanHolds` used not to ask about.
 */
function gate(n: number, over: Partial<IssueAssay> = {}): IssueAssay {
  const target = issue(n);
  return {
    originRef: `issue:${n}`,
    verdict: 'workable',
    proposedProfile: 'deep',
    goalRef: goalFingerprint(target.title, target.body),
    decidedAt: at(10),
    profileAnsweredAt: null,
    ...over,
  } as unknown as IssueAssay;
}

const START = Date.parse('2026-08-20T09:00:00.000Z');

/** `n` minutes after every fixture run's start, as an ISO instant. */
function at(minutes: number): string {
  return new Date(START + minutes * 60_000).toISOString();
}

/**
 * A hold on `originRef`, `from` minutes into its run and `mins` long — or still
 * standing when `mins` is null.
 *
 * `close_out` by default because it is the least arguable of the kinds: the
 * harness has said the goal is finished and filed the row itself, so nothing
 * moves until a person acts.
 */
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

/** One completed run, so a case can state the calendar span it is subtracting from. */
function one(originRef: string, minutes: number, over: Partial<IssueRun> = {}): IssueRun[] {
  return [{ ...run(originRef, minutes), ...over }];
}

/** The policy that trusts a single run, so a case can be about one goal's arithmetic. */
const ONE_RUN: RunwayPolicy = { ...DEFAULT_RUNWAY, minimumRuns: 1 };

// --- fleet time ------------------------------------------------------------

test('a hold is subtracted from the lead time — the median is fleet time, not calendar time', () => {
  const r = readRunway(input({ policy: ONE_RUN, runs: one('issue:1', 100), humanTasks: [hold('issue:1', 20, 30)] }));
  assert.equal(r.medianLeadMinutes, 70);
  assert.equal(r.medianHeldMinutes, 30);
});

test('overlapping holds are unioned, never summed — over-subtracting is the same bug pointed the other way', () => {
  // Forty minutes each and they overlap by twenty, so the goal waited an hour.
  // Added up they would be eighty, and the goal would read as forty minutes of
  // fleet time less than it was.
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
  // Filed forty minutes before the goal completed and never answered. The span
  // inside the run is what the median loses; the weeks it has stood since are
  // not part of a lead time at all.
  const r = readRunway(input({ policy: ONE_RUN, runs: one('issue:1', 100), humanTasks: [hold('issue:1', 60, null)] }));
  assert.equal(r.medianHeldMinutes, 40);
  assert.equal(r.medianLeadMinutes, 60);
});

test('a goal whose whole span is one hold is dropped, not counted as zero work', () => {
  // Four ordinary goals and one that never left the bench. Admitting it at zero
  // would drag the median towards nothing and leave the deployment permanently
  // thin; dropping it takes the history under `minimumRuns`, which is the honest
  // answer — there are four goals' worth of evidence, not five.
  const r = readRunway(
    input({
      issues: [issue(1)],
      runs: [...history(4), run('issue:500', 40)],
      humanTasks: [hold('issue:500', 0, 40)],
    }),
  );
  assert.equal(r.completedRuns, 5);
  assert.equal(r.medianLeadMinutes, null);
  assert.equal(r.state, 'unknown');
});

test('a burn notice and a standalone ask are not holds — the fleet is working through both', () => {
  // A burn notice kills nothing: the expensive agent carries straight on. A
  // standalone ask blocks nothing either, by `HumanTask`'s own rule — only one
  // that *is* a plan part is a node the reconciler holds work behind.
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

  // The same ask, declared by a planner as a step for a person, does hold.
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
  // The merge and reply arms carry `prNumber` and no ref at all, so `linkedPrNumber`
  // is the only join there is — and without it the longest waits on the deployment
  // would be the ones that went unsubtracted.
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100, { linkedPrNumber: 42 }),
      escalations: [span({ prNumber: 42, createdAt: at(20), answeredAt: at(80), open: false })],
    }),
  );
  assert.equal(r.medianHeldMinutes, 60);

  // Dismissed without an answer: `dismissEscalation` stamps no time, so when the
  // hold ended is recorded nowhere and counting it would subtract an afternoon
  // nobody waited.
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
      // The gate is read through `assayHold`, so the goal it stopped has to be in
      // front of the lens and the assay has to still be about that ticket.
      issues: [issue(1)],
      pickup: { ...input().pickup, assays: [gate(1, { profileAnsweredAt: at(70) })] },
      // A `supply` row carries no origin and could not attach to a goal anyway —
      // asserted here because "the reading must not describe itself" is the rule,
      // not the accident.
      humanTasks: [task({ id: 'ht_s', kind: 'supply', originRef: 'issue:1', createdAt: at(0), resolvedAt: at(100) })],
    }),
  );
  assert.equal(r.medianHeldMinutes, 60);
  assert.equal(r.medianLeadMinutes, 40);
});

test('fleet time puts the warn band back in range — the same queue reads healthy on calendar time', () => {
  // The shape of the operator's own deployment: five slots, goals that take a
  // day of wall clock and two hours of fleet, because the rest of the day was a
  // close-out nobody had got to. Two goals queued.
  //
  // On calendar time the warn band is unreachable — 2 x 1440 / 5 is nine and a
  // half hours, and `thin` at an hour would need supply under a quarter of a
  // goal. The whole hysteresis design is dead on that deployment. On fleet time
  // the same queue is 48 minutes, which is what it is.
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

test('an unanswered profile proposal is not a hold — the goal shipped, so it was not held', () => {
  // The failure this pins: `decided_at → null` clamps to the end of the run, so an
  // assay nobody answered subtracts every minute of a goal that demonstrably
  // completed. A proposal nobody answers never ends, so the run is dropped from
  // the median for good and the runway dies on that deployment.
  const r = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, assays: [gate(1)] },
    }),
  );
  assert.equal(r.medianHeldMinutes, 0);
  assert.equal(r.medianLeadMinutes, 100);
});

test('a rewritten ticket released the gate, and the bucket and the subtraction agree about that', () => {
  // Two matchers for one claim is the shape: `assayHold` is what the queue bucket
  // asks, and it releases the hold the moment the ticket no longer fingerprints to
  // what the assayer read. A subtraction that did not ask would erase the run of a
  // goal the same reading counts as unheld.
  const stale = gate(1, { goalRef: 'notthetickettheyread', profileAnsweredAt: at(70) });
  const held = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, assays: [gate(1, { profileAnsweredAt: at(70) })] },
    }),
  );
  const released = readRunway(
    input({
      policy: ONE_RUN,
      runs: one('issue:1', 100),
      issues: [issue(1)],
      pickup: { ...input().pickup, assays: [stale] },
    }),
  );
  assert.equal(held.medianHeldMinutes, 60);
  assert.equal(released.medianHeldMinutes, 0);
  assert.equal(released.medianLeadMinutes, 100);
});

test('every headline is a function of the state alone, so no figure can move it', () => {
  // The title is `recordHumanTask`'s dedup key *and* the identity the notification
  // chain diffs on, so a figure in it re-files the row and re-notifies every time
  // the queue moves by one. Two readings per state differing only in their figures
  // must therefore carry the same headline.
  const cases: { state: string; a: RunwayInput; b: RunwayInput }[] = [
    {
      state: 'starved',
      a: input({ issues: [], pickup: { ...input().pickup, headroom: 1 }, cap: 3 }),
      b: input({ issues: [], pickup: { ...input().pickup, headroom: 3 }, cap: 3 }),
    },
    {
      state: 'dry',
      // An unwatched issue moves the reservoir clause without touching the queue,
      // so both readings are dry and their figures differ.
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
    // The figures did move — otherwise the case above proves nothing.
    assert.notEqual(a.detail, b.detail, `${c.state}: the two readings are the same reading`);
  }
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

test('a thin fleet whose queue drifts keeps one row, and so notifies once', () => {
  // The regression #546 filed: with the runway in the title, every issue added or
  // removed settled the row and filed a new one under a new id — a fresh desktop
  // notification per pulse, and, once every wording in range was spent, silence
  // for good. Driven as a sequence because one pulse cannot show it.
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
    // Never a settle: the state did not change, so the row did not either.
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
