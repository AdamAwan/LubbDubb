/**
 * The half of the advisory gate that decides *what* is audited. The other half is the
 * OSV query, which is not exercised here: a test that reaches the network would report
 * the state of an upstream database rather than of this repo.
 *
 * What matters is the runtime/dev split. `npm ci` installs exactly what the lockfile
 * says, so the lockfile is the artefact — and `dev: true` is the only thing separating
 * a package an attacker can reach in a deployed harness from one that ships to nobody.
 * Read that flag the wrong way round and the gate goes quietly permissive.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTree } from '../scripts/audit.js';

const lockfile = (packages: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-audit-'));
  const path = join(dir, 'package-lock.json');
  writeFileSync(path, JSON.stringify({ lockfileVersion: 3, packages }));
  return path;
};

const names = (deps: readonly { name: string }[]): string[] => deps.map((dep) => dep.name).sort();

test('a dev-only package is out of the runtime gate and in the full scan', () => {
  const path = lockfile({
    '': { name: 'root' },
    'node_modules/ships': { version: '1.0.0' },
    'node_modules/toolchain': { version: '2.0.0', dev: true },
  });
  assert.deepEqual(names(readTree(path, false)), ['ships']);
  assert.deepEqual(names(readTree(path, true)), ['ships', 'toolchain']);
});

test('devOptional is reachable from runtime, so it stays in the gate', () => {
  const path = lockfile({
    '': { name: 'root' },
    'node_modules/either-way': { version: '1.0.0', devOptional: true },
  });
  assert.deepEqual(names(readTree(path, false)), ['either-way']);
});

test('local code is the tree, not a package in it — only registry deps are queried', () => {
  const path = lockfile({
    '': { name: 'root', version: '1.0.0' },
    'node_modules/@scope/linked': { resolved: 'packages/linked', link: true },
    // A workspace's own entry sits outside node_modules. Queried by its path it would
    // match nothing in OSV and report clean, which is the quiet way for a gate to lie.
    'packages/linked': { version: '1.0.0' },
    'node_modules/real': { version: '1.0.0' },
  });
  assert.deepEqual(names(readTree(path, false)), ['real']);
});

test('one version installed at two paths is asked about once', () => {
  const path = lockfile({
    '': { name: 'root' },
    'node_modules/dup': { version: '1.0.0' },
    'node_modules/other/node_modules/dup': { version: '1.0.0' },
    'node_modules/third/node_modules/dup': { version: '2.0.0' },
  });
  const deps = readTree(path, false);
  assert.deepEqual(deps.map((dep) => `${dep.name}@${dep.version}`).sort(), ['dup@1.0.0', 'dup@2.0.0']);
});

test('a scoped package keeps its scope when the entry does not name it', () => {
  const path = lockfile({ '': { name: 'root' }, 'node_modules/@scope/pkg': { version: '1.0.0' } });
  assert.deepEqual(readTree(path, false)[0]?.name, '@scope/pkg');
});

test('a lockfile too old to list packages is refused, never read as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-audit-'));
  const path = join(dir, 'package-lock.json');
  writeFileSync(path, JSON.stringify({ lockfileVersion: 1, dependencies: { anything: { version: '1.0.0' } } }));
  assert.throws(() => readTree(path, false), /lockfileVersion 2 or later/);
});
