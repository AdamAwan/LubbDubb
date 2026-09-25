import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentHealthProber } from '../src/environments/fakeHealthProber.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';

const COUNTED = ['all', 'get', 'run'] as const;

/**
 * Every statement one call executes, counted by its SQL. The prototype is shared by every open
 * database in the process, so the originals go back on before this returns.
 */
function countStatements<T>(run: () => T): { result: T; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const probe = new Database(':memory:');
  const proto = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const method of COUNTED) {
    const original = proto[method] as (this: unknown, ...args: unknown[]) => unknown;
    originals.set(method, original);
    proto[method] = function (this: { source: string }, ...args: unknown[]): unknown {
      counts.set(this.source, (counts.get(this.source) ?? 0) + 1);
      return original.apply(this, args);
    };
  }
  try {
    return { result: run(), counts };
  } finally {
    for (const [method, original] of originals) proto[method] = original;
    probe.close();
  }
}

/**
 * The tables `buildStateSnapshot` reads through a memo, each of which grew a second reader inside
 * one of the `buildX` helpers at the bottom of the file. A statement over one of them run twice in
 * a single snapshot is that reader back.
 */
const READ_ONCE_TABLES = [
  'decisions',
  'environment_health',
  'goal_arrivals',
  'goal_watches',
  'issue_deliveries',
  'issue_shortfalls',
  'remote_runs',
  'remote_sheet_rows',
  'work_nodes',
];

/** Room for a handful of new reads before the ceiling has to be argued for again. */
const BOUND = 88;

function repeatedOver(counts: ReadonlyMap<string, number>, tables: readonly string[]): string[] {
  return [...counts]
    .filter(([sql, n]) => n > 1 && tables.some((table) => sql.includes(table)))
    .map(([sql, n]) => `${String(n)}x ${sql.replace(/\s+/g, ' ').trim()}`);
}

function seeded() {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    environmentProbeIntervalMs: 0,
    environmentHealthIntervalMs: 0,
    environments: [
      {
        name: 'testUk',
        at: 'unused',
        health: 'unused',
        watch: { observe: 'unused' },
        validate: { permits: ['state'], state: { run: 'unused' } },
      },
    ],
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentHealthProber: new FakeEnvironmentHealthProber(),
    stateReader: new FakeStateReader(),
    tenants: new FakeTenantKeeper(),
  });
  const { store } = system;
  const goalRef = 'issue:7';

  store.world.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [{ id: 'i7', number: 7, title: 'A goal', body: '', labels: [], state: 'open', linkedPrNumber: null }],
  });
  store.decisions.recordDecision({
    cycleId: 'c1',
    action: { type: 'noop', originRef: goalRef } as never,
    outcome: 'executed',
    detail: 'seeded',
  });
  store.graph.recordWorkGraph([{ ref: goalRef, kind: 'issue', title: 'A goal', status: 'open', terminal: false }]);
  store.verdicts.recordDelivery({ originRef: goalRef, summary: 'shipped', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 11, goalRef, sha: 'a'.repeat(40) });
  store.environments.recordGoalArrival({ goalRef, environment: 'testUk', arrivedAt: new Date().toISOString() });
  store.environments.recordEnvironmentHealth({
    environment: 'testUk',
    state: 'healthy',
    tier: null,
    reasons: [],
    detail: null,
  });
  store.watches.ingestGoalWatch(goalRef, [
    {
      id: 'orders',
      seq: 1,
      kind: 'measure',
      title: 'Orders land',
      query: 'select 1',
      presence: null,
      tolerate: 0,
      expectUnder: null,
      expectOver: null,
      expectBaseline: false,
      unit: null,
      why: null,
    },
  ]);
  store.watches.openWatchWindow({
    goalRef,
    environment: 'testUk',
    openedAt: new Date().toISOString(),
    settlesAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.remoteValidation.openRemoteSheet({ goalRef, environment: 'testUk' });
  store.remoteValidation.saveRemoteSheetRows(goalRef, 'testUk', [
    {
      rowId: 'r1',
      kind: 'state',
      seq: 1,
      title: 'It works',
      sourceId: 'q1',
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
      idleReason: null,
    },
  ]);
  store.remoteValidation.beginRemoteRun({ goalRef, environment: 'testUk', tenant: 't1', startedSha: null });
  return system;
}

test('buildStateSnapshot reads each table once — a re-read the caller already holds is a regression', () => {
  const system = seeded();
  try {
    const { counts } = countStatements(() => buildStateSnapshot(system));
    assert.deepEqual(
      repeatedOver(counts, READ_ONCE_TABLES),
      [],
      'a statement run twice in one snapshot is a row the caller already read',
    );
  } finally {
    system.store.close();
  }
});

test('buildStateSnapshot issues a bounded number of statements', () => {
  const system = seeded();
  try {
    const { counts } = countStatements(() => buildStateSnapshot(system));
    const executions = [...counts.values()].reduce((sum, n) => sum + n, 0);
    assert.ok(
      executions <= BOUND,
      `one snapshot ran ${String(executions)} statements, over the ${String(BOUND)} bound`,
    );
  } finally {
    system.store.close();
  }
});
