import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_PIPELINE, DISPATCH_RULES } from '../src/dispatcher/rules.js';
import { askedAlready } from '../src/dispatcher/admission.js';
import type { DispatchContext, QueueItem } from '../src/dispatcher/dispatcher.js';
import type { Decision, Escalation, Issue, PullRequest, Task } from '../src/types.js';

// The rules/admission split. Two vocabularies that used to be one registry, and
// the invisibility that hid between them: a rule superseded by an earlier one
// `continue`d, so its candidate vanished with no queue entry and no reason.

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

// -- the pipeline is the only ordering ---------------------------------------

test('the pipeline holds every rule, and nothing that is not one', () => {
  for (const entry of DISPATCH_PIPELINE) {
    assert.ok(entry.id in DISPATCH_RULES, `${entry.id} is in the registry`);
    assert.equal(DISPATCH_RULES[entry.id].kind, 'rule', `${entry.id} is a rule, not an admission or a terminal`);
  }
  const rules = Object.entries(DISPATCH_RULES).filter(([, r]) => r.kind === 'rule');
  assert.equal(DISPATCH_PIPELINE.length, rules.length, 'every rule has a position — none is declared and never walked');
});

test('the non-rules stay in the registry but take no position', () => {
  // `decisions.rule` is persisted, so a row written months ago naming one of
  // these must still resolve to something the Decision log can render. That is
  // the whole reason the registry is a superset of the pipeline.
  // `StageRuleId` already makes the last assertion a compile-time one — these ids
  // are not in the type `DISPATCH_PIPELINE` entries carry. Asserted anyway, over
  // `string`, so the property survives someone widening that type.
  const positions: string[] = DISPATCH_PIPELINE.map((e) => e.id);
  for (const id of ['branch-notify', 'cooldown-escalate', 'idle'] as const) {
    assert.ok(id in DISPATCH_RULES, `${id} still resolves for an old decision row`);
    assert.notEqual(DISPATCH_RULES[id].kind, 'rule');
    assert.ok(!positions.includes(id), `${id} is not a stage — it transforms a proposal, or ends the cycle`);
  }
});

test('no entry carries a position of its own', () => {
  // The rot this change removed: a hand-written `number` on each entry claiming
  // to mirror an order it had drifted from. If one comes back, so does the drift.
  for (const [id, rule] of Object.entries(DISPATCH_RULES)) {
    assert.ok(!('number' in rule), `${id} names itself and nothing else`);
  }
});

// -- superseded: the hole the split exposed ----------------------------------

test('a pickup the assay supersedes is queued with the reason, not dropped', async () => {
  const d = new RuleDispatcher({}, {}, undefined, 'main', {}, {}, {}, { enabled: true });
  const { actions, upcoming } = await d.decide(ctx());

  // Unchanged: the assay is what goes out, and the pickup does not.
  const dispatched = actions.filter((a) => a.type === 'dispatch_code_agent').map((a) => a.originRef);
  assert.deepEqual(dispatched, ['issue:12:assay'], 'one agent on the issue, and it is the assayer');

  const pickup = queued(upcoming, 'issue:12');
  assert.ok(pickup, 'the pickup is still in the queue — it used to vanish entirely');
  assert.equal(pickup.status, 'superseded');
  assert.equal(pickup.rule, 'issue-pickup', 'attributed to the rule that proposed it, not to what held it');
  assert.match(pickup.reason, /superseded this cycle by "Issue goal needs checking"/);
});

test('a planner the assay supersedes is queued too', async () => {
  const d = new RuleDispatcher({}, {}, undefined, 'main', { enabled: true }, {}, {}, { enabled: true });
  const { upcoming } = await d.decide(ctx());

  const planner = queued(upcoming, 'issue:12:plan');
  assert.ok(planner, 'the planner is visible as held rather than absent');
  assert.equal(planner.status, 'superseded');
  assert.equal(planner.rule, 'issue-plan');
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
  const d = new RuleDispatcher({}, {}, undefined, 'main', {}, { enabled: true });
  const { upcoming } = await d.decide(ctx({ tasks: [done] }));

  const pickup = queued(upcoming, 'issue:12');
  assert.ok(pickup);
  assert.equal(pickup.status, 'superseded');
  assert.match(pickup.reason, /superseded this cycle by "Issue may be finished"/);
});

test('nothing is superseded when no rule in front of pickup is on', async () => {
  const { upcoming } = await new RuleDispatcher().decide(ctx());
  const pickup = queued(upcoming, 'issue:12');
  assert.equal(pickup?.status, 'dispatching', 'the default path is untouched by any of this');
});

// -- concern urgency comes off the pipeline ----------------------------------

test('CI outranks a review comment on one PR, because that is their pipeline order', async () => {
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
  assert.equal(dispatch?.rule, 'pr-ci-failing', 'one agent per branch, and CI is the concern it is sent for');
  assert.equal(dispatch?.originRef, 'pr:42:ci');
});

// -- ask once ----------------------------------------------------------------

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
