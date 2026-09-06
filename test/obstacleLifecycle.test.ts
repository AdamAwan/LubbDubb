import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSTACLE_EXITS,
  OBSTACLE_STATES,
  OBSTACLE_STATES_A_PERSON_MUST_LEAVE,
  hasAutomaticExit,
  reachesAgents,
  stateAfterSighting,
} from '../src/obstacles/lifecycle.js';
import type { ObstacleState } from '../src/types.js';

test('every state has an exit that is not a person', () => {
  const stranded = OBSTACLE_STATES.filter(
    (state) => !OBSTACLE_STATES_A_PERSON_MUST_LEAVE.includes(state) && !hasAutomaticExit(state),
  );
  assert.deepEqual(
    stranded,
    [],
    `these states can only be left by an operator: ${stranded.join(', ')}. Give each one an exit that ` +
      `evidence, a clock or the pulse takes — or argue in review for adding it to the carve-out below.`,
  );
});

test('exactly one state is carved out, and it is muted', () => {
  assert.deepEqual(OBSTACLE_STATES_A_PERSON_MUST_LEAVE, ['muted']);
  assert.ok(!hasAutomaticExit('muted'), 'muted is the state a person put it in, and a person takes it out of');
});

test('every state is declared, and every declaration is a state', () => {
  assert.deepEqual([...OBSTACLE_STATES].sort(), Object.keys(OBSTACLE_EXITS).sort());
  for (const state of OBSTACLE_STATES) {
    for (const exit of OBSTACLE_EXITS[state]) {
      assert.ok(OBSTACLE_STATES.includes(exit.to), `${state} exits to ${exit.to}, which is not a state`);
      assert.ok(exit.how.length > 0, `${state} -> ${exit.to} does not say what moves it`);
    }
  }
});

test('resolved and dormant are not deletions', () => {
  for (const state of ['resolved', 'dormant'] as ObstacleState[]) {
    assert.equal(stateAfterSighting(state, 1), 'standing');
  }
});

test('one report is not evidence, and two independent voices are', () => {
  assert.equal(stateAfterSighting('sighted', 1), 'sighted');
  assert.equal(stateAfterSighting('sighted', 2), 'standing');
  assert.ok(!reachesAgents('sighted'), 'a row one voice carried reaches nobody');
  assert.ok(reachesAgents('standing'));
});

test('a report moves nothing an operator or the pulse decided', () => {
  assert.equal(stateAfterSighting('muted', 9), 'muted');
  assert.equal(stateAfterSighting('owned', 9), 'owned');
});
