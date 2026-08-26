import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';

// The goal assay became the goal appraisal, and `issue_assays` became
// `issue_appraisals`. The rows did not change, so the rename is the whole
// migration — and skipping it is silent: `CREATE TABLE IF NOT EXISTS` stands an
// empty table up under the new name, every held goal comes unheld, and every
// question an operator has already answered is asked again.

const NOW = '2026-08-26T09:00:00.000Z';

/** A database on the old build's shape: the same table, under the old name. */
function oldShape(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-rename-'));
  const path = join(dir, 'old.db');
  const db = new Database(path);
  // The pre-rename schema, taken from the post-rename one: the shape is what did
  // not change, so a second hand-written copy of the DDL could only drift.
  db.exec(SCHEMA.replaceAll('issue_appraisals', 'issue_assays'));
  db.prepare(
    `INSERT INTO issue_assays (origin_ref, verdict, summary, goal_ref, by, proposed_profile, profile_answered_at, decided_at, updated_at)
     VALUES ('issue:12', 'unclear', 'which of the two panels?', 'gr-1', 'assayer', 'deep', NULL, ?, ?)`,
  ).run(NOW, NOW);
  db.close();
  return path;
}

test('a verdict cast before the rename is still held after it', () => {
  const store = new Store(oldShape());
  const appraisal = store.getAppraisal('issue:12');
  assert.equal(appraisal?.verdict, 'unclear', 'the row came across, not an empty new table');
  assert.equal(appraisal?.summary, 'which of the two panels?');
  assert.equal(appraisal?.proposedProfile, 'deep');
  assert.equal(appraisal?.profileAnsweredAt, null, 'the profile gate still stands, unanswered');
});

test('the old table is gone, so a second boot has nothing to do', () => {
  const path = oldShape();
  new Store(path).close();
  const inspect = new Database(path);
  const names = (inspect.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
    (r) => r.name,
  );
  inspect.close();
  assert.ok(names.includes('issue_appraisals'));
  assert.ok(!names.includes('issue_assays'), 'renamed, not copied — the old name is what says the rename is due');
  assert.equal(new Store(path).listAppraisals().length, 1, 'and one row, not two');
});

test('a fresh database is never renamed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-rename-'));
  const store = new Store(join(dir, 'fresh.db'));
  assert.equal(store.listAppraisals().length, 0);
});
