import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { buildReadPlan, hydrationMaxAgeMs, prReadRef, refsFinishedSince } from '../src/world/readPlan.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { PullRequest, Task, WorldSnapshot } from '../src/types.js';

const READ_AT = '2026-08-30T12:00:00.000Z';
const BEFORE = '2026-08-30T11:30:00.000Z';
const AFTER = '2026-08-30T12:00:30.000Z';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p1',
    number: 42,
    title: 'Make it better',
    branch: 'feat/better',
    ciStatus: 'passing',
    unresolvedComments: [{ id: 'c1', author: 'someone', body: 'please change this', handled: false }],
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Address 3 review comments on PR #42',
    prompt: 'do it',
    branch: 'feat/better',
    originRef: 'pr:42:comments',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: BEFORE,
    updatedAt: AFTER,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: READ_AT, pullRequests: [pr()], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    ...over,
  };
}

test('the comment concern is held while the reading predates the agent that just worked the branch', async () => {
  const { actions, upcoming } = await new RuleDispatcher().decide(ctx({ tasks: [task()] }));

  assert.equal(
    actions.find((a) => a.type === 'dispatch_code_agent'),
    undefined,
    'nothing is dispatched off a reading that cannot contain the work it is judging',
  );
  assert.equal(
    upcoming?.some((q) => q.origin === 'pr:42:comments'),
    false,
    'and it is not queued either — this is a stale reading, not a fleet that is busy',
  );
});

test('the same concern dispatches once the reading is newer than the agent', async () => {
  const { actions } = await new RuleDispatcher().decide(
    ctx({ tasks: [task({ updatedAt: BEFORE, createdAt: BEFORE })] }),
  );

  const dispatch = actions.find((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatch?.rule, 'pr-review-comment');
  assert.equal(dispatch?.originRef, 'pr:42:comments');
});

test('an agent still running holds the concern the way it always did, not through the guard', async () => {
  const { actions, upcoming } = await new RuleDispatcher().decide(
    ctx({ tasks: [task({ status: 'running', agentId: 'a1', updatedAt: BEFORE })] }),
  );

  assert.equal(
    actions.find((a) => a.type === 'dispatch_code_agent'),
    undefined,
  );
  assert.equal(
    upcoming?.some((q) => q.origin === 'pr:42:comments'),
    false,
    'one agent works a branch: the signal reaches the running one as a note',
  );
});

test('a pull request the fleet has not touched is unaffected by another that it has', async () => {
  const other = pr({ id: 'p2', number: 43, branch: 'feat/other' });
  const { actions } = await new RuleDispatcher().decide(
    ctx({ world: { takenAt: READ_AT, pullRequests: [pr(), other], issues: [] }, tasks: [task()] }),
  );

  const dispatch = actions.find((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatch?.originRef, 'pr:43:comments', 'the untouched pull request is decided as usual');
});

test("a finished task's entities are re-hydrated whatever their change token says", () => {
  const previous: WorldSnapshot = { takenAt: READ_AT, pullRequests: [pr()], issues: [] };
  const plan = buildReadPlan({
    previous,
    tasks: [task()],
    events: [],
    now: Date.parse(AFTER),
    lanes: { hotMaxAgeMs: 60_000, coldMaxAgeMs: 300_000 },
  });

  assert.equal(plan.fresh?.has(prReadRef(42)), true);
  assert.equal(hydrationMaxAgeMs(plan, prReadRef(42)), 0, 'zero is always past: the entry is dropped and re-read');
});

test('a task that ended before the reading leaves it alone', () => {
  const previous: WorldSnapshot = { takenAt: READ_AT, pullRequests: [pr()], issues: [] };
  const plan = buildReadPlan({
    previous,
    tasks: [task({ updatedAt: BEFORE })],
    events: [],
    now: Date.parse(AFTER),
    lanes: { hotMaxAgeMs: 60_000, coldMaxAgeMs: 300_000 },
  });

  assert.equal(
    plan.fresh?.has(prReadRef(42)),
    false,
    'the reading already contains that work — re-reading buys nothing',
  );
});

test('a task reaches its entity by origin root and by branch alike', () => {
  const byBranch = refsFinishedSince([task({ originRef: 'issue:12' })], [pr()], READ_AT);
  assert.deepEqual([...byBranch].sort(), ['issue:12', 'pr:42']);

  const byOrigin = refsFinishedSince([task({ branch: null })], [], READ_AT);
  assert.deepEqual([...byOrigin], ['pr:42'], 'the origin is finer than the entity; the root is what was read');
});

test('an active task claims nothing — it is the de-dup that covers those', () => {
  const running = refsFinishedSince([task({ status: 'running', agentId: 'a1' })], [pr()], READ_AT);
  assert.equal(running.size, 0, 'otherwise every entity the fleet is working reads as behind the fleet');
});

test('an unparseable reading is not evidence that anything is behind it', () => {
  assert.equal(refsFinishedSince([task()], [pr()], 'not a date').size, 0);
});
