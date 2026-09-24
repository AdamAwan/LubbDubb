import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { VALIDATION_COLUMNS, VALIDATION_REBUILDS } from '../src/store/validation.js';

// → docs/spec/14-persistence.md#retiring-a-column

const NOW = '2026-09-09T09:00:00.000Z';
const GOAL = 'issue:12';

type Row = Record<string, unknown>;

function columns(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(validation_checks)`).all() as { name: string }[]).map((c) => c.name);
}

function rowsOf(db: Database.Database): Row[] {
  return db.prepare(`SELECT * FROM validation_checks ORDER BY id`).all() as Row[];
}

function without(rows: Row[], ...drop: string[]): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));
}

/**
 * A database a build from before the retirement wrote: today's schema with `area` and `expects` put
 * back, every column filled, optionally missing columns that arrived after `area` did.
 */
function beforeTheRetirement(missing: readonly string[] = []): { dir: string; path: string; before: Row[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-area-retire-'));
  const path = join(dir, 'old.db');
  new Store(path).close();
  const db = new Database(path);
  db.exec(`ALTER TABLE validation_checks ADD COLUMN area TEXT`);
  db.exec(`ALTER TABLE validation_checks ADD COLUMN expects TEXT`);
  for (const column of missing) db.exec(`ALTER TABLE validation_checks DROP COLUMN ${column}`);
  const present = new Set(columns(db));
  const full: Row = {
    origin_ref: GOAL,
    id: 'an-order-places',
    letter: 'C',
    seq: 3,
    title: 'An order still places',
    check_do: 'Place one.',
    check_expect: 'It places.',
    uses: '["buyer"]',
    covers: '["checkout"]',
    fleet_candidate: 1,
    candidate_why: 'a browser can do it',
    actor: 'fleet',
    handback_note: 'gave it back',
    claimed_by: 'desk-1',
    claimed_at: NOW,
    state: 'passed',
    result_note: 'it placed',
    result_by: 'agent',
    result_at: NOW,
    defer_until: null,
    superseded_reason: null,
    revision: '{"title":"old"}',
    amended_at: NOW,
    amend_note: 'reworded',
    area: 'checkout',
    expects: '["checkout/places-an-order.spec.ts"]',
    steps: '[{"kind":"suite","do":"Run it","area":"checkout"}]',
    capture: 'order.png',
    proof: 'a screenshot of the receipt',
    created_at: NOW,
    updated_at: NOW,
  };
  const row = Object.fromEntries(Object.entries(full).filter(([k]) => present.has(k)));
  const second = { ...row, id: 'a-refund-issues', letter: 'D', seq: 4, area: null, expects: null };
  for (const r of [row, second]) {
    const keys = Object.keys(r);
    db.prepare(
      `INSERT INTO validation_checks (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`,
    ).run(r);
  }
  const before = rowsOf(db);
  db.close();
  assert.equal(before.length, 2);
  return { dir, path, before };
}

test('a fresh database never has the retired columns, and they are not declared for adding back', () => {
  const store = new Store(':memory:');
  try {
    const cols = columns((store as unknown as { db: Database.Database }).db);
    assert.ok(!cols.includes('area') && !cols.includes('expects'));
  } finally {
    store.close();
  }
  assert.equal(VALIDATION_COLUMNS.validation_checks?.area, undefined);
  assert.equal(VALIDATION_COLUMNS.validation_checks?.expects, undefined);
});

test('an old database loses area and expects, every other column survives, and the second boot rebuilds nothing', () => {
  const { dir, path, before } = beforeTheRetirement();
  try {
    new Store(path).close();

    const db = new Database(path);
    const cols = columns(db);
    assert.ok(!cols.includes('area') && !cols.includes('expects'), 'both columns are gone');
    assert.deepEqual(rowsOf(db), without(before, 'area', 'expects'), 'every other column came across untouched');
    assert.ok(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_validation_checks_goal'`).get(),
      'the index that went with the renamed table is back on the new one',
    );
    for (const r of VALIDATION_REBUILDS.filter((x) => x.table === 'validation_checks')) {
      assert.equal(r.detect ? r.detect(db) : cols.includes(r.keyedOn), false, 'nothing still reads as stale');
    }
    db.exec(`CREATE TRIGGER rebuild_marker AFTER INSERT ON validation_checks BEGIN SELECT 1; END`);
    db.close();

    const store = new Store(path);
    const checks = store.validation.listValidationChecks(GOAL);
    store.close();
    assert.deepEqual(
      checks.map((c) => [c.id, c.letter, c.state, c.capture, c.proof]),
      [
        ['an-order-places', 'C', 'passed', 'order.png', 'a screenshot of the receipt'],
        ['a-refund-issues', 'D', 'passed', 'order.png', 'a screenshot of the receipt'],
      ],
    );

    const again = new Database(path);
    assert.ok(
      again.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='rebuild_marker'`).get(),
      'a rebuild drops the renamed table and its trigger with it, so a trigger still standing is a boot that rebuilt nothing',
    );
    assert.deepEqual(rowsOf(again), without(before, 'area', 'expects'));
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('a database that carries area but predates steps, capture and proof is rebuilt with those left null', () => {
  const { dir, path, before } = beforeTheRetirement(['steps', 'capture', 'proof']);
  try {
    new Store(path).close();
    const db = new Database(path);
    const cols = columns(db);
    assert.ok(!cols.includes('area') && !cols.includes('expects'));
    assert.ok(cols.includes('steps') && cols.includes('capture') && cols.includes('proof'));
    assert.deepEqual(
      rowsOf(db),
      without(before, 'area', 'expects').map((r) => ({ ...r, steps: null, capture: null, proof: null })),
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
