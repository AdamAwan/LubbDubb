import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollUpIssueSpend } from '../src/issueSpend.js';
import type { Agent, LocalRun, Task, WorkNode } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';

// What a goal cost is spread across three origin shapes — the issue subtree, the
// pull requests its work opened, and an operator's job — and nothing added them
// up. These are the three, plus the remainder that reaches no goal at all.

const T = '2026-08-04T09:00:00.000Z';

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'done',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function task(id: string, originRef: string | null): Task {
  return {
    id: `task_${id}`,
    kind: 'code',
    title: `Task ${id}`,
    prompt: 'do it',
    branch: null,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: id,
    createdAt: T,
    updatedAt: T,
  };
}

function localRun(id: string, originRef: string, over: Partial<LocalRun> = {}): LocalRun {
  return {
    id,
    originRef,
    ref: 'feature/x',
    dir: '/preview',
    pid: 2,
    status: 'stopped',
    url: null,
    note: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 4,
    ...over,
  };
}

function node(ref: string, parentRef: string | null, kind: WorkNode['kind'] = 'pr'): WorkNode {
  return {
    ref,
    kind,
    parentRef,
    baseRef: null,
    title: ref,
    status: 'open',
    terminal: false,
    provenance: null,
    firstSeenAt: T,
    lastSeenAt: T,
  };
}

// -- attribution by name -----------------------------------------------------

test('the whole issue subtree is one goal, deliberation included', () => {
  const { byIssue, unattributedCostUsd } = rollUpIssueSpend({
    agents: [
      agent('a', { costUsd: 1.5 }),
      agent('b', { costUsd: 4 }), // the planner: money spent on the goal, whatever it built
      agent('c', { costUsd: 0.25 }),
      agent('d', { costUsd: 2 }),
    ],
    tasks: [
      task('a', 'issue:12'),
      task('b', 'issue:12:plan'),
      task('c', 'issue:12:appraisal'),
      task('d', 'issue:12:part:auth'),
    ],
    nodes: [],
    localRuns: [],
  });
  const spend = byIssue.get('issue:12')!;
  assert.equal(spend.costUsd, 7.75);
  assert.equal(spend.agents, 4);
  assert.equal(spend.issueNumber, 12);
  assert.equal(spend.originRef, 'issue:12');
  assert.equal(unattributedCostUsd, 0);
  assert.equal(byIssue.size, 1, 'four origins, one goal');
});

test('a goal keeps its own spend, and issue:120 is not issue:12', () => {
  const { byIssue } = rollUpIssueSpend({
    agents: [agent('a', { costUsd: 1 }), agent('b', { costUsd: 3 })],
    tasks: [task('a', 'issue:12'), task('b', 'issue:120')],
    nodes: [],
    localRuns: [],
  });
  assert.equal(byIssue.get('issue:12')!.costUsd, 1);
  assert.equal(byIssue.get('issue:120')!.costUsd, 3);
});

// -- attribution by lineage --------------------------------------------------

test("a pull request's agents are charged to the goal that produced it, sub-refs and all", () => {
  const { byIssue, unattributedCostUsd } = rollUpIssueSpend({
    agents: [agent('ci', { costUsd: 0.5 }), agent('rev', { costUsd: 0.75 }), agent('conf', { costUsd: 0.25 })],
    tasks: [task('ci', 'pr:41:ci'), task('rev', 'pr:41:comments'), task('conf', 'pr:41:mergeable')],
    // The part's PR, two levels down: the walk has to climb both edges.
    nodes: [node('pr:41', 'issue:12:part:auth'), node('issue:12:part:auth', 'issue:12', 'part')],
    localRuns: [],
  });
  assert.equal(byIssue.get('issue:12')!.costUsd, 1.5);
  assert.equal(byIssue.get('issue:12')!.agents, 3);
  assert.equal(unattributedCostUsd, 0);
});

test('a job reaches its goal only once the graph has adopted it', () => {
  const orphan = rollUpIssueSpend({
    agents: [agent('j', { costUsd: 2 })],
    tasks: [task('j', 'job:job_x')],
    nodes: [node('job:job_x', null, 'job')],
    localRuns: [],
  });
  assert.equal(orphan.byIssue.size, 0);
  assert.equal(orphan.unattributedCostUsd, 2, 'a job nobody linked is the remainder, never a goal');

  const adopted = rollUpIssueSpend({
    agents: [agent('j', { costUsd: 2 })],
    tasks: [task('j', 'job:job_x')],
    nodes: [node('job:job_x', 'issue:12', 'job')],
    localRuns: [],
  });
  assert.equal(adopted.byIssue.get('issue:12')!.costUsd, 2);
  assert.equal(adopted.unattributedCostUsd, 0);
});

// -- the second spender: local runs ------------------------------------------

test('a local run is the goal’s money too, counted apart from its agents', () => {
  const { byIssue, localRunAttribution } = rollUpIssueSpend({
    agents: [agent('a', { costUsd: 2 })],
    tasks: [task('a', 'issue:12')],
    nodes: [],
    // Its origin *is* the goal, so it needs no lineage hop — the one thing about a
    // local run that makes it the simplest source here.
    localRuns: [localRun('r1', 'issue:12', { costUsd: 0.5 }), localRun('r2', 'issue:12', { costUsd: 0.25 })],
  });
  const spend = byIssue.get('issue:12')!;
  assert.equal(spend.costUsd, 2.75, 'one figure: it was one goal’s work being looked at');
  assert.equal(spend.agents, 1, 'and the count the cockpit prints as “Agents” stays agents');
  assert.equal(spend.localRuns, 2);
  assert.equal(localRunAttribution.get('r1'), 12);
});

test('a local run of nothing the graph knows lands in the remainder', () => {
  const { byIssue, unattributedCostUsd, localRunAttribution } = rollUpIssueSpend({
    agents: [],
    tasks: [],
    nodes: [],
    localRuns: [localRun('r1', 'job:42', { costUsd: 0.6 })],
  });
  assert.equal(byIssue.size, 0);
  assert.equal(unattributedCostUsd, 0.6, 'never dropped — a partition with a visible remainder');
  assert.equal(localRunAttribution.get('r1'), null);
});

test('an unmeasured local run is no row and no count', () => {
  // Every local run on a PTY deployment: the runtime has no usage channel, so the
  // row carries nulls for ever. A count without money would read as a free preview.
  const { byIssue } = rollUpIssueSpend({
    agents: [],
    tasks: [],
    nodes: [],
    localRuns: [localRun('r1', 'issue:12', { costUsd: null, inputTokens: null, outputTokens: null, numTurns: null })],
  });
  assert.equal(byIssue.size, 0);
});

// -- the remainder, and what is deliberately not counted ---------------------

test('spend that reaches no goal is shipped as the remainder, never dropped', () => {
  const { byIssue, unattributedCostUsd } = rollUpIssueSpend({
    agents: [agent('a', { costUsd: 1 }), agent('x', { costUsd: 0.3 }), agent('y', { costUsd: 0.7 })],
    tasks: [task('a', 'issue:12'), task('x', null), task('y', 'pr:99:ci')],
    nodes: [], // pr:99 is in no graph: nothing says which goal it came out of
    localRuns: [],
  });
  assert.equal(byIssue.get('issue:12')!.costUsd, 1);
  assert.equal(unattributedCostUsd, 1);
});

test('a runtime that measured nothing contributes no row and no agent count', () => {
  // PTY mode reports no usage at all. Counting these would put "$0.00 · 2 agents"
  // on a goal two agents worked, which reads as free rather than as unmeasured.
  const { byIssue } = rollUpIssueSpend({
    agents: [
      agent('p', { costUsd: null, inputTokens: null, outputTokens: null, numTurns: null }),
      agent('q', { costUsd: null, inputTokens: null, outputTokens: null, numTurns: null }),
    ],
    tasks: [task('p', 'issue:12'), task('q', 'issue:12')],
    nodes: [],
    localRuns: [],
  });
  assert.equal(byIssue.size, 0, 'no measurement is not a zero measurement');
});

test('a token-only report still counts, and float sums stay readable', () => {
  const { byIssue } = rollUpIssueSpend({
    agents: [
      agent('a', { costUsd: 0.1, inputTokens: 900, outputTokens: 30 }),
      agent('b', { costUsd: 0.2, inputTokens: 100, outputTokens: 70 }),
      agent('c', { costUsd: null, inputTokens: 500, outputTokens: 0 }),
    ],
    tasks: [task('a', 'issue:7'), task('b', 'issue:7'), task('c', 'issue:7')],
    nodes: [],
    localRuns: [],
  });
  const spend = byIssue.get('issue:7')!;
  assert.equal(spend.costUsd, 0.3, 'not 0.30000000000000004');
  assert.equal(spend.inputTokens, 1500);
  assert.equal(spend.outputTokens, 100);
  assert.equal(spend.agents, 3);
});

test('a cycle in the lineage cannot hang the walk', () => {
  // `parent_ref` is write-once and therefore acyclic by construction; this is the
  // belt to that brace, and the assertion is that it terminates at all.
  const { byIssue, unattributedCostUsd } = rollUpIssueSpend({
    agents: [agent('a', { costUsd: 1 })],
    tasks: [task('a', 'pr:1:ci')],
    nodes: [node('pr:1', 'pr:2'), node('pr:2', 'pr:1')],
    localRuns: [],
  });
  assert.equal(byIssue.size, 0);
  assert.equal(unattributedCostUsd, 1);
});

// -- end to end: a stream agent's report lands on its goal's card -------------

/** Minimal fake claude stream-JSON process (the shape `usage.test.ts` uses). */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 778;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

test('a goal card carries what its agent reported, and the fleet remainder stays 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-spend-'));
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'stream',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), streamSpawner: spawner },
  );

  system.connector.inject({ kind: 'new_issue', number: 903, title: 'Add login' });
  await system.harness.runCycle('manual');
  children[0]!.emitLine({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.42,
    num_turns: 6,
    usage: { input_tokens: 900, output_tokens: 350, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
  });

  const snap = await buildStateSnapshot(system);
  const issue = snap.world.issues.find((i) => i.number === 903)!;
  assert.equal(issue.spend!.costUsd, 0.42);
  assert.equal(issue.spend!.issueNumber, 903);
  assert.equal(issue.spend!.inputTokens, 1000, 'cache tokens count as input, exactly as on the agent row');
  assert.equal(issue.spend!.agents, 1);
  assert.equal(snap.usage.unattributedCostUsd, 0, 'every dollar reached a goal');
  system.store.close();
});
