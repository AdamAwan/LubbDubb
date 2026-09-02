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

/**
 * **Every state has an exit that is not you.**
 *
 * This is the invariant the store this replaces did not have, and it is asserted
 * rather than intended. Gating every durable claim on an operator's click meant its
 * output when nobody visited the page was exactly zero, and neglect had no degraded
 * mode — a queue only a human empties is exactly how the last attempt died
 * (`docs/spec/32-obstacles.md#what-went-wrong-last-time`). A convention would not
 * have caught it.
 *
 * So this file fails when a state is added without an automatic exit, and it carves
 * out `muted` **by name** rather than by predicate: a rule loose enough to admit one
 * would have admitted every state the previous store filled up with, and a second
 * entry in the carve-out is the failure this exists to catch.
 */

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
  // By name, and one entry. A second is the thing the carve-out exists to catch:
  // the day it holds two, this subsystem has a queue in it again.
  assert.deepEqual(OBSTACLE_STATES_A_PERSON_MUST_LEAVE, ['muted']);
  assert.ok(!hasAutomaticExit('muted'), 'muted is the state a person put it in, and a person takes it out of');
});

test('every state is declared, and every declaration is a state', () => {
  // The other half of the guard: a state added to the union without an entry here
  // does not typecheck, and one added to neither is not reachable at all.
  assert.deepEqual([...OBSTACLE_STATES].sort(), Object.keys(OBSTACLE_EXITS).sort());
  for (const state of OBSTACLE_STATES) {
    for (const exit of OBSTACLE_EXITS[state]) {
      assert.ok(OBSTACLE_STATES.includes(exit.to), `${state} exits to ${exit.to}, which is not a state`);
      assert.ok(exit.how.length > 0, `${state} -> ${exit.to} does not say what moves it`);
    }
  }
});

test('resolved and dormant are not deletions', () => {
  // A matching report reopens the row at `standing` with its whole history — the
  // only way a fix that did not stick is visible as a recurrence rather than
  // looking like a fresh problem every time.
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
  // Muting is an operator's statement and ownership is the harness's row. A
  // report that could undo either would let an agent unmute what somebody
  // silenced, or unpick a repair already dispatched.
  assert.equal(stateAfterSighting('muted', 9), 'muted');
  assert.equal(stateAfterSighting('owned', 9), 'owned');
});
