import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

test('a faked backend with no streamSpawner refuses a stream launch instead of running claude', () => {
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      agentMode: 'stream',
      heartbeatIntervalMs: 999_999,
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(), errorMirror: () => {} },
  );
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'anything',
    prompt: 'anything',
    branch: 'feature/x',
    originRef: 'issue:1',
    originTitle: 'An issue',
  });
  assert.throws(
    () => system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'))),
    /no streamSpawner was injected/,
  );
  system.store.close();
});
