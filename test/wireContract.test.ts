import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import type { CockpitState } from '../src/wire.js';
import type { AppState } from '../web/src/types.js';

/**
 * Issues #217 and #218. `buildStateSnapshot` had no declared return type and
 * `AppState` was a standalone mirror of what it happened to infer; the two met at
 * one unchecked assertion, so a renamed key was green in `typecheck`,
 * `typecheck:web` and `knip` alike and empty only in the browser.
 *
 * `src/wire.ts` is now the one declaration both sides name. That only stays true
 * while two properties hold, and both are structural rather than remembered:
 * the shared modules must carry **no runtime** (or a type-only import would start
 * pulling server code into the SPA bundle), and the cockpit must reach the
 * harness through **that module alone** (or the contract stops being the whole
 * surface without anything saying so).
 */

const ROOT = new URL('..', import.meta.url).pathname;

/** The modules the cockpit type-imports, transitively. Each must be declaration-only. */
const SHARED = ['src/wire.ts', 'src/types.ts'];

/**
 * A value declaration at the top level of a module — anything that survives type
 * erasure and therefore anything that would put server code in the browser
 * bundle. Deliberately crude and deliberately over-eager: a false positive here
 * costs a moment's reading, where a false negative is the thing being prevented.
 */
const RUNTIME = /^\s*(?:export\s+)?(?:const|let|var|function|class|enum|namespace)\s/m;

test('the shared wire modules carry no runtime, so the cockpit imports none', () => {
  for (const file of SHARED) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.equal(
      RUNTIME.test(source),
      false,
      `${file} declares a runtime value. It is type-imported by the cockpit, where ` +
        'anything that survives erasure becomes server code in the SPA bundle.',
    );
    // `import type` is erased; a plain `import` is not, and one here would drag
    // whatever it names along with it.
    for (const line of source.split('\n')) {
      if (!/^import\s/.test(line)) continue;
      assert.match(line.trim(), /^import type /, `${file}: every import must be \`import type\` — got: ${line.trim()}`);
    }
  }
});

test('the cockpit reaches the harness through src/wire.ts and nothing else', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/^import(?<type>\s+type)?[^']*'(?<spec>[^']*src\/[^']*)'/gm)) {
        const spec = match.groups?.spec ?? '';
        // Only imports that climb out of `web/` reach the harness; `./src/…`
        // inside the SPA is the cockpit's own tree.
        if (!spec.startsWith('../')) continue;
        const where = `${relative(ROOT, path)} → ${spec}`;
        if (!spec.endsWith('src/wire.js')) offenders.push(`${where} (only src/wire.js is the contract)`);
        else if (!match.groups?.type) offenders.push(`${where} (must be \`import type\`)`);
      }
    }
  };
  walk(join(ROOT, 'web/src'));
  assert.deepEqual(offenders, [], 'the SPA may name the wire contract, and no other server module');
});

/**
 * The producer and the consumer are the same type. This is the assertion the
 * issue asked for as its cheaper floor — "assign a real `buildStateSnapshot(...)`
 * result to an `AppState`-typed binding" — kept even though the shared
 * declaration makes it stronger than an assignment, because it is the one line
 * that fails if either side is quietly re-pointed at a copy.
 */
test('a real snapshot is the cockpit AppState, with no cast in between', async () => {
  const config = loadConfig({
    dbPath: ':memory:',
    worktreeRoot: join(mkTempName(), 'wt'),
    auth: { enabled: false } as never,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  const snapshot: AppState = buildStateSnapshot(system);
  const asContract: CockpitState = snapshot;
  // Nothing has pulsed, so the world is the documented empty one rather than a
  // live fetch — and every list the wire promises is still present.
  assert.equal(asContract.worldObservedAt, null);
  assert.deepEqual(asContract.world.issues, []);
  for (const key of ['recovery', 'retainedRuns', 'plans', 'planParts', 'stacks', 'flags', 'files'] as const) {
    assert.ok(Array.isArray(asContract[key]), `${key} is always shipped, never omitted`);
  }
  system.store.close?.();
});

function mkTempName(): string {
  return join(ROOT, 'node_modules', '.cache', 'wire-contract-test');
}
