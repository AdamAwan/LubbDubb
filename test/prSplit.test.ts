import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { budgetNote, prBreadth, splitBranch, splitOrigin, splitTargetPr } from '../src/prSplit.js';
import { issueOriginRole } from '../src/issueOrigins.js';
import type { Agent, PullRequest } from '../src/types.js';
import { findTask } from './support/tasks.js';

function build(fileBudget?: number) {
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
    ...(fileBudget === undefined ? {} : { planning: { fileBudget } as never }),
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    sink: undefined,
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { number: 1, merged: false, unresolvedComments: [], ...over } as unknown as PullRequest;
}

test('breadth is three-valued: a provider that did not say is not a narrow pull request', () => {
  assert.equal(prBreadth(pr(), 20), null, 'no count is unknown, and unknown never fires the rule');
  assert.deepEqual(prBreadth(pr({ changedFiles: 4 }), 20), { files: 4, over: false });
  assert.deepEqual(
    prBreadth(pr({ changedFiles: 20 }), 20),
    { files: 20, over: false },
    'the budget itself is inside it',
  );
  assert.deepEqual(prBreadth(pr({ changedFiles: 21 }), 20), { files: 21, over: true });
  assert.equal(prBreadth(pr({ changedFiles: 400 }), 0), null, 'a budget of zero turns the reading off entirely');
  assert.equal(budgetNote(0), '', 'and with it the note every agent is told');
  assert.match(budgetNote(20), /20 changed files/);
});

test('the split origin names the issue, so the plan is the thing an agent can correct', () => {
  assert.equal(splitOrigin(12, 44), 'issue:12:split:44');
  assert.equal(splitBranch(44), 'split/pr/44');
  assert.equal(splitTargetPr('issue:12:split:44'), 44);
  assert.equal(splitTargetPr('issue:12:part:api'), null);
  assert.equal(splitTargetPr(null), null);
  assert.equal(
    issueOriginRole(12, 'issue:12:split:44'),
    'deliberation',
    'left unclassified it reads as unrecognised: no priority expansion, and its spend files under "other"',
  );
});

test('a pull request past the budget is asked whether it is one change or several', async () => {
  const system = build(20);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_pr', number: 44, title: 'Add the thing', branch: 'issue/12/api' });
  system.connector.inject({ kind: 'pr_size', prNumber: 44, changedFiles: 48 });
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'issue:12:split:44');
  assert.ok(task, 'the count is the prompt to look');
  assert.equal(task!.rule, 'pr-split');
  assert.equal(task!.branch, 'split/pr/44');
  system.store.close();
});

test('a pull request inside the budget, or one the provider did not measure, is left alone', async () => {
  const system = build(20);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_pr', number: 44, title: 'Small', branch: 'issue/12/api' });
  system.connector.inject({ kind: 'pr_size', prNumber: 44, changedFiles: 3 });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Other' });
  system.connector.inject({ kind: 'new_pr', number: 45, title: 'Unmeasured', branch: 'issue/13/api' });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => t.originRef === 'issue:12:split:44'),
    undefined,
  );
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'issue:13:split:45'),
    undefined,
    'a provider with no file count fails open rather than asking about every pull request',
  );
  system.store.close();
});

test('a pull request that maps to no issue is not asked: a split it cannot express is one it cannot propose', async () => {
  const system = build(20);
  system.connector.inject({ kind: 'new_pr', number: 44, title: 'A stray change', branch: 'feature-44' });
  system.connector.inject({ kind: 'pr_size', prNumber: 44, changedFiles: 48 });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => (t.originRef ?? '').includes(':split:')),
    undefined,
  );
  system.store.close();
});

test('one round ever: the verdict row is what stops it asking again, coherent or not', async () => {
  const system = build(20);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_pr', number: 44, title: 'Add the thing', branch: 'issue/12/api' });
  system.connector.inject({ kind: 'pr_size', prNumber: 44, changedFiles: 48 });

  system.store.recordPrSplitVerdict({
    prNumber: 44,
    issueNumber: 12,
    verdict: 'coherent',
    concepts: [],
    reason: 'One rename, sixty files.',
    files: 48,
    agentId: null,
  });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => t.originRef === 'issue:12:split:44'),
    undefined,
    'a push to a pull request already judged coherent does not buy a second reading',
  );
  const [recorded] = system.store.listPrSplitVerdicts();
  assert.equal(recorded!.verdict, 'coherent');
  assert.deepEqual(recorded!.concepts, []);
  system.store.close();
});

test('the verdict round-trips its concepts, and a re-record replaces rather than doubles', () => {
  const system = build(20);
  system.store.recordPrSplitVerdict({
    prNumber: 44,
    issueNumber: 12,
    verdict: 'split',
    concepts: ['schema', 'endpoint'],
    reason: 'Two things.',
    files: 48,
    agentId: 'a1',
  });
  system.store.recordPrSplitVerdict({
    prNumber: 44,
    issueNumber: 12,
    verdict: 'split',
    concepts: ['schema', 'endpoint', 'refactor'],
    reason: 'Three things.',
    files: 48,
    agentId: 'a1',
  });
  const rows = system.store.listPrSplitVerdicts();
  assert.equal(rows.length, 1, 'keyed on the pull request');
  assert.deepEqual(rows[0]!.concepts, ['schema', 'endpoint', 'refactor']);
  system.store.close();
});

// --- the tool ---------------------------------------------------------------

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

function spawnAgent(system: System, originRef: string): Agent {
  const t = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: splitBranch(44),
    originRef,
  });
  return system.agents.spawn(t, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

test('split_assess is advertised under its name in the allow-list', () => {
  assert.ok(MCP_TOOL_NAMES.includes('split_assess'), 'a tool missing from names.ts connects but is never callable');
});

test('a coherent verdict is a record: it is written, and nothing is asked of the agent after it', async () => {
  const system = build(20);
  const agent = spawnAgent(system, splitOrigin(12, 44));
  const res = await callTool(system, agent, 'split_assess', {
    verdict: 'coherent',
    reason: 'One rename, followed through every call site.',
    files: 48,
  });
  assert.equal(res.isError, false);
  const [row] = system.store.listPrSplitVerdicts();
  assert.equal(row?.verdict, 'coherent');
  assert.equal(row?.prNumber, 44);
  assert.equal(row?.issueNumber, 12, 'attribution is structural — the tool takes no pull request argument');
  assert.equal(row?.agentId, agent.id);
  assert.match(res.text, /do not review|do not touch the branch/);
  system.store.close?.();
});

test('a split needs its concepts named, and points the agent at plan_correct rather than at the branch', async () => {
  const system = build(20);
  const agent = spawnAgent(system, splitOrigin(12, 44));

  const thin = await callTool(system, agent, 'split_assess', {
    verdict: 'split',
    concepts: ['everything'],
    reason: 'It is big.',
    files: 48,
  });
  assert.equal(thin.isError, true, 'a split with one concept is not a split');
  assert.equal(system.store.listPrSplitVerdicts().length, 0, 'and a refusal writes nothing');

  const ok = await callTool(system, agent, 'split_assess', {
    verdict: 'split',
    concepts: ['schema', 'endpoint'],
    reason: 'The schema change and the endpoint could have been reviewed and reverted apart.',
    files: 48,
  });
  assert.equal(ok.isError, false);
  assert.deepEqual(system.store.listPrSplitVerdicts()[0]?.concepts, ['schema', 'endpoint']);
  assert.match(ok.text, /plan_correct/, 'the recording splits nothing on its own');
  assert.match(ok.text, /Do not close the pull request/);
  system.store.close?.();
});

test('the tool refuses an origin that is not a split, so a verdict never lands on the wrong pull request', async () => {
  const system = build(20);
  const agent = spawnAgent(system, 'issue:12:part:api');
  const res = await callTool(system, agent, 'split_assess', {
    verdict: 'coherent',
    reason: 'One thing.',
    files: 48,
  });
  assert.equal(res.isError, true);
  assert.equal(system.store.listPrSplitVerdicts().length, 0);
  system.store.close?.();
});
