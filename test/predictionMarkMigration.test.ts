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

const NOW = '2026-09-16T09:00:00.000Z';
const MARK_COLUMNS = ['plan_mark_locus', 'plan_mark_cause', 'plan_mark_split', 'plan_mark_avoid', 'plan_marked_at'];

/**
 * A database from before moment one: `goal_predictions` already exists, with a
 * prediction and a reveal in it, and none of the mark columns. Built by stripping
 * the column lines out of `SCHEMA` so the fixture cannot drift away from the shape
 * the table actually had.
 */
function beforeTheColumns(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-plan-mark-'));
  const path = join(dir, 'old.db');
  const db = new Database(path);
  const stripped = SCHEMA.split('\n')
    .filter((line) => !/^\s*plan_mark(ed)?_\w*\s+TEXT/.test(line))
    .join('\n');
  for (const column of MARK_COLUMNS)
    assert.ok(!stripped.includes(column), `the fixture really is from before ${column}`);
  db.exec(stripped);
  db.prepare(
    `INSERT INTO goal_predictions (id, origin_ref, author, locus, cause, split, avoid, created_at, updated_at)
     VALUES ('pred_old', 'issue:12', 'operator', 'the store', 'the migration', 'the schema', 'the ALTER', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(`INSERT INTO goal_reveals (origin_ref, revealed_at, predicted) VALUES ('issue:12', ?, 1)`).run(NOW);
  db.close();
  return path;
}

test('the mark columns are declared in PREDICTION_COLUMNS, so a database from before them gains them on boot', () => {
  for (const column of MARK_COLUMNS)
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
  for (const column of MARK_COLUMNS) assert.ok(!beforeNames.includes(column), `${column} is not there yet`);

  const store = new Store(path);
  const predictions = store.openPredictions();
  const standing = predictions.getPrediction('issue:12');
  assert.ok(standing, 'the row from before the columns is still readable');
  assert.deepEqual(
    standing.slots,
    { locus: 'the store', cause: 'the migration', split: 'the schema', avoid: 'the ALTER' },
    'and nothing about what it predicted moved',
  );
  assert.deepEqual(
    standing.planMarks,
    { locus: null, cause: null, split: null, avoid: null },
    'a null mark is the truth for every row written before moment one — no backfill invents one',
  );
  assert.equal(standing.planMarkedAt, null);
  store.close();

  const after = new Database(path);
  const afterNames = (after.prepare(`PRAGMA table_info(goal_predictions)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  after.close();
  for (const column of MARK_COLUMNS) assert.ok(afterNames.includes(column), `${column} arrived by ALTER TABLE`);
});

test('a prediction from before the columns can be marked once the boot has added them', () => {
  const store = new Store(beforeTheColumns());
  const predictions = store.openPredictions();
  const outcome = predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } });
  assert.ok(outcome.ok, 'the migrated row takes a mark like any other');
  assert.equal(outcome.prediction.planMarks.locus, 'matched');
  assert.equal(predictions.getPrediction('issue:12')?.planMarks.locus, 'matched');
  store.close();
});

test('a second boot on the same file has nothing left to add, and the mark it took survives it', () => {
  const path = beforeTheColumns();
  const first = new Store(path);
  assert.ok(first.openPredictions().recordPlanMarks({ originRef: 'issue:12', marks: { avoid: 'missed' } }).ok);
  first.close();

  const second = new Store(path);
  const standing = second.openPredictions().getPrediction('issue:12');
  assert.equal(standing?.slots.locus, 'the store', 'one row, not two shapes');
  assert.equal(standing?.planMarks.avoid, 'missed', 'the second boot re-adds nothing and clears nothing');
  assert.equal(standing?.planMarks.locus, null);
  second.close();
});
