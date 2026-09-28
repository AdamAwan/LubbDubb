import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Escalation, Proposal } from '../web/src/types.js';
import type { NeedRow } from '../web/src/view/needsYou.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { groupAsks } = await import('../web/src/view/askGroups.js');
const { buildNeedsYou } = await import('../web/src/view/needsYou.js');
const { CheckSetAsk } = await import('../web/src/components/CheckSetAsk.js');

// → docs/spec/17-cockpit.md#the-same-ask-twice-is-one-ask

const sam = { id: 'u1', name: 'Sam' };
const kim = { id: 'u2', name: 'Kim' };

function stateWithShortlists(lists: Record<number, (typeof sam)[]>): AppState {
  const base = buildDemoState().state;
  const pullRequests = Object.keys(lists).map((n) => ({
    ...base.world.pullRequests[0]!,
    id: `pr-${n}`,
    number: Number(n),
    title: `PR ${n}`,
    assignAsk: lists[Number(n)],
  }));
  return { ...base, world: { ...base.world, pullRequests } };
}

function assignRow(pr: number, goalRef: string | null = 'issue:1'): NeedRow {
  return { id: `assign:pr:${pr}`, kind: 'assign', prNumber: pr, goalRef } as NeedRow;
}

const other = { id: 'e1', kind: 'escalation', goalRef: 'issue:1' } as NeedRow;

test('assign asks on one goal with one shortlist fold into one item, where the first stood', () => {
  const state = stateWithShortlists({ 10: [sam, kim], 11: [sam, kim], 12: [sam, kim] });
  const items = groupAsks([assignRow(10), other, assignRow(11), assignRow(12)], state);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, 'assign');
  assert.deepEqual(items[0]?.kind === 'assign' ? items[0].asks.map((a) => a.number) : [], [10, 11, 12]);
  assert.equal(items[1]?.kind, 'one');
});

test('a different shortlist or a different goal is a different question, and a lone ask stays a row', () => {
  const state = stateWithShortlists({ 10: [sam, kim], 11: [sam], 12: [sam, kim] });
  const items = groupAsks([assignRow(10), assignRow(11), assignRow(12, 'issue:2')], state);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['one', 'one', 'one'],
  );
});

// → docs/spec/17-cockpit.md#a-check-set-ask-is-named-by-its-checks

function check(letter: string, title: string): Record<string, unknown> {
  return { letter, title, expect: '', proof: '', steps: [] };
}

function checkSetState(set: Record<string, unknown>[]): AppState {
  const base = buildDemoState().state;
  const escalation: Escalation = {
    id: 'e-vp',
    type: 'approve_change',
    status: 'open',
    prompt: '2 check(s) written against the delivered code for issue #1 ("Title"), and nothing runs them.',
    context: {},
    agentId: null,
    taskId: null,
    response: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    answeredAt: null,
  };
  const proposal = {
    id: 'p-vp',
    escalationId: 'e-vp',
    kind: 'validation_plan',
    action: { type: 'propose_validation_plan', set },
  } as unknown as Proposal;
  return { ...base, escalations: [escalation], proposals: [proposal] };
}

function titleOf(state: AppState): string {
  return buildNeedsYou(state).find((r) => r.id === 'e-vp')?.title ?? '';
}

test('a check set ask leads with its first check, not with the count the prompt opens on', () => {
  const one = titleOf(checkSetState([check('A', 'Reports sync stops throwing')]));
  assert.match(one, /^OK check: Reports sync stops throwing/);
  const three = titleOf(checkSetState([check('A', 'First'), check('B', 'Second'), check('C', 'Third')]));
  assert.match(three, /^OK 3 checks: First \(\+2 more\)/);
  assert.doesNotMatch(three, /check\(s\) written/);
});

test('the check set card draws the checks before the planner’s note', () => {
  const html = renderToStaticMarkup(
    createElement(CheckSetAsk, {
      set: {
        note: 'The planner’s case.',
        hint: 'What the plan asked.',
        checks: [
          {
            letter: 'A',
            title: 'The one check',
            expect: '',
            proof: '',
            steps: [],
            fleetCandidate: false,
            candidateWhy: null,
            fleetBlocked: false,
            carriesQuery: false,
          },
        ],
      },
    }),
  );
  assert.ok(html.indexOf('The one check') < html.indexOf('The planner’s case.'));
  assert.match(html, /<details class="vp-hint">/);
});
