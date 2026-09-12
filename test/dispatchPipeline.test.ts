import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher, STAGES } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_PIPELINE, DISPATCH_RULES } from '../src/dispatcher/rules.js';
import { askedAlready } from '../src/dispatcher/admission.js';
import type { DispatchContext, QueueItem } from '../src/dispatcher/dispatcher.js';
import type { Decision, Escalation, Issue, PullRequest, Task } from '../src/types.js';
import { pastTheFunnel } from './support/plans.js';

const NOW = '2026-07-28T12:00:00.000Z';

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

function queued(upcoming: QueueItem[] | undefined, origin: string): QueueItem | undefined {
  return upcoming?.find((q) => q.origin === origin);
}

test('the pipeline holds every rule, and nothing that is not one', () => {
  for (const entry of DISPATCH_PIPELINE) {
    assert.ok(entry.id in DISPATCH_RULES, `${entry.id} is in the registry`);
    assert.equal(DISPATCH_RULES[entry.id].kind, 'rule', `${entry.id} is a rule, not an admission or a terminal`);
  }
  const rules = Object.entries(DISPATCH_RULES).filter(([, r]) => r.kind === 'rule');
  assert.equal(DISPATCH_PIPELINE.length, rules.length, 'every rule has a position — none is declared and never walked');
});

test('every rule in the pipeline has a body, its own or a named one', () => {
  for (const entry of DISPATCH_PIPELINE) {
    const owner = entry.emittedBy ?? entry.id;
    assert.ok(
      owner in STAGES,
      `${entry.id} is walked but nothing produces it — give it a stage, or declare the stage that emits it`,
    );
    if (entry.emittedBy) {
      assert.ok(
        !(entry.id in STAGES),
        `${entry.id} is emitted by ${entry.emittedBy}; a stage of its own would run twice`,
      );
      assert.equal(
        DISPATCH_RULES[entry.emittedBy as keyof typeof DISPATCH_RULES]?.kind,
        'rule',
        `${entry.id} names ${entry.emittedBy}, which must itself be a rule in the pipeline`,
      );
    }
  }
});

test('no stage is registered for a rule the pipeline does not walk', () => {
  const walked = new Set<string>(DISPATCH_PIPELINE.map((e) => e.id));
  for (const id of Object.keys(STAGES)) assert.ok(walked.has(id), `${id} has a body but no position`);
});

test('the PR concern pass owns the concerns, and is the only stage that does', () => {
  const emitted = DISPATCH_PIPELINE.filter((e) => e.emittedBy).map((e) => e.id);
  assert.deepEqual(
    emitted,
    [
      'pr-review',
      'pr-review-comment',
      'pr-ci-blocked',
      'pr-ci-gate',
      'pr-base-update',
      'pr-base-update-conflict',
      'pr-merge-ready',
    ],
    'one pass over the open PRs, because at most one agent works a branch',
  );
  for (const e of DISPATCH_PIPELINE) if (e.emittedBy) assert.equal(e.emittedBy, 'pr-ci-failing');
});

test('the non-rules stay in the registry but take no position', () => {
  const positions: string[] = DISPATCH_PIPELINE.map((e) => e.id);
  for (const id of ['branch-notify', 'cooldown-escalate', 'idle'] as const) {
    assert.ok(id in DISPATCH_RULES, `${id} still resolves for an old decision row`);
    assert.notEqual(DISPATCH_RULES[id].kind, 'rule');
    assert.ok(!positions.includes(id), `${id} is not a stage — it transforms a proposal, or ends the cycle`);
  }
});

test('no entry carries a position of its own', () => {
  for (const [id, rule] of Object.entries(DISPATCH_RULES)) {
    assert.ok(!('number' in rule), `${id} names itself and nothing else`);
  }
});

test('a planner the appraisal supersedes is queued with the reason, not dropped', async () => {
  const d = new RuleDispatcher();
  const { upcoming } = await d.decide(ctx());

  const planner = queued(upcoming, 'issue:12:plan');
  assert.ok(planner, 'it is still in the queue — it used to vanish entirely');
  assert.equal(planner.status, 'superseded');
  assert.equal(planner.rule, 'issue-plan', 'attributed to the rule that proposed it, not to what held it');
  assert.match(planner.reason, /superseded this cycle by "Issue goal needs checking"/);
});

test('a pickup the assessor supersedes names the assessor', async () => {
  const done: Task = {
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
  const d = new RuleDispatcher();
  const { upcoming } = await d.decide(ctx({ tasks: [done], recentDecisions: pastTheFunnel(12) }));

  const pickup = queued(upcoming, 'issue:12');
  assert.ok(pickup);
  assert.equal(pickup.status, 'superseded');
  assert.match(pickup.reason, /superseded this cycle by "Issue may be finished"/);
});

test('nothing is superseded when no rule in front of pickup is on', async () => {
  const { upcoming } = await new RuleDispatcher().decide(ctx({ recentDecisions: pastTheFunnel(12) }));
  const pickup = queued(upcoming, 'issue:12');
  assert.equal(pickup?.status, 'dispatching', 'the default path is untouched by any of this');
});

test('a review comment outranks CI on one PR, because that is their pipeline order', async () => {
  const pr: PullRequest = {
    id: 'p1',
    number: 42,
    title: 'X',
    branch: 'feat',
    ciStatus: 'failing',
    unresolvedComments: [{ id: 'c1', author: 'someone', body: 'please change this', handled: false }],
  };
  const { actions } = await new RuleDispatcher().decide(
    ctx({ world: { takenAt: NOW, pullRequests: [pr], issues: [] } }),
  );

  const dispatch = actions.find((a) => a.type === 'dispatch_code_agent');
  assert.equal(
    dispatch?.rule,
    'pr-review-comment',
    'one agent per branch, and the review is the concern it is sent for',
  );
  assert.equal(dispatch?.originRef, 'pr:42:comments');
});

test('a review comment outranks a merge conflict, because the review is about to rewrite the hunks', async () => {
  const pr: PullRequest = {
    id: 'p1',
    number: 42,
    title: 'X',
    branch: 'feat',
    ciStatus: 'passing',
    mergeable: false,
    mergeableState: 'dirty',
    unresolvedComments: [{ id: 'c1', author: 'someone', body: 'use the other approach', handled: false }],
  };
  const { actions, upcoming } = await new RuleDispatcher().decide(
    ctx({ world: { takenAt: NOW, pullRequests: [pr], issues: [] } }),
  );

  const dispatch = actions.find((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatch?.rule, 'pr-review-comment');
  assert.equal(dispatch?.originRef, 'pr:42:comments');
  assert.equal(
    upcoming?.some((q) => q.origin === 'pr:42:mergeable'),
    false,
    'one agent per branch: the losing concern does not become a queue entry of its own',
  );
});

test('askedAlready reads both records, because each outlives the other', () => {
  const origin = 'pr:42:ci';
  const open = [{ context: { originRef: origin } }] as unknown as Escalation[];
  const asked = [
    { outcome: 'executed', action: { type: 'escalate_to_human', context: { originRef: origin } } },
  ] as unknown as Decision[];

  assert.equal(askedAlready(origin, [], []), false, 'nothing standing, nothing recorded');
  assert.equal(askedAlready(origin, open, []), true, 'an open inbox item is the visible state');
  assert.equal(askedAlready(origin, [], asked), true, 'an answered one is still recent enough to not re-ask');
  assert.equal(askedAlready('pr:43:ci', open, asked), false, 'and it is per origin');
});

test('a decision that was not executed is not an ask', () => {
  const origin = 'pr:42:ci';
  const rejected = [
    { outcome: 'rejected', action: { type: 'escalate_to_human', context: { originRef: origin } } },
  ] as unknown as Decision[];
  assert.equal(askedAlready(origin, [], rejected), false, 'a question that never went out was never asked');
});
