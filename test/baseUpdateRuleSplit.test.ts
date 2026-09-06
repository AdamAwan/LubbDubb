import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import { findTask } from './support/tasks.js';

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const held: { inner?: ActionSink } = {};
  const sink = new Proxy({} as ActionSink, {
    get: (_t, prop: string) =>
      prop === 'updatePrBranch'
        ? () => Promise.resolve({ ok: false })
        : (input: never): unknown => (held.inner as unknown as Record<string, (i: never) => unknown>)[prop]!(input),
  });
  const system = buildSystem(config, { backend: new FakePtyBackend(), sink, worktrees: new FakeWorktreeManager() });
  held.inner = system.connector;
  return system;
}

test('the behind and conflicted arms dispatch under different rule ids, on one origin', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 51, title: 'Behind', branch: 'behind-branch', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 51, mergeable: true, mergeableState: 'behind' });
  system.connector.inject({ kind: 'new_pr', number: 52, title: 'Dirty', branch: 'dirty-branch', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 52, mergeable: false, mergeableState: 'dirty' });

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const behind = findTask(system.store, (t) => t.originRef === 'pr:51:mergeable');
  const conflict = findTask(system.store, (t) => t.originRef === 'pr:52:mergeable');
  assert.ok(behind, 'a provider that cannot merge the base falls back to an agent');
  assert.ok(conflict, 'a conflict always costs an agent');

  assert.equal(behind!.rule, 'pr-base-update');
  assert.equal(conflict!.rule, 'pr-base-update-conflict');
  assert.match(behind!.originRef!, /^pr:\d+:mergeable$/);
  assert.match(conflict!.originRef!, /^pr:\d+:mergeable$/);
  system.store.close();
});
