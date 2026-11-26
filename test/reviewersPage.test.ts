import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, PrPerson } from '../web/src/types.js';
import type { NeedRow } from '../web/src/view/needsYou.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { buildFixtureState } = await import('./support/cockpitFixtures.js');
const { groupAsks } = await import('../web/src/view/askGroups.js');
const { reviewerAsks, reviewerGroups, standingNote } = await import('../web/src/view/reviewersPage.js');

// → docs/spec/17-cockpit.md#every-reviewer-ask-is-one-page

const sam = { id: 'u1', name: 'Sam' };
const kim = { id: 'u2', name: 'Kim' };

interface Spec {
  assignAsk?: PrPerson[];
  assignees?: PrPerson[];
  author?: string;
}

function state(prs: Record<number, Spec>, stacks: number[][] = []): AppState {
  const base = buildFixtureState();
  const pullRequests = Object.entries(prs).map(([n, spec]) => ({
    ...base.world.pullRequests[0]!,
    id: `pr-${n}`,
    number: Number(n),
    title: `PR ${n}`,
    branch: `b-${n}`,
    ...spec,
  }));
  return {
    ...base,
    world: { ...base.world, pullRequests },
    stacks: stacks.map((rungs) => ({
      ref: `stack:${rungs[0]}`,
      issueNumber: null,
      issueTitle: null,
      planId: null,
      rungs: rungs.map((n, i) => ({
        prNumber: n,
        title: `PR ${n}`,
        branch: `b-${n}`,
        base: '',
        position: i + 1,
        partSlug: null,
      })),
    })),
  };
}

function assignRow(pr: number, goalRef: string | null): NeedRow {
  return { id: `assign:pr:${pr}`, kind: 'assign', prNumber: pr, goalRef } as NeedRow;
}

const other = { id: 'e1', kind: 'escalation', goalRef: 'issue:1' } as NeedRow;

test('the rail folds every assign ask into one item, whatever its goal or shortlist', () => {
  const s = state({ 10: { assignAsk: [sam] }, 11: { assignAsk: [kim] }, 12: { assignAsk: [sam, kim] } });
  const items = groupAsks(
    [other, assignRow(10, 'issue:1'), assignRow(11, 'issue:2'), assignRow(12, null)],
    s,
    () => 'all',
  );
  assert.deepEqual(
    items.map((i) => i.kind),
    ['one', 'assign'],
  );
  assert.deepEqual(items[1]?.kind === 'assign' ? items[1].asks.map((a) => a.number) : [], [10, 11, 12]);
});

test('a lone assign ask stays its own row', () => {
  const s = state({ 10: { assignAsk: [sam] } });
  assert.deepEqual(
    groupAsks([assignRow(10, null), other], s, () => 'all').map((i) => i.kind),
    ['one', 'one'],
  );
});

test('the page groups asks by stack, in stack order, with the unstacked last', () => {
  const s = state(
    {
      20: { assignAsk: [sam] },
      21: { assignAsk: [sam] },
      22: { assignAsk: [kim] },
      30: { assignAsk: [kim] },
    },
    [[22, 20, 21]],
  );
  const asks = reviewerAsks(
    [30, 21, 20, 22].map((n) => assignRow(n, null)),
    s,
  );
  const groups = reviewerGroups(asks, s);
  assert.deepEqual(
    groups.map((g) => g.stack),
    ['stack:22', null],
  );
  assert.equal(groups[1]?.goal, null, 'the unstacked group gathers any goal, so its rungs carry their own');
  assert.deepEqual(
    groups[0]?.rungs.map((r) => [r.ask.number, r.depth]),
    [
      [22, 0],
      [20, 1],
      [21, 2],
    ],
  );
  assert.deepEqual(
    groups[0]?.people.map((p) => p.person.id),
    ['u2', 'u1'],
  );
});

test('a reviewer is drawn with their load and whether they know the stack', () => {
  const s = state(
    {
      40: { assignees: [kim], author: 'someone' },
      41: { assignAsk: [sam, kim] },
      50: { assignees: [kim] },
    },
    [[40, 41]],
  );
  const [group] = reviewerGroups(reviewerAsks([assignRow(41, null)], s), s);
  const people = group?.rungs[0]?.people ?? [];
  assert.deepEqual(people.map(standingNote), ['free', 'knows this stack · 2 open']);
  assert.equal(group?.people[0]?.person.id, 'u2');
});

test('the page draws each stack once, with a whole-stack answer and every pull request its own', async () => {
  const { ReviewersPage } = await import('../web/src/console/ReviewersPage.js');
  const s = state({ 60: { assignAsk: [sam] }, 61: { assignAsk: [sam] }, 70: { assignAsk: [kim] } }, [[60, 61]]);
  const needsYou = [60, 61, 70].map((n) => assignRow(n, null));
  const view = { state: s, needsYou, goalPage: null, now: Date.now() } as unknown as CockpitView;
  const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;
  const { RefLinks } = await import('../web/src/components/refs.js');
  const html = renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: s.refUrls,
      openGoal: () => undefined,
      hasGoal: () => true,
      openPr: () => undefined,
      hasPr: () => true,
      children: createElement(ReviewersPage, { view, actions }),
    }),
  );
  assert.ok(html.includes('3 pull requests need a reviewer'));
  assert.equal(html.match(/cn-rv-group/g)?.length, 2);
  assert.equal(html.match(/Whole stack/g)?.length, 1, 'only the stack offers the whole-stack answer');
  assert.equal(html.match(/cn-stack-tie/g)?.length, 1);
});

test('a stack whose bottom rungs are already reviewed draws its first ask at the root', () => {
  const s = state({ 80: {}, 81: { assignAsk: [sam] }, 82: { assignAsk: [sam] } }, [[80, 81, 82]]);
  const [group] = reviewerGroups(reviewerAsks([assignRow(81, null), assignRow(82, null)], s), s);
  assert.deepEqual(
    group?.rungs.map((r) => r.depth),
    [0, 1],
  );
});
