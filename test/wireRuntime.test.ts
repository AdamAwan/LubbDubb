import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { REPO_ROOT as ROOT } from './support/paths.js';

// → docs/spec/16-http-api.md#the-wire-contract

/**
 * The modules `src/wire.ts` may re-export a *value* from. `test/wireContract.test.ts`
 * holds that the contract declares no runtime of its own; this holds what it may
 * pass through, because a re-export is not a declaration and would slip past that
 * assertion with the whole server graph behind it. There are none today.
 */
const RUNTIME_MODULES: string[] = [];

test('the contract passes through runtime from the declared modules and no others', () => {
  const source = readFileSync(join(ROOT, 'src/wire.ts'), 'utf8');
  const from: string[] = [];
  for (const match of source.matchAll(/^export\s+(?<type>type\s+)?\{[^}]*\}\s+from\s+'(?<spec>[^']+)'/gm)) {
    if (match.groups?.type === undefined) from.push(match.groups?.spec ?? '');
  }
  assert.deepEqual(
    [...new Set(from)].sort(),
    [...RUNTIME_MODULES].sort(),
    'a value re-exported from src/wire.ts is bundled into the SPA — declare the module here deliberately',
  );
});

test('what the contract passes through is a leaf, so nothing server-only rides in with it', () => {
  for (const spec of RUNTIME_MODULES) {
    const seen = new Set<string>();
    const queue = [resolve(ROOT, 'src', spec.replace(/^\.\//, '').replace(/\.js$/, '.ts'))];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      const where = relative(ROOT, file);
      for (const match of text.matchAll(
        /^(?:import|export)\s+(?:(?<type>type)\s+)?(?:[^'\n]*\bfrom\s+)?'(?<spec>[^']+)'/gm,
      )) {
        const named = match.groups?.spec ?? '';
        if (!named.startsWith('.')) {
          assert.equal(
            match.groups?.type !== undefined,
            true,
            `${where} imports '${named}' by value; the cockpit bundle would carry it`,
          );
          assert.doesNotMatch(named, /^node:/, `${where} names a node builtin, which the browser has none of`);
          continue;
        }
        if (match.groups?.type !== undefined) continue;
        queue.push(resolve(dirname(file), named.replace(/\.js$/, '.ts')));
      }
    }
  }
});

test('the cockpit reaches the harness through src/wire.ts by export-from too', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/^export[^']*\bfrom\s+'(?<spec>[^']*src\/[^']*)'/gm)) {
        const spec = match.groups?.spec ?? '';
        if (!spec.startsWith('../')) continue;
        if (!spec.endsWith('src/wire.js')) offenders.push(`${relative(ROOT, path)} → ${spec}`);
      }
    }
  };
  walk(join(ROOT, 'web/src'));
  assert.deepEqual(offenders, [], 'the SPA may re-export the wire contract, and no other server module');
});
