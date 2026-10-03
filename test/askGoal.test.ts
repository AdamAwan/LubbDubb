import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askGoal } from '../src/asks/askGoal.js';
import type { AppState, Issue, PlanPartView, PlanView } from '../web/src/types.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

/* → docs/spec/17-cockpit.md#the-setting-beside-the-act */

const demo: AppState = buildDemoState().state;
const [baseIssue] = demo.world.issues;
const [basePlan] = demo.plans;
const [basePart] = demo.planParts;
assert.ok(baseIssue && basePlan && basePart, 'the demo state carries an issue, a plan and a part to vary');

const issue = (number: number, title: string): Issue => ({ ...baseIssue, id: `i${number}`, number, title });

const part = (planId: string, slug: string, seq: number, status: PlanPartView['status']): PlanPartView => ({
  ...basePart,
  id: `${planId}-${slug}`,
  planId,
  slug,
  seq,
  title: slug,
  status,
});

const plan = (id: string, originRef: string, revealed: boolean): PlanView => ({ ...basePlan, id, originRef, revealed });

type Inputs = Parameters<typeof askGoal>[0];

test('the goal beside an ask: its parts in order, retired ones left out, the asked part marked', () => {
  const state: Inputs = {
    world: { issues: [issue(12, 'Ship the export')] },
    retainedRuns: [],
    plans: [plan('p1', 'issue:12', true)],
    planParts: [part('p1', 'export', 2, 'ready'), part('p1', 'schema', 1, 'merged'), part('p1', 'old', 3, 'retired')],
  };
  const row = { id: 'a', goalRef: 'issue:12', originRef: 'issue:12:part:export' };
  const goal = askGoal(state, row, [row, { id: 'b', goalRef: 'issue:12' }, { id: 'c', goalRef: null }]);
  assert.equal(goal?.issue?.title, 'Ship the export');
  assert.deepEqual(
    goal?.parts.map((p) => [p.seq, p.group, p.here]),
    [
      [1, 'merged', false],
      [2, 'waiting', true],
    ],
  );
  assert.equal(goal?.otherAsks, 1);
  assert.equal(askGoal(state, { id: 'x', goalRef: null, originRef: null }, []), null);
});

test('a goal that has left the world is read off the retained runs, and a withheld plan says so', () => {
  const state: Inputs = {
    world: { issues: [] },
    retainedRuns: [issue(7, 'Retained')],
    plans: [plan('p7', 'issue:7', false)],
    planParts: [],
  };
  const goal = askGoal(state, { id: 'a', goalRef: 'issue:7', originRef: 'issue:7' }, []);
  assert.equal(goal?.issue?.title, 'Retained');
  assert.equal(goal?.withheld, true);
  assert.deepEqual(goal?.parts, []);
});
