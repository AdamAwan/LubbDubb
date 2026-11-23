import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ReliabilityPayload } from '../src/wire.js';
import { buildLessonInsights, lessonInsightsSince } from '../src/insights/lessonInsights.js';
import { LESSON_WINDOW_MS } from '../src/lessons/groups.js';
import type { LessonDraft, Remedy } from '../src/types.js';

// → docs/spec/41-repo-lessons.md#did-it-work

const DAY = 24 * 60 * 60 * 1000;
const MERGED = Date.parse('2026-06-01T00:00:00Z');
const at = (days: number) => new Date(MERGED + days * DAY).toISOString();

let seq = 0;

function remedy(prNumber: number, days: number, over: Partial<Remedy> = {}): Remedy {
  seq += 1;
  return {
    id: `rem-${seq}`,
    kind: 'ci',
    originRef: `pr:${prNumber}:ci`,
    prNumber,
    cause: 'missed_gate',
    guard: 'undocumented',
    summary: 'lint went red',
    checks: ['lint'],
    agentId: `a-${seq}`,
    taskId: `t-${seq}`,
    createdAt: at(days),
    updatedAt: at(days),
    ...over,
  };
}

function draft(over: Partial<LessonDraft> = {}): LessonDraft {
  return {
    id: 'lsn_1',
    groupKey: 'ci/missed_gate/lint',
    kind: 'ci',
    cause: 'missed_gate',
    where: 'lint',
    goals: ['issue:1', 'issue:2'],
    misses: [],
    status: 'adopted',
    taskId: 't',
    fix: 'guard',
    title: 'Run lint before pushing',
    summary: null,
    reason: null,
    prNumber: 90,
    ticketRef: null,
    createdAt: at(-5),
    settledAt: at(0),
    ...over,
  };
}

function ciReturns(days: number[], prNumber = 1) {
  return days.map((d) => ({ prNumber, kind: 'ci' as const, createdAt: at(d) }));
}

function read(over: Partial<Parameters<typeof buildLessonInsights>[0]> = {}) {
  return buildLessonInsights({
    drafts: [draft()],
    remedies: [],
    retroMisses: [],
    retroSince: null,
    threadLabels: [],
    goalOfPr: new Map(),
    excludedPrs: new Set([90]),
    excludedGoals: new Set(),
    reviewAreas: [],
    returnDispatches: [],
    now: MERGED + 31 * DAY,
    ...over,
  });
}

test('the rate is the group’s misses in distinct goals per same-kind return dispatch, each side of the merge', () => {
  const insights = read({
    remedies: [remedy(1, -10), remedy(1, -9), remedy(2, -3), remedy(3, 12)],
    returnDispatches: [
      ...ciReturns([-10, -9, -3, -2]),
      { prNumber: 5, kind: 'review', createdAt: at(-4) },
      ...ciReturns([5, 12, 20, 25, 28]),
      ...ciReturns([-1, 3], 90),
    ],
  });
  const [row] = insights.drafts;
  assert.deepEqual(
    row!.before,
    { misses: 2, returns: 4 },
    'two goals, four CI returns; review and the lesson PR left out',
  );
  assert.deepEqual(row!.after, { misses: 1, returns: 5 });
  assert.equal(row!.verdict, 'working');
  assert.equal(row!.prRef, 'pr:90');
  assert.equal(row!.mergedAt, at(0));
});

test('the after side is null, and the verdict too early, until 30 days have passed since the merge', () => {
  const insights = read({ remedies: [remedy(1, -2)], now: MERGED + 29 * DAY });
  assert.equal(insights.drafts[0]!.after, null);
  assert.equal(insights.drafts[0]!.verdict, 'too-early');
  assert.equal(insights.tooEarly, 1);
  assert.equal(read({ now: MERGED + LESSON_WINDOW_MS }).drafts[0]!.verdict, 'working', 'exactly 30 days is elapsed');
});

test('a miss that keeps coming back at the same rate or worse is not working', () => {
  const insights = read({
    remedies: [remedy(1, -3), remedy(2, 4), remedy(3, 8)],
    returnDispatches: [...ciReturns([-3, -2]), ...ciReturns([4, 8])],
  });
  assert.equal(insights.drafts[0]!.verdict, 'not-working');
  assert.equal(insights.notWorking, 1);
});

test('a miss with no return dispatch to divide by is not working, never a zero rate', () => {
  const insights = read({ remedies: [remedy(1, -3), remedy(2, 1)], returnDispatches: ciReturns([-3, -1]) });
  assert.deepEqual(insights.drafts[0]!.after, { misses: 1, returns: 0 });
  assert.equal(insights.drafts[0]!.verdict, 'not-working');
});

test('no miss after the merge is working; remedies past the after side are not counted', () => {
  const insights = read({ remedies: [remedy(1, -3), remedy(2, 40)], returnDispatches: ciReturns([-3, 40]) });
  assert.deepEqual(insights.drafts[0]!.after, { misses: 0, returns: 0 });
  assert.equal(insights.drafts[0]!.verdict, 'working');
});

test('a draft not adopted carries its refs and no reading; newest first', () => {
  const insights = read({
    drafts: [
      draft(),
      draft({
        id: 'lsn_2',
        status: 'filed',
        prNumber: null,
        ticketRef: 'issue:77',
        settledAt: at(2),
        createdAt: at(1),
      }),
    ],
  });
  const [filed, adopted] = insights.drafts;
  assert.equal(filed!.id, 'lsn_2');
  assert.equal(filed!.ticketRef, 'issue:77');
  assert.equal(filed!.before, null);
  assert.equal(filed!.verdict, null);
  assert.equal(adopted!.status, 'adopted');
  assert.equal(insights.adopted, 1);
});

test('the reading needs remedies from 30 days before the earliest adopted merge, and none with nothing adopted', () => {
  assert.equal(lessonInsightsSince([draft({ status: 'declined' })]), null);
  assert.equal(lessonInsightsSince([draft(), draft({ settledAt: at(10) })]), at(-30));
});

test('the lessons reading rides on the reliability payload, adopted lessons too early until 30 days pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lesson-insights-'));
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  const opened = system.store.lessons.openDraft({
    groupKey: 'ci/missed_gate/lint',
    kind: 'ci',
    cause: 'missed_gate',
    where: 'lint',
    goals: ['issue:1', 'issue:2'],
    misses: [],
    briefing: 'evidence',
  });
  system.store.lessons.settle(opened!.id, 'adopted', ['pending']);
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/reliability?window=6h' });
  assert.equal(res.statusCode, 200);
  const { lessons } = res.json() as ReliabilityPayload;
  assert.equal(lessons.drafts.length, 1);
  assert.equal(lessons.drafts[0]!.status, 'adopted');
  assert.equal(lessons.drafts[0]!.verdict, 'too-early');
  assert.equal(lessons.tooEarly, 1);
  await app.close();
  system.store.close();
});
