import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { DISPATCH_RULES } from '../src/dispatcher/rules.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';

// Rule identity on decisions (issue #58): the rule dispatcher tags every action
// with a registry id, the store lifts it into its own column, and the cockpit
// looks the id up in DISPATCH_RULES — so each half is covered here.

function ctx(world: Partial<WorldSnapshot>): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], calendar: [], ...world },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    steeringPriorities: [],
    agentHeadroom: 3,
  };
}

test('every rule-dispatcher action carries a rule id from the registry', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        { id: 'p1', number: 42, title: 'X', branch: 'feat', ciStatus: 'failing', unresolvedComments: [] },
        {
          id: 'p2',
          number: 43,
          title: 'Y',
          branch: 'ok',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          merged: false,
        },
      ],
      issues: [{ id: 'i1', number: 9, title: 'Bug', body: 'b', labels: [], state: 'open', linkedPrNumber: null }],
    }),
  );
  for (const a of actions) {
    assert.ok(a.rule && a.rule in DISPATCH_RULES, `${a.type} carries a known rule id (got ${String(a.rule)})`);
  }
  const byOrigin = (o: string) => actions.find((a) => (a as { originRef?: string }).originRef === o);
  assert.equal(byOrigin('pr:42:ci')?.rule, 'pr-ci-failing');
  assert.equal(byOrigin('issue:9')?.rule, 'issue-pickup');
  assert.equal(actions.find((a) => a.type === 'merge_pr')?.rule, 'pr-merge-ready');
});

test('an idle cycle records the no-op under the idle rule', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(ctx({}));
  assert.equal(actions[0]?.type, 'no_op');
  assert.equal(actions[0]?.rule, 'idle');
});

test('the store lifts the rule off the action into its own column and round-trips it', () => {
  const store = new Store(':memory:');
  store.recordDecision({
    cycleId: 'c1',
    action: { type: 'dispatch_code_agent', reason: 'CI failing', rule: 'pr-ci-failing' },
    outcome: 'executed',
    detail: 'spawned',
  });
  // Decisions with no rule identity (LLM dispatcher, bookkeeping) stay null.
  store.recordDecision({
    cycleId: 'c1',
    action: { type: 'no_op', reason: 'cycle rationale' },
    outcome: 'skipped',
    detail: 'rationale',
  });
  // Same-millisecond timestamps make DESC order ambiguous — look up by type.
  const decisions = store.listDecisions();
  assert.equal(decisions.find((d) => d.action.type === 'dispatch_code_agent')?.rule, 'pr-ci-failing');
  assert.equal(decisions.find((d) => d.action.type === 'no_op')?.rule, null);
  store.close();
});
