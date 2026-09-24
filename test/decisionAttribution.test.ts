import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Agent, Decision, Issue, PullRequest, Task } from '../src/types.js';
import { pastTheFunnel } from './support/plans.js';

const NOW = '2026-07-28T12:00:00.000Z';

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Make it better',
    body: 'the thing should be better',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p42',
    number: 42,
    title: 'A change',
    branch: 'feature/x',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function spentCap(origin: string, rule: string): Decision[] {
  return [1, 2, 3].map((n) => ({
    id: `dec_${n}`,
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', originRef: origin, reason: 'x', rule },
    outcome: 'executed' as const,
    detail: '',
    rule,
    admission: null,
    createdAt: '2026-07-25T00:00:00.000Z',
  }));
}

test('only admission-kind ids are ever emitted into the admission field', async () => {
  const d = new RuleDispatcher({ defaultBranch: 'main' });
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
      recentDecisions: [...pastTheFunnel(12), ...spentCap('issue:12', 'issue-pickup')],
    }),
  );
  for (const a of actions) {
    if (!a.admission) continue;
    assert.ok(a.admission in DISPATCH_RULES, `${a.admission} resolves in the registry`);
    assert.equal(DISPATCH_RULES[a.admission as keyof typeof DISPATCH_RULES].kind, 'admission');
  }
});

test('a throttled pickup names issue-pickup as its proposer, not the cap that stopped it', async () => {
  const d = new RuleDispatcher({ defaultBranch: 'main' });
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
      recentDecisions: [...pastTheFunnel(12), ...spentCap('issue:12', 'issue-pickup')],
    }),
  );
  const escalation = actions.find((a) => a.type === 'escalate_to_human');
  assert.ok(escalation, 'the spent cap escalates rather than looping');
  assert.equal(escalation.rule, 'issue-pickup', 'what got throttled — the fact the single column lost');
  assert.equal(escalation.admission, 'cooldown-escalate', 'and what throttling did to it');
});

test("a throttled PR concern names the concern's own rule", async () => {
  const d = new RuleDispatcher({ defaultBranch: 'main' });
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [pr({ ciStatus: 'failing' })], issues: [] },
      recentDecisions: spentCap('pr:42:ci', 'pr-ci-failing'),
    }),
  );
  const escalation = actions.find((a) => a.type === 'escalate_to_human');
  assert.ok(escalation);
  assert.equal(escalation.rule, 'pr-ci-failing', 'the top concern, which is what the dispatch would have been for');
  assert.equal(escalation.admission, 'cooldown-escalate');
});

test('a branch note records no proposer at all, and says so through the admission', async () => {
  const task: Task = {
    id: 't1',
    kind: 'code',
    title: 'Fix CI',
    prompt: 'x',
    branch: 'feature/x',
    originRef: 'pr:42:mergeable',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const agent: Agent = {
    id: 'a1',
    taskId: 't1',
    status: 'running',
    cwd: '/tmp/wt/feature-x',
    pid: null,
    waitingReason: null,
    sessionId: null,
    startedAt: NOW,
    endedAt: null,
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
  const d = new RuleDispatcher({ defaultBranch: 'main' });
  const { actions } = await d.decide(
    ctx({
      world: { takenAt: NOW, pullRequests: [pr({ ciStatus: 'failing' })], issues: [] },
      tasks: [task],
      agents: [agent],
    }),
  );
  const note = actions.find((a) => a.type === 'respond_to_agent');
  assert.ok(note, 'the fresh CI signal reaches the agent already on the branch');
  assert.equal(note.rule, null, 'no single rule proposed a note folding several concerns');
  assert.equal(note.admission, 'branch-notify');
  assert.deepEqual(note.originRefs, ['pr:42:ci'], 'what it covers is recorded per signal, finer than a rule id');
});

test('recordDecision lifts both ids off the action into their own columns', () => {
  const store = new Store(':memory:');
  const d = store.decisions.recordDecision({
    cycleId: 'cyc',
    action: {
      type: 'escalate_to_human',
      reason: 'capped',
      rule: 'issue-pickup',
      admission: 'cooldown-escalate',
    },
    outcome: 'executed',
    detail: '',
  });
  assert.equal(d.rule, 'issue-pickup');
  assert.equal(d.admission, 'cooldown-escalate');
  const [read] = store.decisions.listDecisions();
  assert.equal(read?.rule, 'issue-pickup', 'and survives the round trip');
  assert.equal(read?.admission, 'cooldown-escalate');
  store.close();
});

test('an action with no admission records null, never the rule over again', () => {
  const store = new Store(':memory:');
  const d = store.decisions.recordDecision({
    cycleId: 'cyc',
    action: { type: 'dispatch_code_agent', reason: 'go', rule: 'issue-pickup' },
    outcome: 'executed',
    detail: '',
  });
  assert.equal(d.rule, 'issue-pickup');
  assert.equal(d.admission, null, 'a proposal admitted unchanged has no outcome id');
  store.close();
});

test('the migration is additive on a database created before the column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-migrate-'));
  const path = join(dir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL,
      rule TEXT,
      created_at TEXT NOT NULL
    )`);
  old
    .prepare(`INSERT INTO decisions (id, cycle_id, action, outcome, detail, rule, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(
      'dec_old',
      'cyc',
      JSON.stringify({ type: 'escalate_to_human', reason: 'capped', rule: 'cooldown-escalate' }),
      'executed',
      'escalated',
      'cooldown-escalate',
      '2026-01-01T00:00:00.000Z',
    );
  old.close();

  const store = new Store(path);
  const columns = new Set(
    (new Database(path).prepare(`PRAGMA table_info(decisions)`).all() as { name: string }[]).map((c) => c.name),
  );
  assert.ok(columns.has('admission'), 'the column was added rather than the table recreated');

  const [row] = store.decisions.listDecisions();
  assert.equal(row?.id, 'dec_old', 'the pre-existing row is still there — nothing was rewritten');
  assert.equal(row?.rule, 'cooldown-escalate', 'and it still carries the outcome in the old place');
  assert.equal(row?.admission, null);

  store.decisions.recordDecision({
    cycleId: 'cyc2',
    action: { type: 'escalate_to_human', reason: 'x', rule: 'issue-pickup', admission: 'cooldown-escalate' },
    outcome: 'executed',
    detail: '',
  });
  const both = store.decisions.listDecisions();
  assert.equal(both.length, 2);
  store.close();
});
