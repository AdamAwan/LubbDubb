import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { resolveWindow } from '../src/insightsWindow.js';
import {
  buildOperatorInsights,
  type OperatorInput,
  type OperatorRow,
  type OperatorRowId,
  type OperatorRowKind,
} from '../src/operatorInsights.js';
import { USAGE_SUBJECTS } from '../src/usage/events.js';
import { IDLE_INTENT } from '../src/selfUpdate/upgradePlan.js';
import type { UsagePayload } from '../src/wire.js';

/**
 * The operator ledger: the fold's arithmetic, and that the route actually passes
 * the window down to it.
 *
 * The seam test seeds settled records rather than driving the routes that settle
 * them, on purpose: the whole claim of this reading is that it sweeps the
 * *record*, so a test that could only pass by going through one settling route
 * would be asserting the arrangement `collectActions` argues against.
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-ledger-'));
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
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function emptyInput(now = NOW): OperatorInput {
  return {
    escalations: [],
    proposals: [],
    humanTasks: [],
    obstacles: [],
    upgrade: IDLE_INTENT,
    landings: [],
    plans: [],
    amendments: [],
    checks: [],
    conclusions: [],
    agents: [],
    costEvents: [],
    window: resolveWindow('24h', now, null),
    now,
  };
}

function row(rows: OperatorRow[], id: OperatorRowId): OperatorRow {
  const found = rows.find((r) => r.id === id);
  assert.ok(found, `no ${id} row`);
  return found;
}

test('an ask is counted asked, answered, declined and outstanding — four figures, never one', () => {
  const insights = buildOperatorInsights({
    ...emptyInput(),
    humanTasks: [
      // Answered inside the window, two hours after it was asked.
      task('a', iso(6 * HOUR), iso(4 * HOUR), 'done'),
      // Declined inside the window: the harness asked for the wrong thing.
      task('b', iso(5 * HOUR), iso(3 * HOUR), 'declined'),
      // Still open, and it was already open when this window began.
      task('c', iso(40 * HOUR), null, 'open'),
      // Still open, but asked inside the window — outstanding, not overdue.
      task('d', iso(2 * HOUR), null, 'open'),
    ],
  });
  const bench = row(insights.asks, 'human-task');
  assert.equal(bench.offered, 3, 'three of the four were asked inside the window');
  assert.equal(bench.settled, 1);
  assert.equal(bench.declined, 1, 'a decline is never folded into the answers');
  assert.equal(bench.openPastWindow, 1, 'only the one that predates the window is overdue');
  assert.equal(bench.medianAnswerMs, 2 * HOUR);
});

test('waiting is priced at what the fleet spends in an hour, over the same window', () => {
  const insights = buildOperatorInsights({
    ...emptyInput(),
    // $24 over the 24h window — one dollar an hour.
    costEvents: [{ agentId: 'a1', costUsd: 24, at: iso(20 * HOUR) }],
    humanTasks: [task('a', iso(6 * HOUR), iso(3 * HOUR), 'done')],
  });
  assert.equal(insights.fleetRateUsdPerHour, 1);
  // Three hours parked, at a dollar an hour. The product is the reading; both
  // halves ship so a reader can see which one moved.
  assert.equal(row(insights.asks, 'human-task').parkedCostUsd, 3);
});

test('a wait is clipped to the window, so a month-old ask does not price a day of it', () => {
  const insights = buildOperatorInsights({
    ...emptyInput(),
    costEvents: [{ agentId: 'a1', costUsd: 24, at: iso(20 * HOUR) }],
    humanTasks: [task('a', iso(30 * 24 * HOUR), null, 'open')],
  });
  assert.equal(row(insights.asks, 'human-task').parkedCostUsd, 24, 'the whole window, and not a day more');
});

test('a record that cannot say answers null, never zero', () => {
  const insights = buildOperatorInsights({
    ...emptyInput(),
    obstacles: [
      {
        id: 'ob1',
        what: 'the staging login expired',
        kind: 'obstacle',
        state: 'owned',
        ownerRef: 'issue:9',
        until: null,
        createdAt: iso(3 * HOUR),
        updatedAt: iso(HOUR),
        lastSeenAt: iso(HOUR),
        endedBy: null,
      },
    ],
  });
  const obstacles = row(insights.asks, 'obstacle-ownership');
  assert.equal(obstacles.settled, 1);
  // `updated_at` moves on every sighting, so there is no stamp to measure a wait
  // from. A zero here would be a finding manufactured out of a missing column.
  assert.equal(obstacles.medianAnswerMs, null);
  assert.equal(obstacles.parkedCostUsd, null);
  // An act parks nothing, and its population is not recorded either.
  const landing = row(insights.acts, 'stack-landing');
  assert.equal(landing.parkedCostUsd, null);
  assert.equal(landing.offered, null);
});

test('the two halves stay apart, and every row names a subject from the registry', () => {
  const insights = buildOperatorInsights(emptyInput());
  assert.ok(insights.asks.length > 0);
  assert.ok(insights.acts.length > 0);
  const kinds = new Set<OperatorRowKind>();
  for (const r of [...insights.asks, ...insights.acts]) {
    kinds.add(r.kind);
    assert.ok(USAGE_SUBJECTS.includes(r.subject), `${r.id} names a subject the registry does not`);
  }
  assert.deepEqual([...kinds].sort(), ['act', 'ask']);
  assert.ok(insights.asks.every((r) => r.kind === 'ask'));
  assert.ok(insights.acts.every((r) => r.kind === 'act'));
});

test('GET /api/usage sweeps the records and answers for the window it was asked with', async () => {
  const system = build();
  const { store } = system;
  const escalation = store.createEscalation({
    type: 'answer_question',
    prompt: 'which environment is this against?',
    context: {},
    agentId: null,
    taskId: null,
  });
  store.answerEscalation(escalation.id, 'staging');
  const dismissed = store.createEscalation({
    type: 'answer_question',
    prompt: 'should this ship?',
    context: {},
    agentId: null,
    taskId: null,
  });
  store.dismissEscalation(dismissed.id, {});
  const { task: bench } = store.recordHumanTask({
    title: 'rotate the staging credential',
    detail: null,
    agentId: null,
    taskId: null,
    originRef: null,
  });
  store.settleHumanTask(bench.id, 'done', 'rotated');
  store.recordStackLanding('stack:41', [41, 42]);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/usage?window=24h' });
  assert.equal(res.statusCode, 200);
  const { insights } = res.json() as UsagePayload;
  // Shipped back rather than assumed, for the reason every other insights route
  // ships it: the caption is the half a reader believes.
  assert.equal(insights.window.key, '24h');
  assert.notEqual(insights.window.since, null);

  const escalations = row(insights.asks, 'escalation');
  assert.equal(escalations.offered, 2);
  assert.equal(escalations.settled, 1);
  assert.equal(escalations.declined, 1);
  assert.equal(row(insights.asks, 'human-task').settled, 1);
  assert.equal(row(insights.acts, 'stack-landing').settled, 1);
  await app.close();
});

test('the ledger defaults to the stretch the page opens on', async () => {
  const { app } = await buildApp(build());
  const res = await app.inject({ method: 'GET', url: '/api/usage' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as UsagePayload).insights.window.key, '7d');
  await app.close();
});

function task(
  id: string,
  createdAt: string,
  resolvedAt: string | null,
  status: 'open' | 'done' | 'declined',
): OperatorInput['humanTasks'][number] {
  return {
    id,
    title: id,
    detail: null,
    originRef: null,
    partId: null,
    kind: 'ask',
    agentId: null,
    taskId: null,
    status,
    resolution: null,
    createdAt,
    updatedAt: resolvedAt ?? createdAt,
    resolvedAt,
    dismissedAt: null,
  };
}
