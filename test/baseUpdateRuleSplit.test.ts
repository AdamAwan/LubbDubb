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

/**
 * The two arms of `needsBaseUpdate` are two rule ids, so `agentModels.byRule` can
 * price them apart — and the deployment that needs that most is the one with no
 * cheap arm at all. `updatePrBranch` answers `ok: false` here, which is what
 * `compositeConnector` returns when no integration implements it: an Azure
 * DevOps deployment, where *both* arms end up dispatching an agent and one rule
 * id would have put a conflict resolution and a routine base merge on one
 * profile.
 */
function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  // The sink has to exist before the system it delegates to does, so it reads the
  // real one out of a holder the build fills in.
  const held: { inner?: ActionSink } = {};
  const sink = new Proxy({} as ActionSink, {
    get: (_t, prop: string) =>
      prop === 'updatePrBranch'
        ? () => Promise.resolve({ ok: false })
        : (input: never): unknown => (held.inner as unknown as Record<string, (i: never) => unknown>)[prop]!(input),
  });
  // `worktrees` is injected, or the dispatch cuts a real branch in whatever
  // checkout the suite is running in (CLAUDE.md).
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

  // Two cycles: the first spends the behind arm's direct attempt, which this
  // provider cannot perform, and the audit row is what the second reads to build
  // the concern as the dispatch it always was.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const behind = findTask(system.store, (t) => t.originRef === 'pr:51:mergeable');
  const conflict = findTask(system.store, (t) => t.originRef === 'pr:52:mergeable');
  assert.ok(behind, 'a provider that cannot merge the base falls back to an agent');
  assert.ok(conflict, 'a conflict always costs an agent');

  assert.equal(behind!.rule, 'pr-base-update');
  assert.equal(conflict!.rule, 'pr-base-update-conflict');
  // The split is the price, not the accounting: both arms still mint the origin
  // the cooldown and the attempt cap are keyed on.
  assert.match(behind!.originRef!, /^pr:\d+:mergeable$/);
  assert.match(conflict!.originRef!, /^pr:\d+:mergeable$/);
  system.store.close();
});
