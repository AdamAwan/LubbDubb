import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';

function ctx(world: Partial<WorldSnapshot>, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], stories: [], calendar: [], ...world },
    tasks: [],
    agents: [],
    openEscalations: [],
    steeringPriorities: [],
    agentHeadroom: 3,
    ...over,
  };
}

test('failing CI produces a code agent dispatch', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [{ id: 'p', number: 42, title: 'X', branch: 'feat', ciStatus: 'failing', unresolvedComments: [] }],
    }),
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { branch: string }).branch, 'feat');
  assert.equal((actions[0] as { originRef: string }).originRef, 'pr:42:ci');
});

test('unhandled PR comment produces a code agent dispatch', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 7,
          title: 'X',
          branch: 'feat',
          ciStatus: 'passing',
          unresolvedComments: [{ id: 'c1', author: 'bob', body: 'rename this', handled: false }],
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { originRef: string }).originRef, 'pr:7:comment:c1');
});

test('a handled comment is ignored', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 7,
          title: 'X',
          branch: 'feat',
          ciStatus: 'passing',
          unresolvedComments: [{ id: 'c1', author: 'bob', body: 'rename this', handled: true }],
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'no_op');
});

test('an open issue with no linked PR is dispatched to a code agent', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      issues: [
        {
          id: 'i1',
          number: 101,
          title: 'Login broken',
          body: 'steps',
          labels: ['bug'],
          state: 'open',
          linkedPrNumber: null,
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { branch: string }).branch, 'issue/101');
  assert.equal((actions[0] as { originRef: string }).originRef, 'issue:101');
});

test('with a pickup label set, only issues carrying it are dispatched', async () => {
  const d = new RuleDispatcher({ pickupLabel: 'agent-ready' });
  const { actions } = await d.decide(
    ctx({
      issues: [
        {
          id: 'i1',
          number: 101,
          title: 'tagged',
          body: '',
          labels: ['agent-ready'],
          state: 'open',
          linkedPrNumber: null,
        },
        { id: 'i2', number: 102, title: 'untagged', body: '', labels: ['bug'], state: 'open', linkedPrNumber: null },
      ],
    }),
  );
  const dispatched = actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1, 'only the labelled issue is dispatched');
  assert.equal((dispatched[0] as { originRef: string }).originRef, 'issue:101');
});

test('with no pickup label configured, all open issues stay eligible (no regression)', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      issues: [
        { id: 'i1', number: 101, title: 'A', body: '', labels: [], state: 'open', linkedPrNumber: null },
        { id: 'i2', number: 102, title: 'B', body: '', labels: ['bug'], state: 'open', linkedPrNumber: null },
      ],
    }),
  );
  const dispatched = actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 2, 'both issues eligible when no gate is set');
});

test('higher-priority issues win limited headroom; equal priority breaks by issue number', async () => {
  const d = new RuleDispatcher({
    priorityLabels: { 'priority:high': 3, 'priority:low': 1 },
    defaultPriority: 2,
  });
  const { actions } = await d.decide(
    ctx(
      {
        issues: [
          {
            id: 'i1',
            number: 101,
            title: 'low',
            body: '',
            labels: ['priority:low'],
            state: 'open',
            linkedPrNumber: null,
          },
          {
            id: 'i2',
            number: 102,
            title: 'high',
            body: '',
            labels: ['priority:high'],
            state: 'open',
            linkedPrNumber: null,
          },
          { id: 'i3', number: 103, title: 'default', body: '', labels: [], state: 'open', linkedPrNumber: null },
        ],
      },
      { agentHeadroom: 1 },
    ),
  );
  const dispatched = actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1, 'headroom of 1 dispatches one issue');
  assert.equal((dispatched[0] as { originRef: string }).originRef, 'issue:102', 'the priority:high issue goes first');
});

test('among equal-priority issues the lowest issue number is dispatched first', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        issues: [
          { id: 'i1', number: 205, title: 'later', body: '', labels: [], state: 'open', linkedPrNumber: null },
          { id: 'i2', number: 101, title: 'earlier', body: '', labels: [], state: 'open', linkedPrNumber: null },
        ],
      },
      { agentHeadroom: 1 },
    ),
  );
  const dispatched = actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal((dispatched[0] as { originRef: string }).originRef, 'issue:101');
});

test('an issue already linked to a PR is not re-dispatched', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      issues: [{ id: 'i1', number: 101, title: 'X', body: '', labels: [], state: 'open', linkedPrNumber: 43 }],
    }),
  );
  assert.equal(actions[0]?.type, 'no_op');
});

test('a closed issue is not dispatched', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      issues: [{ id: 'i1', number: 101, title: 'X', body: '', labels: [], state: 'closed', linkedPrNumber: null }],
    }),
  );
  assert.equal(actions[0]?.type, 'no_op');
});

test('a green, approved, mergeable PR yields a merge_pr action', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          merged: false,
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'merge_pr');
  assert.equal((actions[0] as { prNumber: number }).prNumber, 42);
});

test('an already-merged PR is left alone', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          merged: true,
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'no_op');
});

test('a merge-ready PR with an unhandled comment is addressed before merging', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          ciStatus: 'passing',
          unresolvedComments: [{ id: 'c1', author: 'bob', body: 'nit', handled: false }],
          approved: true,
          mergeable: true,
          merged: false,
        },
      ],
    }),
  );
  assert.ok(!actions.some((a) => a.type === 'merge_pr'), 'should not merge with an open comment');
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
});

test('story missing description is groomed by a desk agent', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      stories: [
        {
          id: 's1',
          title: 'Login',
          description: null,
          acceptanceCriteria: null,
          wafPillars: ['x'],
          state: 'ready',
          priority: 1,
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_desk_agent');
  assert.equal((actions[0] as { originRef: string }).originRef, 'story:s1:groom');
});

test('idle capacity picks up the highest-priority ready story', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      stories: [
        {
          id: 'lo',
          title: 'Low',
          description: 'd',
          acceptanceCriteria: 'ac',
          wafPillars: ['x'],
          state: 'ready',
          priority: 1,
        },
        {
          id: 'hi',
          title: 'High',
          description: 'd',
          acceptanceCriteria: 'ac',
          wafPillars: ['x'],
          state: 'ready',
          priority: 9,
        },
      ],
    }),
  );
  const work = actions.find((a) => (a as { originRef?: string }).originRef?.endsWith(':work'));
  assert.ok(work, 'expected a work dispatch');
  assert.equal((work as { branch: string }).branch, 'story/hi');
});

test('respects concurrency headroom', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          { id: 'a', number: 1, title: 'A', branch: 'a', ciStatus: 'failing', unresolvedComments: [] },
          { id: 'b', number: 2, title: 'B', branch: 'b', ciStatus: 'failing', unresolvedComments: [] },
        ],
      },
      { agentHeadroom: 1 },
    ),
  );
  const dispatches = actions.filter((a) => a.type.startsWith('dispatch_'));
  assert.equal(dispatches.length, 1);
});

test('does not duplicate work already in flight for the same origin', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      { pullRequests: [{ id: 'a', number: 1, title: 'A', branch: 'a', ciStatus: 'failing', unresolvedComments: [] }] },
      {
        tasks: [
          {
            id: 't1',
            kind: 'code',
            title: 'x',
            prompt: 'x',
            branch: 'a',
            originRef: 'pr:1:ci',
            status: 'running',
            agentId: 'ag1',
            createdAt: 'n',
            updatedAt: 'n',
          },
        ],
      },
    ),
  );
  assert.equal(actions[0]?.type, 'no_op');
});
