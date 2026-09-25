import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { issuePickupStatus, type IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_PLANNING, planOrigin } from '../src/plans/planning.js';
import { SITTING_REASON } from '../src/intake/sitting.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { GoalCriteriaVersion, Issue, Plan } from '../src/types.js';
import { failAppraisalOpen, spentAppraisalAttempts } from './support/plans.js';

// → docs/spec/08-planning.md#the-intake-sitting-stands-in-front-of-the-planner

function issue(number: number): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: 'Do the thing.',
    state: 'open',
    labels: [],
    linkedPrNumber: null,
  };
}

function context(extra: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: '2026-07-25T12:00:00.000Z', pullRequests: [], issues: [issue(12)] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    ...extra,
    recentDecisions: spentAppraisalAttempts(12),
  };
}

function replanning(): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Issue 12',
    status: 'planning',
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

const criteria: GoalCriteriaVersion = {
  id: 'crit_1',
  originRef: 'issue:12',
  version: 2,
  supersedes: 'crit_0',
  text: 'A refund writes one ledger entry, never two.',
  author: null,
  reason: null,
  authoredAt: '2026-07-25T00:00:00.000Z',
};

const decide = (extra: Partial<DispatchContext>) =>
  new RuleDispatcher({ defaultBranch: 'main', planning: DEFAULT_PLANNING }).decide(context(extra));

test('an open sitting holds the planner, in the queue, with the reason on it', async () => {
  const held = await decide({ closedSittings: new Set() });
  assert.deepEqual(
    held.actions.map((a) => a.type),
    ['no_op'],
    'nothing is dispatched while the sitting is open',
  );
  const item = held.upcoming?.find((i) => i.origin === planOrigin(12));
  assert.equal(item?.status, 'sitting');
  assert.match(item?.reason ?? '', new RegExp(SITTING_REASON));

  const closed = await decide({ closedSittings: new Set(['issue:12']) });
  assert.equal(closed.actions[0]?.rule, 'issue-plan', 'a closed sitting releases the planner');

  const off = await decide({ closedSittings: null });
  assert.equal(off.actions[0]?.rule, 'issue-plan', 'with the gate off nothing is held');

  const replan = await decide({ closedSittings: new Set(), plans: [replanning()] });
  assert.equal(replan.actions[0]?.rule, 'issue-plan', 'a replan is never held behind a sitting');
});

test("the goal's current criteria are appended to the planner's prompt", async () => {
  const result = await decide({ closedSittings: new Set(['issue:12']), goalCriteria: [criteria] });
  const action = result.actions[0]!;
  const prompt = action.type === 'dispatch_code_agent' ? action.prompt : '';
  assert.ok(prompt.includes(criteria.text));
  assert.match(prompt, /version 2/);

  const without = await decide({ closedSittings: new Set(['issue:12']) });
  const bare = without.actions[0]!;
  assert.doesNotMatch(bare.type === 'dispatch_code_agent' ? bare.prompt : '', /What "done" means/);
});

test('the pickup verdict names the sitting, and only while no planner is on the goal', () => {
  const ctx = (extra: Partial<IssuePickupContext>): IssuePickupContext => ({
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-25T12:00:00.000Z',
    tasks: [],
    openPrs: [],
    headroom: 5,
    paused: false,
    recentDecisions: spentAppraisalAttempts(12),
    ...extra,
  });
  assert.deepEqual(issuePickupStatus(issue(12), ctx({ closedSittings: new Set() })), {
    eligible: false,
    status: 'sitting',
    reasons: [SITTING_REASON],
  });
  assert.equal(issuePickupStatus(issue(12), ctx({ closedSittings: new Set(['issue:12']) })).status, 'planning');
  assert.equal(issuePickupStatus(issue(12), ctx({})).status, 'planning');
});

test('closing the sitting through the reveal route releases the planner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sitting-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: dir,
    heartbeatIntervalMs: 999_999,
    prediction: { enabled: true },
    goalCriteria: { enabled: true },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Ship the thing', body: 'Please.' });
  failAppraisalOpen(system.store, 1);

  await system.harness.runCycle('manual');
  assert.equal(
    system.store.tasks.listTasks().some((t) => t.originRef === planOrigin(1)),
    false,
    'the planner waits for the sitting',
  );

  const written = await app.inject({
    method: 'POST',
    url: '/api/goals/1/criteria',
    payload: { text: 'The thing ships behind no flag.' },
  });
  assert.equal(written.statusCode, 200);
  const predicted = await app.inject({ method: 'POST', url: '/api/goals/1/prediction', payload: { locus: 'src/' } });
  assert.equal(predicted.statusCode, 200);

  const marked = await app.inject({
    method: 'POST',
    url: '/api/goals/1/prediction/marks',
    payload: { locus: 'matched' },
  });
  assert.equal(marked.statusCode, 409, 'there is no plan to mark against yet');

  const closed = await app.inject({ method: 'POST', url: '/api/goals/1/reveal' });
  assert.equal(closed.statusCode, 200);
  assert.equal((closed.json() as { reveal: { predicted: boolean } }).reveal.predicted, true);

  const planner = system.store.tasks.listTasks().find((t) => t.originRef === planOrigin(1));
  assert.ok(planner, 'the stamp releases the planner on the cycle it runs');
  assert.ok(system.store.tasks.getTask(planner.id)?.prompt.includes('The thing ships behind no flag.'));

  await app.close();
  system.store.close();
});
