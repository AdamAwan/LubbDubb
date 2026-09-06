import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inFlight,
  localValidationOffer,
  localValidationSaid,
  localValidationTone,
  STATUS_WORD,
  validateLocallyQuestion,
} from '../web/src/view/localValidation.js';
import { GOAL_SECTIONS } from '../web/src/view/goalPage.js';
import type {
  Issue,
  LocalRunTargetView,
  LocalRunView,
  LocalValidationStatus,
  LocalValidationView,
} from '../src/wire.js';

const NOW = '2025-01-01T00:00:00.000Z';
const STATUSES: LocalValidationStatus[] = ['pending', 'dispatched', 'passed', 'failed', 'blocked', 'abandoned'];

function validation(over: Partial<LocalValidationView> = {}): LocalValidationView {
  return {
    id: 'lv1',
    originRef: 'issue:12',
    runId: 'run-1',
    ref: 'issue/12',
    commit: 'a'.repeat(40),
    status: 'dispatched',
    requestedAt: NOW,
    dispatchedAt: NOW,
    endedAt: null,
    taskId: 't1',
    fixTaskId: null,
    plan: null,
    summary: null,
    findings: [],
    visited: [],
    screenshots: [],
    note: null,
    phase: 'planning',
    files: [],
    agent: null,
    fixAgent: null,
    ...over,
  };
}

function run(over: Partial<LocalRunView> = {}): LocalRunView {
  return {
    id: 'run-1',
    originRef: 'issue:12',
    ref: 'issue/12',
    dir: '/tmp/local-run',
    commit: 'a'.repeat(40),
    pid: 1,
    status: 'running',
    url: 'http://localhost:5173',
    note: null,
    startedAt: NOW,
    endedAt: null,
    interruptedAt: null,
    lastSeenAt: NOW,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    live: true,
    refFacts: null,
    phase: null,
    turn: null,
    holdsSession: true,
    ports: null,
    freshness: { checkedAt: NOW, behindTip: 0, base: null },
    ...over,
  };
}

const target = (runnable: boolean): LocalRunTargetView =>
  ({ issueNumber: 12, runnable }) as unknown as LocalRunTargetView;

const goal = (localValidation: LocalValidationView | null): Pick<Issue, 'localValidation'> => ({ localValidation });

test('every status has a word and a tone — a row cannot be drawn as nothing', () => {
  for (const status of STATUSES) {
    assert.ok(STATUS_WORD[status].length > 0, `${status} has a word`);
    assert.ok(localValidationTone(status).length > 0, `${status} has a tone`);
  }
  assert.equal(localValidationTone('blocked'), 'off');
  assert.equal(localValidationTone('failed'), 'bad');
});

test('a run in flight says which minute of it we are in, and a settled one says its answer', () => {
  assert.equal(localValidationSaid(validation({ status: 'pending', phase: 'queued' })), 'waiting for a slot');
  assert.equal(localValidationSaid(validation({ phase: 'planning' })), 'writing the test plan');
  assert.equal(localValidationSaid(validation({ phase: 'environment' })), 'waiting for the environment');
  assert.equal(localValidationSaid(validation({ phase: 'driving' })), 'running the plan');
  assert.equal(localValidationSaid(validation({ status: 'failed', phase: null })), 'failed');

  assert.equal(inFlight(validation({ status: 'pending' })), true);
  assert.equal(inFlight(validation({ status: 'dispatched' })), true);
  assert.equal(inFlight(validation({ status: 'blocked' })), false);
  assert.equal(inFlight(null), false);
});

test('the control is offered only when there is something to press, and says why when there is not', () => {
  assert.deepEqual(localValidationOffer(goal(null), target(true), true), { offered: true });

  const unconfigured = localValidationOffer(goal(null), target(true), false);
  assert.equal(unconfigured.offered, false);
  assert.match(unconfigured.offered ? '' : unconfigured.why, /localRun\.instruction/);

  const noBranch = localValidationOffer(goal(null), target(false), true);
  assert.match(noBranch.offered ? '' : noBranch.why, /no branch of its own/);

  const busy = localValidationOffer(goal(validation()), target(true), true);
  assert.match(busy.offered ? '' : busy.why, /validating it now/);

  assert.deepEqual(localValidationOffer(goal(validation({ status: 'failed' })), target(true), true), { offered: true });
});

test('the two questions are raised exactly when they cannot be answered afterwards', () => {
  assert.equal(validateLocallyQuestion(12, null), null);
  assert.equal(validateLocallyQuestion(12, run({ live: false })), null);
  assert.equal(validateLocallyQuestion(12, run()), null);

  assert.equal(validateLocallyQuestion(12, run({ originRef: 'issue:99' })), 'swap');

  assert.equal(
    validateLocallyQuestion(12, run({ freshness: { checkedAt: NOW, behindTip: 2, base: null } })),
    'refresh',
  );
  assert.equal(
    validateLocallyQuestion(12, run({ turn: 'message', freshness: { checkedAt: NOW, behindTip: 2, base: null } })),
    null,
  );
});

test('the card is a foldable section, so the address bar can reach it', () => {
  assert.ok(GOAL_SECTIONS.includes('localValidation'));
});
