import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

// The claims arm went, and with it the `CREATE TABLE IF NOT EXISTS pool_claims`.
// That stops the table being made; it never removes one. So every database from
// before the retirement kept the table and a poll's worth of another team's prose
// for ever, while every database made since had never heard of it — two shapes in
// the field for one build, which is the thing the migrations exist to close.

/** A database on the old build's shape: the retired arm's table, with a row in it. */
function withClaims(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-retired-')), 'old.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE pool_claims (fleet_id TEXT NOT NULL, claim TEXT NOT NULL, seen_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO pool_claims VALUES ('alice@acme-api', 'the flake is the seeded clock', '2026-01-01')`).run();
  db.close();
  return path;
}

function tables(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
    (row) => row.name,
  );
  db.close();
  return names;
}

test('a table a retired arm left behind is dropped on the next boot', () => {
  const path = withClaims();
  assert.ok(tables(path).includes('pool_claims'), 'the fixture is the old shape');

  new Store(path).close();

  const names = tables(path);
  assert.ok(!names.includes('pool_claims'));
  // The tables the arm did not take with it are untouched: this drops one name, not
  // everything the pool ever made.
  assert.ok(names.includes('pool_digest_rows'));
  assert.ok(names.includes('pool_fleets'));
  assert.ok(names.includes('pool_publications'));
});

test('a database that never had it boots twice with nothing to do', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-retired-fresh-')), 'fresh.db');
  new Store(path).close();
  new Store(path).close();
  assert.ok(!tables(path).includes('pool_claims'));
});
