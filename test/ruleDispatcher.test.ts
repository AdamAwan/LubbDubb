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
    recentDecisions: [],
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

// --------------------------------------------------------------------------
// Conflict / behind (base-update) rule
// --------------------------------------------------------------------------

test('a dirty PR is dispatched to a code agent to resolve conflicts', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          baseBranch: 'main',
          ciStatus: 'passing',
          unresolvedComments: [],
          mergeable: false,
          mergeableState: 'dirty',
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { originRef: string }).originRef, 'pr:42:mergeable');
  assert.match((actions[0] as { prompt: string }).prompt, /resolve the conflicts/i);
});

test('a behind PR gets a clean base-update dispatch, not conflict framing', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          baseBranch: 'main',
          ciStatus: 'passing',
          unresolvedComments: [],
          mergeable: true,
          mergeableState: 'behind',
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { originRef: string }).originRef, 'pr:42:mergeable');
  assert.match((actions[0] as { prompt: string }).prompt, /up to date/i);
  assert.doesNotMatch((actions[0] as { prompt: string }).prompt, /resolve the conflicts/i);
});

test('a blocked PR is not auto-acted (surfaced only)', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          baseBranch: 'main',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          mergeableState: 'blocked',
        },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'no_op');
});

test('a behind but otherwise-ready PR is updated, not merged', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        {
          id: 'p',
          number: 42,
          title: 'X',
          branch: 'feat',
          baseBranch: 'main',
          ciStatus: 'passing',
          unresolvedComments: [],
          approved: true,
          mergeable: true,
          mergeableState: 'behind',
        },
      ],
    }),
  );
  assert.ok(!actions.some((a) => a.type === 'merge_pr'), 'behind PR must not merge yet');
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
});

test('a conflicted PR is dispatched ahead of a new issue under headroom 1', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          {
            id: 'p',
            number: 42,
            title: 'X',
            branch: 'feat',
            baseBranch: 'main',
            ciStatus: 'passing',
            unresolvedComments: [],
            mergeable: false,
            mergeableState: 'dirty',
          },
        ],
        issues: [{ id: 'i', number: 9, title: 'Bug', body: 'b', labels: [], state: 'open', linkedPrNumber: null }],
      },
      { agentHeadroom: 1 },
    ),
  );
  const dispatches = actions.filter((a) => a.type.startsWith('dispatch_'));
  assert.equal(dispatches.length, 1);
  assert.equal((dispatches[0] as { originRef: string }).originRef, 'pr:42:mergeable');
});

// --------------------------------------------------------------------------
// One code agent per PR branch: notify running, hold waiting, debounce
// --------------------------------------------------------------------------

const runningAgent = (id: string) => ({
  id,
  taskId: 't',
  status: 'running' as const,
  cwd: '/tmp',
  pid: 1,
  sessionId: null,
  waitingReason: null,
  startedAt: 'n',
  endedAt: null,
});
const branchTask = (branch: string, originRef: string, agentId: string) => ({
  id: 't1',
  kind: 'code' as const,
  title: 'x',
  prompt: 'x',
  branch,
  originRef,
  status: 'running' as const,
  agentId,
  createdAt: 'n',
  updatedAt: 'n',
});

test('a fresh concern on a running branch notifies the agent, not a second dispatch', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          {
            id: 'p',
            number: 42,
            title: 'X',
            branch: 'feat',
            baseBranch: 'main',
            ciStatus: 'failing',
            unresolvedComments: [],
            mergeable: false,
            mergeableState: 'dirty',
          },
        ],
      },
      {
        // agent is on the branch working the CI concern; the conflict is new.
        tasks: [branchTask('feat', 'pr:42:ci', 'ag1')],
        agents: [runningAgent('ag1')],
      },
    ),
  );
  assert.ok(!actions.some((a) => a.type.startsWith('dispatch_')), 'must not dispatch a second agent');
  const note = actions.find((a) => a.type === 'respond_to_agent');
  assert.ok(note, 'expected a respond_to_agent note');
  assert.equal((note as { agentId: string }).agentId, 'ag1');
  assert.deepEqual((note as { originRefs: string[] }).originRefs, ['pr:42:mergeable']);
  assert.match((note as { response: string }).response, /conflict/i);
});

test('a concern on a waiting branch is held (no note, no dispatch)', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          {
            id: 'p',
            number: 42,
            title: 'X',
            branch: 'feat',
            baseBranch: 'main',
            ciStatus: 'passing',
            unresolvedComments: [],
            mergeable: false,
            mergeableState: 'dirty',
          },
        ],
      },
      {
        tasks: [branchTask('feat', 'pr:42:ci', 'ag1')],
        agents: [{ ...runningAgent('ag1'), status: 'waiting', waitingReason: 'need input' }],
      },
    ),
  );
  assert.equal(actions[0]?.type, 'no_op', 'held: nothing injected while the agent is parked');
});

test('an already-notified concern is not re-notified', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          {
            id: 'p',
            number: 42,
            title: 'X',
            branch: 'feat',
            baseBranch: 'main',
            ciStatus: 'passing',
            unresolvedComments: [],
            mergeable: false,
            mergeableState: 'dirty',
          },
        ],
      },
      {
        tasks: [branchTask('feat', 'pr:42:ci', 'ag1')],
        agents: [runningAgent('ag1')],
        recentDecisions: [
          {
            id: 'd1',
            cycleId: 'c',
            outcome: 'executed',
            detail: '',
            createdAt: 'n',
            action: { type: 'respond_to_agent', reason: 'r', agentId: 'ag1', originRefs: ['pr:42:mergeable'] },
          },
        ],
      },
    ),
  );
  assert.equal(actions[0]?.type, 'no_op', 'already told this agent about pr:42:mergeable');
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
