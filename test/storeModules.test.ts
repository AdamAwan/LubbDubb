import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

/**
 * The modules that hold SQL. Four files under `src/store/` are not domain modules and
 * are excluded by name: `store.ts` (the composition root), `schema.ts` (the DDL),
 * `context.ts` / `migrate.ts` (what a module is handed), and `verdicts.ts` — the
 * issue-verdict exclusion matrix (#222), which is a dependency-free *declaration*
 * naming the four verdict tables so that `test/verdictMatrix.test.ts` can walk it
 * without importing SQLite. It states which rows may coexist; `issueVerdicts.ts`
 * owns the tables and is the only thing that writes them.
 */
const NOT_DOMAIN_MODULES = [
  'src/store/store.ts',
  'src/store/schema.ts',
  'src/store/context.ts',
  'src/store/migrate.ts',
  'src/store/verdicts.ts',
];

function domainModules(): string[] {
  return srcFiles('src/store').filter((f) => !NOT_DOMAIN_MODULES.includes(f));
}

test('only src/store/ touches SQLite', () => {
  // The constraint issue #221 was careful to preserve, now enforceable rather than
  // merely stated: splitting the 2,543-line class into domain modules keeps every
  // `better-sqlite3` import inside this one directory, and a subsystem that reached
  // for the driver directly would have no store method holding its invariants.
  //
  // The shape `test/workGraph.test.ts` uses for the `src/graph/` lens rule. If this
  // fails, fix the file it names rather than the assertion.
  // The *import*, not the string: two modules mention the driver in prose to explain
  // why a synchronous write makes a read-then-write race-free, and neither touches it.
  const importers = srcFiles('src').filter((f) => /from '(?:node:)?better-sqlite3'/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    importers.filter((f) => !f.startsWith('src/store/')),
    [],
    'everything else goes through the Store',
  );
  assert.ok(importers.length > 0, 'the driver is imported somewhere, or this assertion proves nothing');
});

test('a domain module is handed the database and nothing else', () => {
  // `StoreContext` is `{db, now}` — no module reaches a *sibling module*, which is
  // what makes each one readable on its own and what stopped the split needing a
  // redesign. A cross-domain read belongs above the persistence layer, in the
  // caller that already holds both.
  const modules = domainModules();
  assert.ok(modules.length >= 10, 'the class was split, not renamed');
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    const siblings = modules.filter((m) => m !== file).map((m) => `./${m.slice('src/store/'.length, -3)}.js`);
    for (const sibling of siblings) {
      assert.ok(!source.includes(`'${sibling}'`), `${file} reaches ${sibling}; a domain module owns its own tables`);
    }
    // `verdicts.ts` is the deliberate exception, and only in one direction: it is a
    // declaration that imports nothing, so depending on it cannot reach a table.
    assert.ok(!readFileSync('src/store/verdicts.ts', 'utf8').includes('import'), 'the matrix stays dependency-free');
  }
});

test('every table is owned by exactly one module', () => {
  // Naming a table from two modules is how two writers come to disagree about the
  // invariants between them — the defect the verdict tables (which clear each
  // other, and so are deliberately one module) were split out to make readable.
  const tables = [...readFileSync('src/store/schema.ts', 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
    (m) => m[1],
  );
  assert.ok(tables.length > 20, 'the schema was read');
  const modules = domainModules();
  for (const table of tables) {
    // Matched where SQL names a table, never in prose: "agents" is a word three
    // modules use in a comment and one of them writes to.
    const named = new RegExp(`(?:FROM|INTO|UPDATE|TABLE)\\s+${table}\\b|^\\s{2}${table}: \\{`, 'm');
    const owners = modules.filter((f) => named.test(readFileSync(f, 'utf8')));
    assert.equal(owners.length, 1, `${table} is named by ${owners.join(', ') || 'nothing'}`);
  }
});

test('the transcript buffer survives close(), wherever the buffer lives', () => {
  // The one piece of mutable state under src/store/, and the one thing this move
  // could silently lose: output is buffered in memory and written on a ~16KB
  // threshold, on a read, and on close. `TranscriptStore` owns the buffer now, so
  // `Store.close()` has to ask it — and only a real file can tell whether it did.
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-store-'));
  const dbPath = join(dir, 'store.db');
  try {
    const store = new Store(dbPath);
    store.appendTranscript('agent_x', 'well under ');
    store.appendTranscript('agent_x', 'the flush threshold');
    store.close();

    const reopened = new Store(dbPath);
    assert.equal(reopened.getTranscript('agent_x'), 'well under the flush threshold');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
