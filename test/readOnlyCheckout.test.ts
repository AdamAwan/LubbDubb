import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext, DispatchResult } from '../src/dispatcher/dispatcher.js';
import { readOnlyDispatch } from '../src/dispatcher/rules/readOnlyDispatch.js';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Issue, IssueDelivery, Plan, Task, ValidationCheck } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';
import { pastTheFunnel } from './support/plans.js';

/**
 * The **read-only checkout** (issue #396): what the three dispatches that only read
 * the repository take a worktree slot as.
 *
 * `issue-assay`, `issue-assess` and `validate-check` each dispatch a code agent that
 * is told in its prompt not to commit or push anything, and each used to mint a
 * branch cut from the default one to do it in. That branch never got a pull request,
 * so `reapableBranches` — which only ever deletes the branch of a **merged** one —
 * never collected it: one ref per assay, per assessment and per check, for the life
 * of the deployment, with nothing anywhere reading as wrong.
 *
 * Two properties are asserted in both directions here, because both fail silently:
 *
 * 1. **No ref, on either side.** A read-only slot is detached at the commit the ref
 *    resolves to, and nothing is left in `refs/heads` when it is released.
 * 2. **The lease is untouched.** A directory per branch was the only thing keeping
 *    two agents out of one checkout, and pooling replaced it with the lease. Several
 *    read-only agents pinned to one *name* is precisely the case the lease was
 *    written to refuse — so read-only work is leased under its key exactly as a
 *    branch is, including across the restart where the in-memory half is empty.
 */

const NOW = '2026-08-19T12:00:00.000Z';

// -- 1. the three rules, at the dispatcher ------------------------------------

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

/** A finished pickup — what tells the assessor apart from the assay. */
function priorWork(): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function plan(): Plan {
  return {
    id: 'plan-12',
    originRef: 'issue:12',
    title: 'Ship it',
    status: 'active',
    reason: 'One fix.',
    diagnosis: null,
    approach: null,
    alternatives: null,
    openQuestions: null,
    risks: null,
    outOfScope: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'every part merged',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

function handedOverCheck(): ValidationCheck {
  return {
    originRef: 'issue:12',
    id: 'csv-opens',
    letter: 'A',
    seq: 1,
    title: 'The export opens in Excel',
    do: 'Export a report and open it.',
    expect: 'It opens with the columns intact.',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'fleet',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The dispatch a rule produced for `origin`, as the executor will read it. */
function dispatchFor(
  actions: { type: string }[],
  origin: string,
): { branch: string; base?: string | null; readOnly?: boolean } {
  const action = actions.find((a) => 'originRef' in a && (a as { originRef?: string }).originRef === origin);
  assert.ok(action, `nothing dispatched for ${origin}`);
  assert.equal(action.type, 'dispatch_code_agent', 'it needs a checkout to read anything');
  return action as unknown as { branch: string; base?: string | null; readOnly?: boolean };
}

test('all three read-only rules ask for the same shape, and none keeps a private arrangement', async () => {
  // The assay: nothing has been started, so the goal is all there is to judge.
  const assay = await new RuleDispatcher().decide(ctx());
  // The assessor: work has been done and nothing is in flight.
  const assess = await new RuleDispatcher().decide(
    ctx({ tasks: [priorWork()], plans: [], recentDecisions: pastTheFunnel(12) }),
  );
  // A validation check the operator handed to the fleet on a parked goal.
  const validate = await new RuleDispatcher().decide(
    ctx({ plans: [plan()], deliveries: [delivered()], validationChecks: [handedOverCheck()] }),
  );

  for (const [origin, actions] of [
    ['issue:12:assay', assay.actions],
    ['issue:12:assess', assess.actions],
    ['issue:12:validate:csv-opens', validate.actions],
  ] as const) {
    const dispatch = dispatchFor(actions, origin);
    assert.equal(dispatch.readOnly, true, `${origin} needs a repository, not a branch of its own`);
    assert.equal(dispatch.base, 'main', `${origin} reads the default branch — the state it is asked about is on it`);
  }
});

test('a rule that writes code is untouched — the default is the writable shape', () => {
  // Not an assertion about a rule but about the schema's default: a dispatch that
  // says nothing about its checkout gets the branch it always had, so nothing that
  // commits can lose its branch by omission.
  assert.deepEqual(readOnlyDispatch('assay/issue/12', 'main'), {
    branch: 'assay/issue/12',
    base: 'main',
    readOnly: true,
  });
});

// -- 2. the executor seam -----------------------------------------------------

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-readonly-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 2,
  });
}

function planWith(actions: Record<string, unknown>[]): DispatchResult {
  return { rationale: 'test', rejected: [], actions } as unknown as DispatchResult;
}

test('the executor is the one place the shape is chosen', async () => {
  const worktrees = new FakeWorktreeManager();
  const system = buildSystem(testConfig(), { worktrees, backend: new FakePtyBackend(), errorMirror: () => {} });

  await system.executor.execute(
    'cyc',
    planWith([
      {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch('assay/issue/12', 'main'),
        title: 'Assay issue #12',
        prompt: 'read it',
        originRef: 'issue:12:assay',
        reason: 'r',
      },
      {
        type: 'dispatch_code_agent',
        branch: 'issue/13',
        title: 'Resolve issue #13',
        prompt: 'build it',
        originRef: 'issue:13',
        reason: 'r',
      },
    ]),
  );

  assert.deepEqual(worktrees.ensured, [
    { branch: 'assay/issue/12', base: 'main', readOnly: true },
    // The writable dispatch is unchanged: a branch, based on the configured
    // integration branch the executor fills in.
    { branch: 'issue/13', base: 'main' },
  ]);
  system.store.close();
});

// -- 3. the manager, where the git behaviour is the subject -------------------

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function manager(repo: string, size = 4, held: (name: string) => boolean = () => false): WorktreeManager {
  return new WorktreeManager(repo, join(repo, '.wt'), { size, held }, join(repo, '.preview'));
}

/** A repo that ignores `deps/` — the dependency tree in miniature. */
function warmableRepo(): string {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  writeFileSync(join(repo, '.gitignore'), 'deps/\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'ignore deps']);
  return repo;
}

/** The warm state an agent leaves behind: an installed dependency tree, ignored. */
function install(dir: string, note: string): void {
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), note);
}

/** Every local branch, so "no ref, on either side" can be asserted rather than assumed. */
function branches(repo: string): string[] {
  return git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .split('\n')
    .filter((l) => l !== '');
}

test('a read-only checkout is the default branch, detached, and leaves no ref behind', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const wt = manager(repo);

  const dir = await wt.ensureReadOnly('assay/issue/396', 'main');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'main']), 'the state the question is about');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached: there is no branch to leave');
  assert.deepEqual(branches(repo), ['main'], 'nothing was minted, so there is nothing for a reap to collect');

  // Releasing is the same release a branch gets, and it deletes nothing — least of
  // all a ref, since there was never one.
  await wt.remove('assay/issue/396');
  assert.deepEqual(branches(repo), ['main']);
  assert.ok(existsSync(dir), 'the directory stays standing for the next occupant');
});

test('two read-only agents are never handed one directory', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const wt = manager(repo);

  const a = await wt.ensureReadOnly('assay/issue/1', 'main');
  const b = await wt.ensureReadOnly('validate/issue/1/csv-opens', 'main');
  assert.notEqual(a, b, 'sharing a checkout is what the lease exists to refuse, ref or no ref');

  // And with nowhere to put the second one, the dispatch is *rejected* rather than
  // quietly landing in the first one's tree.
  const oneSlot = manager(gitRepo('lubbdubb-readonly-repo-'), 1);
  await oneSlot.ensureReadOnly('assay/issue/1', 'main');
  await assert.rejects(
    () => oneSlot.ensureReadOnly('assay/issue/2', 'main'),
    /No free worktree slot for read-only checkout assay\/issue\/2 of main/,
  );
});

test('a restart cannot clean a read-only tree out from under the agent still in it', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const dir = await manager(repo, 1).ensureReadOnly('assess/issue/12', 'main');

  // A new manager over the same pool: the in-memory leases are empty by
  // construction, so the durable half is all there is. A detached slot has no ref
  // for `pool.held` to be asked about — which is what the slot's mark answers.
  const afterRestart = manager(repo, 1, (name) => name === 'assess/issue/12');
  await assert.rejects(
    () => afterRestart.ensure('issue/13'),
    /work in flight on assess\/issue\/12/,
    'the restored assessor is still sitting in that directory',
  );

  // The mirror case, which is the one that keeps the pool from shrinking: the task
  // settles, and the slot is free that instant.
  const settled = manager(repo, 1);
  assert.equal(await settled.ensure('issue/13'), dir);
});

test('a read-only slot is warm for the next read-only checkout of the same ref', async () => {
  const repo = warmableRepo();
  const wt = manager(repo);

  const first = await wt.ensureReadOnly('assay/issue/1', 'main');
  install(first, 'from the assay');
  writeFileSync(join(first, 'scratch.txt'), 'the last agent left this');
  await wt.remove('assay/issue/1');

  // Preferred over a fresh slot, not merely tolerated: the pool is nowhere near its
  // bound here, and minting one would buy a cold install for nothing. Every
  // read-only checkout of a ref is the same tree to whoever gets it.
  const second = await wt.ensureReadOnly('validate/issue/2/csv-opens', 'main');
  assert.equal(second, first, 'the same slot, rather than one more cold checkout');
  assert.ok(existsSync(join(second, 'deps', 'installed.txt')), 'the build state answers the same source');
  assert.ok(!existsSync(join(second, 'scratch.txt')), "but the last agent's scratch is not this one's");
});

test("a branch handed a read-only slot is wiped — it is another source's output", async () => {
  const repo = warmableRepo();
  const wt = manager(repo, 1);

  const readOnly = await wt.ensureReadOnly('assay/issue/1', 'main');
  install(readOnly, 'from the assay');
  await wt.remove('assay/issue/1');

  const working = await wt.ensure('issue/1', 'main');
  assert.equal(working, readOnly, 'the pool is one slot, so this is a hand-over');
  assert.ok(!existsSync(join(working, 'deps', 'installed.txt')), 'a dist/ this branch never built is the bug');
  assert.equal(git(working, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/1');
});

test('a read-only checkout follows the ref rather than handing back a stale tree', async () => {
  const repo = warmableRepo();
  const wt = manager(repo, 1);

  await wt.ensureReadOnly('assess/issue/12', 'main');
  await wt.remove('assess/issue/12');
  writeFileSync(join(repo, 'shipped.txt'), 'the work that landed');
  // Named rather than `add .`: the pool's slots live under the repo here, and
  // sweeping one into the index is a warning and a confusing tree.
  git(repo, ['add', 'shipped.txt']);
  git(repo, ['commit', '-q', '-m', 'ship it']);

  const again = await wt.ensureReadOnly('assess/issue/12', 'main');
  assert.equal(git(again, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'main']));
  assert.ok(
    existsSync(join(again, 'shipped.txt')),
    'an assessor judging "was this delivered" against yesterday\'s tip answers the wrong question',
  );
});

test('a ref that resolves to nothing is refused rather than silently becoming HEAD', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const wt = manager(repo);
  await assert.rejects(() => wt.ensureReadOnly('assay/issue/1', 'no-such-branch'), /resolves to no commit/);
  assert.deepEqual(branches(repo), ['main'], 'and nothing was minted on the way to failing');
});
