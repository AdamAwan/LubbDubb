import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildStateSnapshot } from '../src/server/app.js';

test('the state snapshot reports per-PR health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const system = buildSystem(
    loadConfig({ dbPath: ':memory:', dispatcher: 'rule', deskRoot: join(dir, 'd'), worktreeRoot: join(dir, 'w') }),
    { backend: new FakePtyBackend() },
  );
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });

  const snap = await buildStateSnapshot(system);
  const pr = snap.world.pullRequests[0]!;
  assert.deepEqual(pr.health, { blocked: true, reasons: ['merge conflicts'] });
  system.store.close();
});
