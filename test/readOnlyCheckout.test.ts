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

const NOW = '2026-08-19T12:00:00.000Z';

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
    area: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function dispatchFor(
  actions: { type: string }[],
  origin: string,
): { branch: string; base?: string | null; readOnly?: boolean } {
  const action = actions.find((a) => 'originRef' in a && (a as { originRef?: string }).originRef === origin);
  assert.ok(action, `nothing dispatched for ${origin}`);
  assert.equal(action.type, 'dispatch_code_agent', 'it needs a checkout to read anything');
  return action as unknown as { branch: string; base?: string | null; readOnly?: boolean };
}

test('every read-only rule asks for the same shape, and none keeps a private arrangement', async () => {
  const appraisal = await new RuleDispatcher().decide(ctx());
  const assess = await new RuleDispatcher().decide(
    ctx({ tasks: [priorWork()], plans: [], recentDecisions: pastTheFunnel(12) }),
  );
  const validate = await new RuleDispatcher().decide(
    ctx({ plans: [plan()], deliveries: [delivered()], validationChecks: [handedOverCheck()] }),
  );

  const failed = await new RuleDispatcher().decide(
    ctx({
      plans: [plan()],
      deliveries: [delivered()],
      validationChecks: [
        { ...handedOverCheck(), actor: 'human', state: 'failed', resultNote: 'the columns shift', resultAt: NOW },
      ],
    }),
  );

  for (const [origin, actions] of [
    ['issue:12:appraisal', appraisal.actions],
    ['issue:12:assess', assess.actions],
    ['issue:12:validate:csv-opens', validate.actions],
    ['issue:12:validate-failure:csv-opens', failed.actions],
  ] as const) {
    const dispatch = dispatchFor(actions, origin);
    assert.equal(dispatch.readOnly, true, `${origin} needs a repository, not a branch of its own`);
    assert.equal(dispatch.base, 'main', `${origin} reads the default branch — the state it is asked about is on it`);
  }
});

test('a rule that writes code is untouched — the default is the writable shape', () => {
  assert.deepEqual(readOnlyDispatch('appraisal/issue/12', 'main'), {
    branch: 'appraisal/issue/12',
    base: 'main',
    readOnly: true,
  });
});

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
        ...readOnlyDispatch('appraisal/issue/12', 'main'),
        title: 'Appraise issue #12',
        prompt: 'read it',
        originRef: 'issue:12:appraisal',
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
    { branch: 'appraisal/issue/12', base: 'main', readOnly: true },
    { branch: 'issue/13', base: 'main' },
  ]);
  system.store.close();
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function manager(repo: string, size = 4, held: (name: string) => boolean = () => false): WorktreeManager {
  return new WorktreeManager(repo, join(repo, '.wt'), { size, held }, join(repo, '.preview'));
}

function warmableRepo(): string {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  writeFileSync(join(repo, '.gitignore'), 'deps/\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'ignore deps']);
  return repo;
}

function install(dir: string, note: string): void {
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), note);
}

function branches(repo: string): string[] {
  return git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .split('\n')
    .filter((l) => l !== '');
}

test('a read-only checkout is the default branch, detached, and leaves no ref behind', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const wt = manager(repo);

  const dir = await wt.ensureReadOnly('appraisal/issue/396', 'main');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'main']), 'the state the question is about');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached: there is no branch to leave');
  assert.deepEqual(branches(repo), ['main'], 'nothing was minted, so there is nothing for a reap to collect');

  await wt.remove('appraisal/issue/396');
  assert.deepEqual(branches(repo), ['main']);
  assert.ok(existsSync(dir), 'the directory stays standing for the next occupant');
});

test('two read-only agents are never handed one directory', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const wt = manager(repo);

  const a = await wt.ensureReadOnly('appraisal/issue/1', 'main');
  const b = await wt.ensureReadOnly('validate/issue/1/csv-opens', 'main');
  assert.notEqual(a, b, 'sharing a checkout is what the lease exists to refuse, ref or no ref');

  const oneSlot = manager(gitRepo('lubbdubb-readonly-repo-'), 1);
  await oneSlot.ensureReadOnly('appraisal/issue/1', 'main');
  await assert.rejects(
    () => oneSlot.ensureReadOnly('appraisal/issue/2', 'main'),
    /No free worktree slot for read-only checkout appraisal\/issue\/2 of main/,
  );
});

test('a restart cannot clean a read-only tree out from under the agent still in it', async () => {
  const repo = gitRepo('lubbdubb-readonly-repo-');
  const dir = await manager(repo, 1).ensureReadOnly('assess/issue/12', 'main');

  const afterRestart = manager(repo, 1, (name) => name === 'assess/issue/12');
  await assert.rejects(
    () => afterRestart.ensure('issue/13'),
    /work in flight on assess\/issue\/12/,
    'the restored assessor is still sitting in that directory',
  );

  const settled = manager(repo, 1);
  assert.equal(await settled.ensure('issue/13'), dir);
});

test('a read-only slot is warm for the next read-only checkout of the same ref', async () => {
  const repo = warmableRepo();
  const wt = manager(repo);

  const first = await wt.ensureReadOnly('appraisal/issue/1', 'main');
  install(first, 'from the appraisal');
  writeFileSync(join(first, 'scratch.txt'), 'the last agent left this');
  await wt.remove('appraisal/issue/1');

  const second = await wt.ensureReadOnly('validate/issue/2/csv-opens', 'main');
  assert.equal(second, first, 'the same slot, rather than one more cold checkout');
  assert.ok(existsSync(join(second, 'deps', 'installed.txt')), 'the build state answers the same source');
  assert.ok(!existsSync(join(second, 'scratch.txt')), "but the last agent's scratch is not this one's");
});

test("a branch handed a read-only slot is wiped — it is another source's output", async () => {
  const repo = warmableRepo();
  const wt = manager(repo, 1);

  const readOnly = await wt.ensureReadOnly('appraisal/issue/1', 'main');
  install(readOnly, 'from the appraisal');
  await wt.remove('appraisal/issue/1');

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
  await assert.rejects(() => wt.ensureReadOnly('appraisal/issue/1', 'no-such-branch'), /resolves to no commit/);
  assert.deepEqual(branches(repo), ['main'], 'and nothing was minted on the way to failing');
});
