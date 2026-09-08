import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThroughputInsights, THROUGHPUT_EVENT_KINDS } from '../src/throughputInsights.js';
import { diffWorlds } from '../src/world/worldDiff.js';
import type { PrReplySent, WorldEvent, WorldEventKind, WorldSnapshot } from '../src/types.js';
import { resolveWindow, type InsightsWindow } from '../src/insightsWindow.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ThroughputPayload } from '../src/wire.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function event(kind: WorldEventKind, ref: string | null, at: number, summary = `${kind} ${ref}`): WorldEvent {
  seq += 1;
  return { id: `we_${seq}`, kind, ref, summary, createdAt: iso(at) };
}

function reply(prNumber: number, at: number): PrReplySent {
  seq += 1;
  return { prNumber, threadId: `t${seq}`, commentRef: `c${seq}`, sentAt: iso(at) };
}

function build(
  over: { events?: WorldEvent[]; replies?: PrReplySent[] },
  key: InsightsWindow = '7d',
  now: number = NOW,
) {
  return buildThroughputInsights({
    events: over.events ?? [],
    replies: over.replies ?? [],
    window: resolveWindow(key, now, null),
    now,
  });
}

const count = (insights: ReturnType<typeof build>, measure: string): number =>
  insights.totals.find((t) => t.measure === measure)?.count ?? 0;

test('every measure is counted off the record the activity feed already keeps', () => {
  const insights = build({
    events: [
      event('pr_opened', 'pr:1', NOW - 5 * HOUR),
      event('pr_opened', 'pr:2', NOW - 4 * HOUR),
      event('pr_merged', 'pr:1', NOW - 2 * HOUR),
      event('pr_closed', 'pr:2', NOW - HOUR),
      event('pr_approved', 'pr:1', NOW - 3 * HOUR),
      event('pr_comment', 'pr:1', NOW - 4 * HOUR),
      event('pr_comment', 'pr:1', NOW - 3 * HOUR),
      event('issue_opened', 'issue:9', NOW - 6 * HOUR),
      event('issue_closed', 'issue:9', NOW - HOUR),
    ],
    replies: [reply(1, NOW - 3 * HOUR)],
  });

  assert.equal(count(insights, 'pr-opened'), 2);
  assert.equal(count(insights, 'pr-merged'), 1);
  assert.equal(count(insights, 'pr-closed'), 1);
  assert.equal(count(insights, 'pr-approved'), 1);
  assert.equal(count(insights, 'review-received'), 2);
  assert.equal(count(insights, 'reply-sent'), 1);
  assert.equal(count(insights, 'issue-opened'), 1);
  assert.equal(count(insights, 'issue-closed'), 1);
});

test('the merge rate is over what settled, never over what opened', () => {
  // Three opened in the window and one of them merged, but the other merge is of
  // a pull request opened before it: a rate over `opened` would read 67%, and a
  // window that opens mid-flight could put it above one.
  const insights = build({
    events: [
      event('pr_opened', 'pr:1', NOW - 5 * HOUR),
      event('pr_opened', 'pr:2', NOW - 5 * HOUR),
      event('pr_opened', 'pr:3', NOW - 5 * HOUR),
      event('pr_merged', 'pr:1', NOW - HOUR),
      event('pr_merged', 'pr:99', NOW - HOUR),
      event('pr_closed', 'pr:2', NOW - HOUR),
    ],
  });

  assert.equal(insights.landing.opened, 3);
  assert.equal(insights.landing.settled, 3);
  assert.equal(insights.landing.merged, 2);
  assert.equal(insights.landing.abandoned, 1);
  assert.equal(insights.landing.mergeRate, 2 / 3);
});

test('time to merge pairs an opening with its own merge, and counts no other', () => {
  const insights = build({
    events: [
      event('pr_opened', 'pr:1', NOW - 10 * HOUR),
      event('pr_merged', 'pr:1', NOW - 8 * HOUR),
      event('pr_opened', 'pr:2', NOW - 6 * HOUR),
      event('pr_merged', 'pr:2', NOW - 2 * HOUR),
      // Opened before the window's events, so it contributes a merge and no span.
      event('pr_merged', 'pr:3', NOW - HOUR),
    ],
  });

  assert.equal(insights.landing.paired, 2);
  assert.equal(insights.landing.medianToMergeMs, 4 * HOUR);
  assert.equal(insights.landing.slowestToMergeMs, 4 * HOUR);
  assert.equal(insights.busiest.length, 0, 'a pull request nobody commented on is not in the busiest table');
});

test('replies are the fleet’s own row, and the only one marked so', () => {
  const insights = build({
    events: [event('pr_comment', 'pr:7', NOW - 4 * HOUR), event('pr_comment', 'pr:7', NOW - 3 * HOUR)],
    replies: [reply(7, NOW - 2 * HOUR)],
  });

  assert.deepEqual(
    insights.totals.filter((t) => t.ours).map((t) => t.measure),
    ['reply-sent'],
  );
  assert.equal(insights.conversation.received, 2);
  assert.equal(insights.conversation.replied, 1);
  assert.equal(insights.conversation.replyRate, 0.5);
  assert.deepEqual(
    insights.busiest.map((s) => [s.ref, s.commentsReceived, s.repliesSent]),
    [['pr:7', 2, 1]],
  );
});

test('a reply on a pull request the window saw nothing else of still lands on its row', () => {
  const insights = build({ replies: [reply(42, NOW - HOUR)] });
  assert.deepEqual(
    insights.busiest.map((s) => [s.ref, s.prNumber, s.repliesSent]),
    [['pr:42', 42, 1]],
  );
  assert.equal(insights.conversation.replyRate, null, 'no comment came in, so there is no rate to state');
});

test('everything outside the window is dropped before anything is folded', () => {
  const insights = build(
    {
      events: [event('pr_merged', 'pr:1', NOW - 30 * HOUR), event('pr_merged', 'pr:2', NOW - 2 * HOUR)],
      replies: [reply(1, NOW - 30 * HOUR), reply(2, NOW - 2 * HOUR)],
    },
    '24h',
  );

  assert.equal(insights.landing.merged, 1);
  assert.equal(count(insights, 'reply-sent'), 1);
  assert.equal(
    insights.timeline.buckets.reduce((a, b) => a + b.merged + b.replies, 0),
    2,
  );
});

test('the per-day rate is over the window the reading was taken for', () => {
  const insights = build(
    { events: [event('pr_merged', 'pr:1', NOW - HOUR), event('pr_merged', 'pr:2', NOW - HOUR)] },
    '24h',
  );
  assert.equal(insights.spanMs, 24 * HOUR);
  assert.equal(insights.totals.find((t) => t.measure === 'pr-merged')?.perDay, 2);
});

test('all time takes its rate from the oldest thing it holds, not from a span it does not have', () => {
  const insights = build({ events: [event('pr_merged', 'pr:1', NOW - 48 * HOUR)] }, 'all');
  assert.equal(insights.window.since, null);
  assert.equal(insights.spanMs, 48 * HOUR);
  assert.equal(insights.totals.find((t) => t.measure === 'pr-merged')?.perDay, 0.5);
});

test('the kinds the route reads are the kinds the fold counts', () => {
  const prev: WorldSnapshot = { takenAt: iso(NOW - HOUR), issues: [], pullRequests: [], closedPullRequests: [] };
  const next: WorldSnapshot = {
    ...prev,
    takenAt: iso(NOW),
    pullRequests: [
      {
        id: 'pr1',
        number: 1,
        title: 'A change',
        branch: 'feat',
        ciStatus: 'passing',
        unresolvedComments: [],
      },
    ],
  };
  const kinds = new Set(diffWorlds(prev, next).map((e) => e.kind));
  assert.ok(kinds.has('pr_opened'), 'the world model still names an opening this way');

  // The list the route reads and the measures the fold holds are one declaration:
  // a kind here with no measure would be fetched and silently dropped.
  const measured = build({
    events: THROUGHPUT_EVENT_KINDS.map((kind, i) => event(kind, `pr:${i + 1}`, NOW - HOUR)),
  });
  assert.equal(
    measured.totals.reduce((a, t) => a + t.count, 0),
    THROUGHPUT_EVENT_KINDS.length,
  );
});

test('the route counts the rows the store actually holds, replies included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-throughput-'));
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
  system.store.recordWorldEvents([
    { kind: 'pr_opened', ref: 'pr:5', summary: 'PR #5 opened: a change' },
    { kind: 'pr_comment', ref: 'pr:5', summary: 'PR #5: someone commented' },
    { kind: 'pr_merged', ref: 'pr:5', summary: 'PR #5 merged' },
    { kind: 'issue_closed', ref: 'issue:5', summary: 'Issue #5 closed' },
    { kind: 'pr_mergeable', ref: 'pr:5', summary: 'PR #5 is mergeable' },
  ]);
  system.store.recordPrReplySent(5, 'thread-1', 'comment-1');

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/throughput?window=24h' });
  assert.equal(res.statusCode, 200);
  const { insights } = res.json() as ThroughputPayload;

  assert.equal(insights.landing.opened, 1);
  assert.equal(insights.landing.merged, 1);
  assert.equal(insights.conversation.received, 1);
  assert.equal(insights.conversation.replied, 1);
  assert.equal(insights.totals.find((t) => t.measure === 'issue-closed')?.count, 1);
  // `pr_mergeable` is in the feed and is not throughput: it says a pull request
  // could land, not that anything did.
  assert.equal(
    insights.totals.reduce((a, t) => a + t.count, 0),
    5,
  );
  await app.close();
});
