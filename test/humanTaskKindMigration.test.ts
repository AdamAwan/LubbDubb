import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';

// → docs/spec/14-persistence.md#migrations

test('a database whose human_tasks predates kind opens, gains the column and its index', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-human-kind-')), 'old.db');
  const db = new Database(path);
  const stripped = SCHEMA.split('\n')
    .filter((line) => !/^\s*(kind\s+TEXT NOT NULL DEFAULT 'ask'|dismissed_at TEXT\s+--)/.test(line))
    .join('\n')
    .replace(/(resolved_at TEXT),(\s*\n\);\s*\n\s*CREATE INDEX IF NOT EXISTS idx_human_tasks_status)/, '$1$2');
  db.exec(stripped);
  const before = db.prepare(`PRAGMA table_info(human_tasks)`).all() as Array<{ name: string }>;
  assert.ok(!before.some((c) => c.name === 'kind'), 'the fixture really is from before kind');
  db.close();

  const store = new Store(path);
  store.close();

  const after = new Database(path);
  const columns = after.prepare(`PRAGMA table_info(human_tasks)`).all() as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === 'kind'));
  const index = after
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_human_tasks_kind_origin'`)
    .get();
  assert.ok(index);
  after.close();
});
