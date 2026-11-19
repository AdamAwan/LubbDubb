import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentProgress, type AgentProgressInputs } from '../src/agents/agentProgress.js';
import { Store } from '../src/store/store.js';
import type { Agent, PrComment, PrThreadLabel, PullRequest, TaskSummary } from '../src/types.js';

function agent(id: string, taskId: string, endedAt: string | null = null): Agent {
  return {
    id,
    taskId,
    status: endedAt === null ? 'running' : 'done',
    cwd: '/tmp',
    pid: null,
    waitingReason: null,
    sessionId: null,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    steps: null,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
  };
}

function task(id: string, originRef: string, branch: string | null = null): TaskSummary {
  return {
    id,
    kind: 'code',
    title: id,
    branch,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: null,
    createdAt: '2026-01-01T00:00:00Z',
  } as TaskSummary;
}

function pr(number: number, branch: string, comments: PrComment[] = []): PullRequest {
  return { id: `pr${number}`, number, title: '', branch, ciStatus: 'passing', unresolvedComments: comments };
}

function comment(id: string, handled = false): PrComment {
  return { id, author: 'r', body: '', handled };
}

function label(agentId: string, prNumber: number, threadId: string): PrThreadLabel {
  return {
    prNumber,
    threadId,
    aboutComment: false,
    changedCode: true,
    resolved: true,
    path: null,
    author: null,
    authorIsBot: null,
    agentId,
    taskId: 't',
    answeredAt: '2026-01-01T00:00:00Z',
  };
}

function inputs(over: Partial<AgentProgressInputs>): AgentProgressInputs {
  return {
    agents: [],
    tasks: [],
    jobs: [],
    world: { takenAt: '', pullRequests: [], closedPullRequests: [], issues: [] },
    threadLabels: [],
    agentsWithFiles: new Set(),
    ...over,
  };
}

test('a comments agent counts the threads it answered against those still waiting', () => {
  const rows = agentProgress(
    inputs({
      agents: [agent('a1', 't1')],
      tasks: [task('t1', 'pr:7:comments')],
      world: {
        takenAt: '',
        pullRequests: [pr(7, 'b', [comment('th1'), comment('th2'), comment('th3'), comment('old', true)])],
        closedPullRequests: [],
        issues: [],
      },
      threadLabels: [label('a1', 7, 'th1'), label('a2', 7, 'th2'), label('a1', 8, 'th3')],
    }),
  );
  assert.deepEqual(rows, [{ agentId: 'a1', kind: 'count', label: 'comments handled', done: 1, total: 3 }]);
});

test('a thread the agent answered is not counted twice before the world catches up', () => {
  const rows = agentProgress(
    inputs({
      agents: [agent('a1', 't1')],
      tasks: [task('t1', 'pr:7:comments')],
      world: {
        takenAt: '',
        pullRequests: [pr(7, 'b', [comment('th1'), comment('th2')])],
        closedPullRequests: [],
        issues: [],
      },
      threadLabels: [label('a1', 7, 'th1'), label('a1', 7, 'th2')],
    }),
  );
  assert.deepEqual(rows[0], { agentId: 'a1', kind: 'count', label: 'comments handled', done: 2, total: 2 });
});

test('issue work moves through reading, making changes and PR open', () => {
  const base = { agents: [agent('a1', 't1')], tasks: [task('t1', 'issue:5:part:api', 'feat/api')] };
  assert.equal(agentProgress(inputs(base))[0]?.label, 'Reading');
  const editing = agentProgress(inputs({ ...base, agentsWithFiles: new Set(['a1']) }))[0];
  assert.deepEqual(editing, { agentId: 'a1', kind: 'stage', label: 'Making changes', done: 2, total: 3 });
  const opened = agentProgress(
    inputs({
      ...base,
      world: { takenAt: '', pullRequests: [pr(9, 'feat/api')], closedPullRequests: [], issues: [] },
    }),
  )[0];
  assert.deepEqual(opened, { agentId: 'a1', kind: 'stage', label: 'PR open', done: 3, total: 3 });
});

test('a CI fix has two stages and a job origin is read through to the work it redoes', () => {
  const rows = agentProgress(
    inputs({
      agents: [agent('a1', 't1')],
      tasks: [task('t1', 'job:j1')],
      jobs: [
        {
          id: 'j1',
          title: '',
          prompt: '',
          kind: 'code',
          branch: null,
          status: 'dispatched',
          originRef: 'pr:4:ci',
          taskId: 't1',
          createdAt: '',
          updatedAt: '',
        },
      ],
      agentsWithFiles: new Set(['a1']),
    }),
  );
  assert.deepEqual(rows, [{ agentId: 'a1', kind: 'stage', label: 'Making changes', done: 2, total: 2 }]);
});

test('ended agents and origins with nothing to measure have no reading', () => {
  const rows = agentProgress(
    inputs({
      agents: [agent('a1', 't1', '2026-01-01T01:00:00Z'), agent('a2', 't2'), agent('a3', 't3')],
      tasks: [task('t1', 'issue:5'), task('t2', 'issue:5:plan'), task('t3', 'pr:7:comments')],
    }),
  );
  assert.deepEqual(rows, []);
});

test('thread labels are read back for just the agents asked about', () => {
  const store = new Store(':memory:');
  const input = { aboutComment: false, changedCode: true, resolved: true, path: null, author: null, authorIsBot: null };
  store.prThreadLabels.recordThreadLabel({ ...input, prNumber: 1, threadId: 'x', agentId: 'a1', taskId: 't1' });
  store.prThreadLabels.recordThreadLabel({ ...input, prNumber: 1, threadId: 'y', agentId: 'a2', taskId: 't2' });
  assert.deepEqual(
    store.prThreadLabels.listThreadLabelsForAgents(['a1']).map((l) => l.threadId),
    ['x'],
  );
  assert.deepEqual(store.prThreadLabels.listThreadLabelsForAgents([]), []);
});
