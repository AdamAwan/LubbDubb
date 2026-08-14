import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { reapableBranches, type BranchReapContext } from '../src/branchReap.js';
import type { PullRequest, Task } from '../src/types.js';
import type { ActionSink, BranchDeleteInput, SendResult } from '../src/sink/actionSink.js';

// --- the predicate ---------------------------------------------------------

function pr(over: Partial<PullRequest> & { number: number; branch: string }): PullRequest {
  return {
    id: `pr_${over.number}`,
    title: `PR ${over.number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    merged: false,
    labels: [],
    ...over,
  };
}

const merged = (over: Partial<PullRequest> & { number: number; branch: string }): PullRequest =>
  pr({ merged: true, state: 'merged', ...over });

function ctx(over: Partial<BranchReapContext> = {}): BranchReapContext {
  return {
    defaultBranch: 'main',
    prAuthorConfigured: true,
    tasks: [],
    reaped: new Set<number>(),
    ...over,
  };
}

function task(over: Partial<Task> & { branch: string; status: Task['status'] }): Task {
  return {
    id: `task_${over.branch}`,
    kind: 'code',
    title: 'work',
    prompt: '',
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Task;
}

test('a merged PR yields its branch', () => {
  const out = reapableBranches([], [merged({ number: 7, branch: 'issue/7' })], ctx());
  assert.deepEqual(out, [{ prNumber: 7, branch: 'issue/7' }]);
});

test('an abandoned PR is never reaped — the work under it never landed', () => {
  const abandoned = pr({ number: 7, branch: 'issue/7', state: 'closed' });
  assert.deepEqual(reapableBranches([], [abandoned], ctx()), []);
});

test('an open PR is not reaped, whatever else it looks like', () => {
  const open = pr({ number: 7, branch: 'issue/7' });
  assert.deepEqual(reapableBranches([open], [open], ctx()), []);
});

test("a colleague's merged PR is left alone when prAuthor is unset", () => {
  const theirs = merged({ number: 7, branch: 'feature/theirs' });
  assert.deepEqual(reapableBranches([], [theirs], ctx({ prAuthorConfigured: false })), []);
});

test('with prAuthor unset, a harness branch shape is still ours', () => {
  const ours = merged({ number: 7, branch: 'issue/7/sync-cursor' });
  assert.deepEqual(reapableBranches([], [ours], ctx({ prAuthorConfigured: false })), [
    { prNumber: 7, branch: 'issue/7/sync-cursor' },
  ]);
});

test('a merged parent is held while the rung above it still targets its branch', () => {
  const parent = merged({ number: 7, branch: 'issue/7/part-1' });
  const child = pr({ number: 8, branch: 'issue/7/part-2', baseBranch: 'issue/7/part-1' });
  assert.deepEqual(reapableBranches([child], [parent], ctx()), []);
});

test('the same parent is reaped once its child has been retargeted', () => {
  const parent = merged({ number: 7, branch: 'issue/7/part-1' });
  const child = pr({ number: 8, branch: 'issue/7/part-2', baseBranch: 'main' });
  assert.deepEqual(reapableBranches([child], [parent], ctx()), [{ prNumber: 7, branch: 'issue/7/part-1' }]);
});

test('the default branch is never reaped, even if a PR claims to have merged it', () => {
  assert.deepEqual(reapableBranches([], [merged({ number: 7, branch: 'main' })], ctx()), []);
});

test('a branch with an agent still on it waits', () => {
  const landed = merged({ number: 7, branch: 'issue/7' });
  for (const status of ['queued', 'running', 'waiting'] as const) {
    assert.deepEqual(reapableBranches([], [landed], ctx({ tasks: [task({ branch: 'issue/7', status })] })), []);
  }
  // A finished task is no reason to wait.
  assert.deepEqual(reapableBranches([], [landed], ctx({ tasks: [task({ branch: 'issue/7', status: 'done' })] })), [
    { prNumber: 7, branch: 'issue/7' },
  ]);
});

test('a PR already reaped yields nothing — the closed window would otherwise re-ask for hours', () => {
  const landed = merged({ number: 7, branch: 'issue/7' });
  assert.deepEqual(reapableBranches([], [landed], ctx({ reaped: new Set([7]) })), []);
});

test('a reap recorded for an earlier PR does not suppress a re-cut branch of the same name', () => {
  // `issue/7` landed as PR 7 and was reaped; a later dispatch cut it again and it
  // landed as PR 9. The row is keyed on the PR for exactly this.
  const second = merged({ number: 9, branch: 'issue/7' });
  assert.deepEqual(reapableBranches([], [second], ctx({ reaped: new Set([7]) })), [{ prNumber: 9, branch: 'issue/7' }]);
});

test('two merged PRs on one branch delete it once', () => {
  const first = merged({ number: 7, branch: 'issue/7' });
  const second = merged({ number: 9, branch: 'issue/7' });
  assert.deepEqual(reapableBranches([], [first, second], ctx()), [{ prNumber: 7, branch: 'issue/7' }]);
});

// --- the desk, through a whole system --------------------------------------

/**
 * The real fake world, with the one outbound call this file is about recorded on
 * the way through. A wrapper rather than a stub sink: the retarget test needs
 * `setPullBase` to actually move the child in the fake world, which only the real
 * connector does.
 */
function build(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-reap-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
    ...over,
  });
  const worktrees = new FakeWorktreeManager(join(dir, 'wt'));
  const deletedOnRemote: string[] = [];
  // The sink has to exist before the system it delegates to does, so it reads the
  // real one out of a holder the build fills in.
  const held: { inner?: ActionSink } = {};
  const sink = new Proxy({} as ActionSink, {
    get(_t, prop: string) {
      if (prop === 'deleteBranch')
        return (input: BranchDeleteInput): Promise<SendResult> => {
          deletedOnRemote.push(input.branch);
          return held.inner!.deleteBranch(input);
        };
      return (input: never): unknown => (held.inner as unknown as Record<string, (i: never) => unknown>)[prop]!(input);
    },
  });
  const system = buildSystem(config, { backend: new FakePtyBackend(), worktrees, sink });
  held.inner = system.connector;
  return { system, worktrees, deletedOnRemote };
}

function landPr(
  system: ReturnType<typeof build>['system'],
  prNumber: number,
  branch: string,
  baseBranch?: string,
): void {
  system.connector.inject({ kind: 'new_pr', number: prNumber, title: `PR ${prNumber}`, branch, baseBranch });
  system.connector.inject({ kind: 'pr_closed', prNumber, merged: true });
}

test('a merged branch is deleted locally and on the remote, and recorded', async () => {
  const { system, worktrees, deletedOnRemote } = build();
  landPr(system, 7, 'issue/7');
  await system.harness.runCycle('manual');

  assert.deepEqual(worktrees.deleted, ['issue/7'], 'the local branch should have been deleted');
  assert.deepEqual(deletedOnRemote, ['issue/7'], 'the remote branch should have been deleted');
  assert.ok(system.store.reapedPrs().has(7), 'the reap should be recorded');
});

test('a second pulse does not re-delete a branch already reaped', async () => {
  const { system, worktrees, deletedOnRemote } = build();
  landPr(system, 7, 'issue/7');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  assert.deepEqual(worktrees.deleted, ['issue/7']);
  assert.deepEqual(deletedOnRemote, ['issue/7']);
});

test('a merged rung is not reaped until the rung above it has been retargeted off it', async () => {
  const { system, worktrees, deletedOnRemote } = build();
  system.connector.inject({
    kind: 'new_pr',
    number: 8,
    title: 'PR 8',
    branch: 'issue/7/part-2',
    baseBranch: 'issue/7/part-1',
  });
  landPr(system, 7, 'issue/7/part-1');

  // Pulse one: the retarget is written from this snapshot, so the child still reads
  // as based on the merged parent and the parent's branch is held.
  await system.harness.runCycle('manual');
  assert.deepEqual(worktrees.deleted, [], 'the parent branch is still an open PR base');
  assert.deepEqual(deletedOnRemote, []);

  // Pulse two reads the retargeted world.
  await system.harness.runCycle('manual');
  assert.deepEqual(worktrees.deleted, ['issue/7/part-1']);
  assert.deepEqual(deletedOnRemote, ['issue/7/part-1']);
});

test('an abandoned PR keeps its branch on both sides', async () => {
  const { system, worktrees, deletedOnRemote } = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: false });
  await system.harness.runCycle('manual');

  assert.deepEqual(worktrees.deleted, []);
  assert.deepEqual(deletedOnRemote, []);
  assert.equal(system.store.reapedPrs().has(7), false);
});

test('reapMergedBranches: false reaps nothing', async () => {
  const { system, worktrees, deletedOnRemote } = build({ reapMergedBranches: false });
  landPr(system, 7, 'issue/7');
  await system.harness.runCycle('manual');

  assert.deepEqual(worktrees.deleted, []);
  assert.deepEqual(deletedOnRemote, []);
  assert.equal(system.store.reapedPrs().has(7), false);
});
