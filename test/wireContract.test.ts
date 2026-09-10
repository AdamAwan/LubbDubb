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
import { REPO_ROOT as ROOT } from './support/paths.js';

const SHARED = ['src/wire.ts', 'src/types.ts'];

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
  assert.equal(asContract.worldObservedAt, null);
  assert.deepEqual(asContract.world.issues, []);
  for (const key of ['recovery', 'retainedRuns', 'plans', 'planParts', 'stacks', 'flags'] as const) {
    assert.ok(Array.isArray(asContract[key]), `${key} is always shipped, never omitted`);
  }
  system.store.close?.();
});

function mkTempName(): string {
  return join(ROOT, 'node_modules', '.cache', 'wire-contract-test');
}
