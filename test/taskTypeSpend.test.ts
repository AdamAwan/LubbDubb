import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rollUpChecks, rollUpTaskTypes } from '../src/taskTypeSpend.js';
import { backfillTaskDispatchKind, TASK_COLUMNS } from '../src/store/tasks.js';
import { ensureColumns } from '../src/store/migrate.js';
import { SCHEMA } from '../src/store/schema.js';
import type { Agent, Task } from '../src/types.js';

/**
 * Cost per kind of work, and cost per failing check.
 *
 * What this has to get right is not the arithmetic but the two claims the tables
 * make: that the task-type rows are a partition of the fleet, and that a check's
 * figure is a *share* of a run that may have answered several — stated as such
 * rather than quietly double-counted.
 */

const T = '2026-08-04T09:00:00.000Z';

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'done',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: `task_${id}`,
    kind: 'code',
    title: `Task ${id}`,
    prompt: 'do it',
    branch: null,
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: id,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/**
 * The reading the whole column exists for: review comments are half of
 * `landing`, and until a task recorded its rule nothing could give them a figure
 * of their own.
 */
test('every kind of work gets its own figure, and they partition the fleet', () => {
  const types = rollUpTaskTypes({
    agents: [
      agent('a1', { costUsd: 4 }),
      agent('a2', { costUsd: 3 }),
      agent('a3', { costUsd: 2 }),
      agent('a4', { costUsd: 1 }),
    ],
    tasks: [
      task('a1', { rule: 'pr-ci-failing' }),
      task('a2', { rule: 'pr-review-comment' }),
      task('a3', { rule: 'pr-ci-failing' }),
      task('a4', { rule: null }),
    ],
  });

  const byRule = new Map(types.map((t) => [t.rule, t]));
  assert.equal(byRule.get('pr-ci-failing')?.costUsd, 6, 'two CI runs add up');
  assert.equal(byRule.get('pr-ci-failing')?.runs, 2);
  assert.equal(byRule.get('pr-ci-failing')?.perRunUsd, 3);
  assert.equal(byRule.get('pr-review-comment')?.costUsd, 3, 'review comments are their own line');
  assert.equal(
    byRule.get('pr-review-comment')?.label,
    'Unhandled review comments',
    'named by the dispatch registry, never a second vocabulary invented here',
  );
  assert.equal(byRule.get(null)?.costUsd, 1, 'a run with no rule is a row, never a silence');
  assert.equal(
    types.reduce((a, t) => a + t.costUsd, 0),
    10,
    'the rows are a partition of every measured run',
  );
  assert.equal(types[0]?.rule, 'pr-ci-failing', 'costliest first');
});

/** A rule the registry has lost must still be billed, under its own id. */
test('an unknown rule id is a row named after itself, never dropped', () => {
  const types = rollUpTaskTypes({
    agents: [agent('a1', { costUsd: 2 })],
    tasks: [task('a1', { rule: 'pr-renamed-last-month' })],
  });
  assert.equal(types[0]?.label, 'pr-renamed-last-month');
  assert.equal(types[0]?.costUsd, 2);
});

/**
 * The answer to "what is `dotnet test` costing me". A run sent at two red checks
 * splits between them, which is what keeps the column a partition — charging each
 * check the whole run would add up to more money than the fleet spent.
 */
test('a check carries its share of every run sent at it', () => {
  const checks = rollUpChecks({
    agents: [agent('a1', { costUsd: 6 }), agent('a2', { costUsd: 4 })],
    tasks: [
      task('a1', { rule: 'pr-ci-failing', ciChecks: ['dotnet test', 'Qodana'] }),
      task('a2', { rule: 'pr-ci-failing', ciChecks: ['dotnet test'] }),
    ],
  });

  const byName = new Map(checks.checks.map((c) => [c.name, c]));
  assert.equal(byName.get('dotnet test')?.costUsd, 7, 'half of the shared run, plus all of its own');
  assert.equal(byName.get('dotnet test')?.runs, 2);
  assert.equal(byName.get('dotnet test')?.soleRuns, 1, 'one of the two was about this check alone');
  assert.equal(byName.get('Qodana')?.costUsd, 3, 'and the other half is Qodana’s, never the whole run');
  assert.equal(
    checks.checks.reduce((a, c) => a + c.costUsd, 0),
    10,
    'so the rows sum to the CI money rather than overstating it',
  );
  assert.equal(checks.attributedCostUsd, 10);
  assert.equal(checks.unnamedCostUsd, 0);
});

/**
 * A provider that reports no per-check detail spends real money on CI. It must
 * reach the caveat rather than the rows, or the table reads as a complete account
 * of CI spend while a whole provider lands nowhere.
 */
test('CI spend that named no check is shipped as the remainder, never dropped', () => {
  const checks = rollUpChecks({
    agents: [agent('a1', { costUsd: 5 }), agent('a2', { costUsd: 2 })],
    tasks: [
      task('a1', { rule: 'pr-ci-failing', ciChecks: null }),
      task('a2', { rule: 'pr-ci-failing', ciChecks: ['lint'] }),
    ],
  });

  assert.equal(checks.unnamedCostUsd, 5);
  assert.equal(checks.attributedCostUsd, 2);
  assert.equal(checks.checks.length, 1);
});

/**
 * The rule is what puts a run in this table, never the presence of the array —
 * otherwise a build agent and a CI dispatch whose provider reported nothing would
 * be indistinguishable, and the remainder would swallow the whole fleet.
 */
test('only CI dispatches are this table’s subject', () => {
  const checks = rollUpChecks({
    agents: [agent('a1', { costUsd: 9 }), agent('a2', { costUsd: 1 })],
    tasks: [task('a1', { rule: 'issue-part' }), task('a2', { rule: 'pr-ci-gate', ciChecks: ['sonar'] })],
  });

  assert.equal(checks.unnamedCostUsd, 0, 'a build agent is not unnamed CI spend — it is not CI spend');
  assert.equal(checks.attributedCostUsd, 1);
  assert.equal(checks.checks[0]?.name, 'sonar', 'a waiting gate is a check costing money like any other');
});

/** An unmeasured run is priced nowhere here either — the same silence the rest of spend keeps. */
test('a run that reported nothing is in neither table', () => {
  const args = {
    agents: [agent('a1', { costUsd: null, inputTokens: null, outputTokens: null })],
    tasks: [task('a1', { rule: 'pr-ci-failing', ciChecks: ['dotnet test'] })],
  };
  assert.equal(rollUpTaskTypes(args).length, 0);
  assert.equal(rollUpChecks(args).checks.length, 0);
});

/**
 * A database holding one task as a build that predates the columns wrote it:
 * prose in `dispatch_reason`, nothing in `rule` or `ci_checks`.
 */
function legacyDb(originRef: string | null, dispatchReason: string | null) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  ensureColumns(db, TASK_COLUMNS);
  db.prepare(
    `INSERT INTO tasks (id, kind, title, prompt, branch, origin_ref, dispatch_reason, status, created_at, updated_at)
     VALUES ('t1', 'code', 'Fix CI', 'p', 'b', @originRef, @dispatchReason, 'done', @t, @t)`,
  ).run({ originRef, dispatchReason, t: T });
  return db;
}

function readBack(db: Database.Database) {
  return db.prepare(`SELECT rule, ci_checks FROM tasks WHERE id='t1'`).get() as {
    rule: string | null;
    ci_checks: string | null;
  };
}

/**
 * The backfill is the only place a dispatch reason is ever parsed: the rule comes
 * off the origin (structural, since only one rule mints each), the checks off the
 * sentence the dispatcher wrote (the one-off).
 */
test('the boot backfill seeds rule and checks on tasks that predate the columns', () => {
  const db = legacyDb('pr:41:ci', 'PR #41 has failing CI (dotnet test, Qodana) and no agent is on it.');
  backfillTaskDispatchKind(db);

  const row = readBack(db);
  assert.equal(row.rule, 'pr-ci-failing');
  assert.deepEqual(JSON.parse(row.ci_checks ?? 'null'), ['dotnet test', 'Qodana']);
});

/** The gate rule writes a different sentence, and it is recognised too. */
test('a waiting-gate dispatch is backfilled from its own sentence', () => {
  const db = legacyDb(
    'pr:41:ci-gate',
    'PR #41 has a check waiting on an action (PR-Agent-Reviewed) and no agent is on it.',
  );
  backfillTaskDispatchKind(db);

  const row = readBack(db);
  assert.equal(row.rule, 'pr-ci-gate');
  assert.deepEqual(JSON.parse(row.ci_checks ?? 'null'), ['PR-Agent-Reviewed']);
});

/** A sentence the backfill does not recognise leaves the row null rather than guessing. */
test('an unrecognised dispatch reason leaves the checks unset', () => {
  const db = legacyDb('pr:41:ci', 'CI is unhappy about something.');
  backfillTaskDispatchKind(db);

  const row = readBack(db);
  assert.equal(row.rule, 'pr-ci-failing', 'the structural half still lands');
  assert.equal(row.ci_checks, null, 'and the prose half declines rather than inventing a check');
});

/** Re-running must not overwrite what the dispatcher recorded properly. */
test('the backfill only ever fills nulls', () => {
  const db = legacyDb('pr:41:ci', 'PR #41 has failing CI (something, else) and no agent is on it.');
  db.prepare(`UPDATE tasks SET rule='pr-ci-failing', ci_checks='["Qodana"]' WHERE id='t1'`).run();

  backfillTaskDispatchKind(db);

  assert.deepEqual(
    JSON.parse(readBack(db).ci_checks ?? 'null'),
    ['Qodana'],
    'the recorded value wins over the sentence',
  );
});
