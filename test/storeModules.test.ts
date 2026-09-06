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
  const importers = srcFiles('src').filter((f) => /from '(?:node:)?better-sqlite3'/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    importers.filter((f) => !f.startsWith('src/store/')),
    [],
    'everything else goes through the Store',
  );
  assert.ok(importers.length > 0, 'the driver is imported somewhere, or this assertion proves nothing');
});

test('a domain module is handed the database and nothing else', () => {
  const modules = domainModules();
  assert.ok(modules.length >= 10, 'the class was split, not renamed');
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    const siblings = modules.filter((m) => m !== file).map((m) => `./${m.slice('src/store/'.length, -3)}.js`);
    for (const sibling of siblings) {
      assert.ok(!source.includes(`'${sibling}'`), `${file} reaches ${sibling}; a domain module owns its own tables`);
    }
    assert.ok(!readFileSync('src/store/verdicts.ts', 'utf8').includes('import'), 'the matrix stays dependency-free');
  }
});

test('every table is owned by exactly one module', () => {
  const tables = [...readFileSync('src/store/schema.ts', 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
    (m) => m[1],
  );
  assert.ok(tables.length > 20, 'the schema was read');
  const modules = domainModules();
  for (const table of tables) {
    const named = new RegExp(`(?:FROM|INTO|UPDATE|TABLE)\\s+${table}\\b|^\\s{2}${table}: \\{`, 'm');
    const owners = modules.filter((f) => named.test(readFileSync(f, 'utf8')));
    assert.equal(owners.length, 1, `${table} is named by ${owners.join(', ') || 'nothing'}`);
  }
});

test('the transcript buffer survives close(), wherever the buffer lives', () => {
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
