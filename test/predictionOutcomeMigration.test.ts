import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { PREDICTION_COLUMNS } from '../src/store/predictions.js';

// → docs/spec/14-persistence.md#migrations

const NOW = '2026-09-17T09:00:00.000Z';
const OUTCOME_COLUMNS = [
  'outcome_mark_locus',
  'outcome_mark_cause',
  'outcome_mark_split',
  'outcome_mark_avoid',
  'outcome_marked_at',
];

/**
 * A database from before moment two: `goal_predictions` already exists, with a
 * prediction, a reveal and moment one's marks on it, and none of moment two's
 * columns. Built by stripping the column lines out of `SCHEMA`, so the fixture
 * cannot drift away from the shape the table actually had.
 */
function beforeTheColumns(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-outcome-mark-'));
  const path = join(dir, 'old.db');
  const db = new Database(path);
  const stripped = SCHEMA.split('\n')
    .filter((line) => !/^\s*outcome_mark(ed)?_\w*\s+TEXT/.test(line))
    .join('\n');
  for (const column of OUTCOME_COLUMNS)
    assert.ok(!stripped.includes(column), `the fixture really is from before ${column}`);
  db.exec(stripped);
  db.prepare(
    `INSERT INTO goal_predictions
       (id, origin_ref, author, locus, cause, split, avoid, plan_mark_locus, plan_marked_at, created_at, updated_at)
     VALUES ('pred_old', 'issue:12', 'operator', 'the store', 'the migration', 'the schema', 'the ALTER',
             'missed', ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO goal_reveals (origin_ref, revealed_at, predicted) VALUES ('issue:12', ?, 1)`).run(NOW);
  db.close();
  return path;
}

test("moment two's columns are declared, so a database from before them gains them on boot", () => {
  for (const column of OUTCOME_COLUMNS)
    assert.equal(
      PREDICTION_COLUMNS.goal_predictions![column],
      'TEXT',
      'CREATE TABLE IF NOT EXISTS never alters an existing table',
    );

  const path = beforeTheColumns();
  const before = new Database(path);
  const beforeNames = (before.prepare(`PRAGMA table_info(goal_predictions)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  before.close();
  for (const column of OUTCOME_COLUMNS) assert.ok(!beforeNames.includes(column), `${column} is not there yet`);

  const store = new Store(path);
  const predictions = store.openPredictions();
  const standing = predictions.getPrediction('issue:12');
  assert.ok(standing, 'the row from before the columns is still readable');
  assert.equal(standing.slots.locus, 'the store', 'and nothing about what it predicted moved');
  assert.equal(standing.planMarks.locus, 'missed', 'nor what moment one said about it');
  assert.deepEqual(
    standing.outcomeMarks,
    { locus: null, cause: null, split: null, avoid: null },
    'null is the truth for every row written before delivery asked — no backfill invents an answer',
  );
  assert.equal(standing.outcomeMarkedAt, null);
  assert.deepEqual(predictions.listOutcomeOwed(), ['issue:12'], 'and the goal now reads as owing the second moment');
  store.close();

  const after = new Database(path);
  const afterNames = (after.prepare(`PRAGMA table_info(goal_predictions)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  after.close();
  for (const column of OUTCOME_COLUMNS) assert.ok(afterNames.includes(column), `${column} arrived by ALTER TABLE`);
});

test('a prediction from before the columns takes a second-moment mark once the boot has added them', () => {
  const store = new Store(beforeTheColumns());
  const predictions = store.openPredictions();
  const outcome = predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'missed' } });
  assert.ok(outcome.ok, 'the migrated row takes a mark like any other');
  assert.equal(outcome.prediction.outcomeMarks.locus, 'missed');
  assert.equal(
    predictions.getPrediction('issue:12')?.planMarks.locus,
    'missed',
    'and moment one is still its own record beside it',
  );
  store.close();
});

test('a second boot on the same file has nothing left to add, and the mark it took survives it', () => {
  const path = beforeTheColumns();
  const first = new Store(path);
  assert.ok(first.openPredictions().recordOutcomeMarks({ originRef: 'issue:12', marks: { avoid: 'matched' } }).ok);
  first.close();

  const second = new Store(path);
  const standing = second.openPredictions().getPrediction('issue:12');
  assert.equal(standing?.slots.locus, 'the store', 'one row, not two shapes');
  assert.equal(standing?.outcomeMarks.avoid, 'matched', 'the second boot re-adds nothing and clears nothing');
  assert.equal(standing?.outcomeMarks.locus, null);
  second.close();
});
