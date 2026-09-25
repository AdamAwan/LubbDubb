import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { buildDigestDocument } from '../src/pool/digestArm.js';
import { foldPoolDigest } from '../src/pool/aggregate.js';
import { parsePoolDocument, serialisePoolDocument } from '../src/pool/document.js';
import { choiceLabel, choiceSightings, isChoiceKey, type ChoiceInput } from '../src/insights/choiceInsights.js';

const NOW = '2026-08-24T12:00:00.000Z';
const SINCE = '2026-06-01T00:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const AT = '2026-08-20T10:00:00.000Z';

function input(over: Partial<ChoiceInput>): ChoiceInput {
  return {
    since: SINCE,
    descriptionsWritten: [],
    draftsTaken: [],
    proposals: [],
    checks: [],
    conclusions: [],
    deliveries: [],
    shortfalls: [],
    choicesOff: [],
    firstCriteria: [],
    plans: [],
    watches: [],
    queries: [],
    sequences: [],
    ...over,
  };
}

function tally(i: ChoiceInput): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of choiceSightings(i)) out[`${s.choice}/${s.side}`] = (out[`${s.choice}/${s.side}`] ?? 0) + 1;
  return out;
}

test('a plan counts only where a person ruled on it, and an approval is the planner’s answer standing', () => {
  const proposals = [
    { kind: 'plan', status: 'accepted', decidedBy: 'human', decidedAt: AT },
    { kind: 'plan', status: 'rejected', decidedBy: 'human', decidedAt: AT },
    { kind: 'plan', status: 'pending', decidedBy: null, decidedAt: null },
    { kind: 'reply_draft', status: 'accepted', decidedBy: 'human', decidedAt: AT },
    { kind: 'plan', status: 'accepted', decidedBy: 'human', decidedAt: OLD },
  ] as never[];
  assert.deepEqual(tally(input({ proposals })), { 'plan/agent': 1, 'plan/person': 1 });
});

test('a check reading and a goal verdict are a person’s only when the operator wrote them', () => {
  const checks = [
    { state: 'passed', resultBy: 'operator', resultAt: AT },
    { state: 'failed', resultBy: 'agent', resultAt: AT },
    { state: 'passed', resultBy: 'script', resultAt: AT },
    { state: 'waived', resultBy: 'operator', resultAt: AT },
    { state: 'unrun', resultBy: null, resultAt: null },
  ] as never[];
  const conclusions = [{ by: 'operator', updatedAt: AT }] as never[];
  const deliveries = [{ by: 'assessor', updatedAt: AT }] as never[];
  const shortfalls = [{ by: 'operator', updatedAt: AT }] as never[];
  assert.deepEqual(tally(input({ checks, conclusions, deliveries, shortfalls })), {
    'validation-check/person': 1,
    'validation-check/agent': 2,
    'goal-verdict/person': 2,
    'goal-verdict/agent': 1,
  });
});

test('criteria are a person’s when written before the goal was first planned, and absent when the gate is off', () => {
  const plans = [
    { originRef: 'issue:1', createdAt: AT },
    { originRef: 'issue:2', createdAt: AT },
    { originRef: 'issue:3', createdAt: AT },
  ] as never[];
  const firstCriteria = [
    { originRef: 'issue:1', at: '2026-08-19T00:00:00.000Z' },
    { originRef: 'issue:2', at: '2026-08-21T00:00:00.000Z' },
  ];
  assert.deepEqual(tally(input({ plans, firstCriteria })), { 'goal-criteria/person': 1, 'goal-criteria/agent': 2 });
  assert.deepEqual(tally(input({ plans, firstCriteria, choicesOff: ['goal-criteria'] })), {});
});

test('watches, queries and story orders split on who wrote or answered them', () => {
  const watches = [
    { authored: 'operator', createdAt: AT },
    { authored: 'plan', createdAt: AT },
  ];
  const queries = [{ authored: 'agent', createdAt: AT }];
  const sequences = [
    { status: 'accepted', answeredAt: AT },
    { status: 'declined', answeredAt: AT },
    { status: 'proposed', answeredAt: null },
  ] as never[];
  assert.deepEqual(tally(input({ watches, queries, sequences })), {
    'watch-check/person': 1,
    'watch-check/agent': 1,
    'state-query/agent': 1,
    'story-order/agent': 1,
    'story-order/person': 1,
  });
});

test('the digest carries who wrote a description, survives the wire, and the pool rolls it up by key', () => {
  const store = new Store(':memory:', () => NOW);
  store.prDescriptions.appendDescription({ originRef: 'issue:7:part:a', text: 'first', author: null });
  store.prDescriptions.appendDescription({ originRef: 'issue:7:part:a', text: 'revised', author: null });
  store.prDescriptions.handOff({ originRef: 'issue:7:part:b', prNumber: 12, handedBy: null });
  store.prDescriptions.handOff({ originRef: 'issue:7:part:a', prNumber: 11, handedBy: null });

  const document = buildDigestDocument(store, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
    scope: { pullRequests: true, issues: true },
  });
  assert.deepEqual(document.byChoice, [
    { day: '2026-08-24', key: 'pr-description/agent', count: 1, costUsd: null, partial: true },
    { day: '2026-08-24', key: 'pr-description/person', count: 1, costUsd: null, partial: true },
  ]);
  assert.ok(document.byChoice.every((row) => isChoiceKey(row.key)));

  const parsed = parsePoolDocument(serialisePoolDocument(document));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.document.byChoice, document.byChoice);

  store.pool.replaceFleetDigest('alice@acme-api', 'acme-api', parsed.document);
  const rollup = foldPoolDigest(store.pool.listDigestRows(null), { project: null });
  assert.deepEqual(
    rollup.byChoice.map((r) => [r.key, r.label, r.count, r.fleets]),
    [
      ['pr-description/agent', choiceLabel('pr-description/agent'), 1, 1],
      ['pr-description/person', choiceLabel('pr-description/person'), 1, 1],
    ],
  );
});
