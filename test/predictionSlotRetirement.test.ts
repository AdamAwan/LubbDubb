import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { PREDICTION_SLOTS } from '../src/store/predictions.js';

// → docs/spec/14-persistence.md#retiring-a-slot

const NOW = '2026-09-16T09:00:00.000Z';

/**
 * A database on the slot vocabulary `split` and `avoid` replaced: `hard` and
 * `surprise` are columns, so no `ALTER TABLE` can reach them and the table is
 * rebuilt instead. The fixture is written out rather than derived from `SCHEMA`,
 * because what it is a fixture *of* is a shape `SCHEMA` no longer states.
 */
function onTheOldSlots(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-slot-retire-')), 'old.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE goal_predictions (
      id         TEXT PRIMARY KEY,
      origin_ref TEXT NOT NULL UNIQUE,
      author     TEXT,
      locus      TEXT,
      cause      TEXT,
      hard       TEXT,
      surprise   TEXT,
      plan_mark_locus    TEXT,
      plan_mark_cause    TEXT,
      plan_mark_hard     TEXT,
      plan_mark_surprise TEXT,
      plan_marked_at     TEXT,
      outcome_mark_locus    TEXT,
      outcome_mark_cause    TEXT,
      outcome_mark_hard     TEXT,
      outcome_mark_surprise TEXT,
      outcome_marked_at     TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE goal_reveals (
      origin_ref  TEXT PRIMARY KEY,
      revealed_at TEXT NOT NULL,
      predicted   INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO goal_predictions
       (id, origin_ref, author, locus, cause, hard, surprise,
        plan_mark_locus, plan_mark_hard, plan_marked_at, created_at, updated_at)
     VALUES ('pred_old', 'issue:12', 'operator', 'the store', 'the migration', 'the schema', 'the ALTER',
             'matched', 'missed', ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO goal_predictions
       (id, origin_ref, author, hard, plan_mark_hard, plan_marked_at, created_at, updated_at)
     VALUES ('pred_hard_only', 'issue:13', 'operator', 'the schema', 'missed', ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO goal_reveals (origin_ref, revealed_at, predicted) VALUES ('issue:12', ?, 1)`).run(NOW);
  db.close();
  return path;
}

test('a database on the retired slots is rebuilt onto the new ones, and boots', () => {
  const path = onTheOldSlots();
  const store = new Store(path);
  const standing = store.openPredictions().getPrediction('issue:12');
  assert.ok(standing, 'the row survives the rebuild');
  assert.deepEqual(
    standing.slots,
    { locus: 'the store', cause: 'the migration', split: null, avoid: null },
    'the two slots whose question did not change carry over; the two that were retired do not',
  );
  store.close();

  const db = new Database(path);
  const names = (db.prepare(`PRAGMA table_info(goal_predictions)`).all() as { name: string }[]).map((c) => c.name);
  db.close();
  for (const slot of PREDICTION_SLOTS) assert.ok(names.includes(slot), `${slot} is a column now`);
  for (const gone of ['hard', 'surprise', 'plan_mark_hard', 'outcome_mark_surprise'])
    assert.ok(!names.includes(gone), `${gone} is gone rather than left behind to be read by nothing`);
});

test('the rebuild drops every mark, so no stamp survives with nothing left to have answered', () => {
  const store = new Store(onTheOldSlots());
  const predictions = store.openPredictions();

  const mixed = predictions.getPrediction('issue:12');
  assert.deepEqual(mixed?.planMarks, { locus: null, cause: null, split: null, avoid: null });
  assert.equal(mixed?.planMarkedAt, null, 'the stamp goes with the marks it was derived from');

  // The row whose only mark was on a retired slot is the one the stamp rule exists
  // for: carried over, it would say moment one was answered with nothing in it.
  const retiredOnly = predictions.getPrediction('issue:13');
  assert.equal(retiredOnly?.planMarkedAt, null);
  store.close();
});

test('the reveals are left standing, so a plan already read cannot take a fresh prediction', () => {
  const store = new Store(onTheOldSlots());
  const predictions = store.openPredictions();
  assert.ok(predictions.getReveal('issue:12'), 'the reveal is not cleared by the rebuild');
  assert.equal(
    predictions.recordPrediction({ originRef: 'issue:12', author: 'operator', slots: { split: 'two parts' } }),
    null,
    'a prediction written by somebody who has already read the plan is not a prediction',
  );
  store.close();
});

test('a second boot on a rebuilt file changes nothing', () => {
  const path = onTheOldSlots();
  const first = new Store(path);
  assert.ok(first.openPredictions().recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } }).ok);
  first.close();

  const second = new Store(path);
  const standing = second.openPredictions().getPrediction('issue:12');
  assert.equal(standing?.slots.locus, 'the store', 'one row, not two shapes');
  assert.equal(standing?.planMarks.locus, 'matched', 'the rebuild does not run twice and take the mark with it');
  second.close();
});
