import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Escalation, OpenPullRequest, Proposal } from '../web/src/types.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';
import { featureHolds, goalPullRequests } from '../web/src/view/featureHolds.js';

const { buildDemoState: buildDemoSeed } = await import('../web/src/demo/fixtures.js');
const buildDemoState = () => buildDemoSeed().state;

function stateWith(over: Partial<AppState>): AppState {
  const base = buildDemoState();
  const world = {
    ...base.world,
    issues: base.world.issues.map((i) => ({ ...i, appraisal: null })),
    pullRequests: base.world.pullRequests.filter((pr) => pr.attention.assignedToYou === undefined),
  };
  const build: AppState['build'] = {
    ...base.build,
    state: 'current',
    label: 'current',
    upgradable: false,
    blocked: 'this build is current — there is nothing to take',
    standing: { ...base.build.standing, behind: 0, commits: [], upstream: base.build.standing.head },
    project: base.build.project === null ? null : { ...base.build.project, behind: 0, commits: [] },
    projectPull: { can: false, blocked: 'the project checkout is up to date — there is nothing to pull' },
  };
  return { ...base, world, build, escalations: [], humanTasks: [], proposals: [], recovery: [], ...over };
}

function withAttention(state: AppState, number: number, attention: OpenPullRequest['attention']): AppState {
  return {
    ...state,
    world: {
      ...state.world,
      pullRequests: state.world.pullRequests.map((pr) => (pr.number === number ? { ...pr, attention } : pr)),
    },
  };
}

function escalation(over: Partial<Escalation>): Escalation {
  return {
    id: 'e1',
    type: 'answer_question',
    status: 'open',
    prompt: 'Which store?',
    context: {},
    agentId: null,
    taskId: null,
    response: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    answeredAt: null,
    ...over,
  };
}

function mergeProposal(prNumber: number, escalationId: string): Proposal {
  return {
    id: `prop-merge-${prNumber}`,
    kind: 'merge',
    ref: `pr:${prNumber}:merge`,
    status: 'pending',
    action: { type: 'merge_pr', reason: `PR #${prNumber} is merge-ready`, prNumber },
    note: null,
    decidedBy: null,
    decidedAt: null,
    escalationId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const holds = (state: AppState, goals: number[]) => featureHolds(state, buildNeedsYou(state), goals);

test('a rail row on one of the goals is a `you` hold carrying the row id', () => {
  const state = stateWith({
    escalations: [escalation({ id: 'q-1', agentId: 'agent-a1', context: { originRef: 'issue:388' } })],
  });
  const { you } = holds(state, [388]);
  const row = you.find((h) => h.needId === 'q-1');
  assert.ok(row, 'the escalation is a hold on #388');
  assert.equal(row.kind, 'escalation');
  assert.equal(row.goal, 388);
  assert.equal(row.ref, 'issue:388');
  assert.equal(row.agentId, 'agent-a1');
  assert.equal(row.since, '2026-01-01T00:00:00.000Z');
});

test('a merge rail row and its pull request’s `you` verdict are one hold — the row', () => {
  const merge = escalation({
    id: 'merge-412',
    type: 'approve_change',
    context: { originRef: 'pr:412', prNumber: 412 },
  });
  const verdict: OpenPullRequest['attention'] = { status: 'you', reasons: ['a merge is waiting on your verdict'] };

  const withRow = withAttention(
    stateWith({ escalations: [merge], proposals: [mergeProposal(412, 'merge-412')] }),
    412,
    verdict,
  );
  const deduped = holds(withRow, [388]).you.filter((h) => h.ref === 'pr:412');
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.kind, 'merge');
  assert.equal(deduped[0]?.needId, 'merge-412');

  const withoutRow = withAttention(stateWith({}), 412, verdict);
  const bare = holds(withoutRow, [388]).you;
  assert.deepEqual(
    bare.map((h) => [h.kind, h.ref, h.title, h.needId]),
    [['pr', 'pr:412', 'a merge is waiting on your verdict', null]],
  );
});

test('fleet-wide rail kinds are not a goal’s hold', () => {
  const state = stateWith({ recovery: [] });
  const all = holds(state, [388, 376, 345, 390]);
  const kinds = new Set([...all.you, ...all.fleet, ...all.world].map((h) => h.kind));
  for (const k of ['config', 'config_gap', 'recovery', 'burn', 'supply', 'dispatch', 'upgrade', 'project_pull']) {
    assert.equal(kinds.has(k), false, `${k} is never a Feature hold`);
  }
});

test('a held pickup is a fleet hold in the dispatcher’s words', () => {
  const state = stateWith({});
  const { fleet } = holds(state, [345, 390]);
  assert.deepEqual(
    fleet.filter((h) => h.kind === 'pickup').map((h) => [h.goal, h.title, h.ref]),
    [
      [345, 'on cooldown after 2 attempts', 'issue:345'],
      [390, '1/5 parts done', 'issue:390'],
    ],
  );
});

test('a pull request the harness is on is a fleet hold naming the agent', () => {
  const { fleet, you, world } = holds(stateWith({}), [388]);
  const pr = fleet.find((h) => h.ref === 'pr:412');
  assert.ok(pr, 'PR #412 is the harness’s');
  assert.equal(pr.title, 'an agent is working this branch');
  assert.equal(pr.agentId, 'agent-a1');
  assert.equal(pr.goal, 388);
  assert.equal(
    you.some((h) => h.ref === 'pr:412'),
    false,
  );
  assert.equal(
    world.some((h) => h.ref === 'pr:412'),
    false,
  );
});

test('an unwatched pull request and an unwatched pickup draw no hold at all', () => {
  const unwatched = withAttention(stateWith({}), 412, {
    status: 'unwatched',
    reasons: ['not tagged lubbdubb-watch — the harness is leaving it alone'],
  });
  const state: AppState = {
    ...unwatched,
    world: {
      ...unwatched.world,
      issues: unwatched.world.issues.map((i) =>
        i.number === 388 ? { ...i, pickup: { eligible: false, status: 'unwatched', reasons: ['no watch label'] } } : i,
      ),
    },
  };
  const { you, fleet, world } = holds(state, [388]);
  assert.deepEqual([...you, ...fleet, ...world], []);
});

test('settled and done pull requests draw no hold either', () => {
  for (const status of ['settled', 'done'] as const) {
    const state = withAttention(stateWith({}), 412, { status, reasons: ['nothing is owed'] });
    const { you, fleet, world } = holds(state, [388]);
    assert.equal(
      [...you, ...fleet, ...world].some((h) => h.ref === 'pr:412'),
      false,
      status,
    );
  }
});

test('a pull request waiting elsewhere or stalled is the world’s', () => {
  const elsewhere = withAttention(stateWith({}), 412, {
    status: 'elsewhere',
    reasons: ['waiting on review', 'CI green'],
    reviewWaitingSince: '2026-02-01T00:00:00.000Z',
  });
  const a = holds(elsewhere, [388]).world.find((h) => h.ref === 'pr:412');
  assert.deepEqual(
    [a?.kind, a?.title, a?.detail, a?.since],
    ['pr', 'waiting on review', 'CI green', '2026-02-01T00:00:00.000Z'],
  );

  const stalled = withAttention(stateWith({}), 412, { status: 'stalled', reasons: ['nobody is on it'] });
  assert.equal(holds(stalled, [388]).world.find((h) => h.ref === 'pr:412')?.title, 'nobody is on it');
});

test('a gate hold on the reach row is a world hold in the desk’s sentence', () => {
  const state = stateWith({});
  const expected = state.environmentReach.find((r) => r.goalRef === 'issue:376')?.gateHold;
  assert.ok(expected, 'the demo holds #376 on staging');
  const gate = holds(state, [376]).world.find((h) => h.kind === 'gate');
  assert.deepEqual([gate?.title, gate?.ref, gate?.goal, gate?.since], [expected, 'issue:376', 376, null]);
  assert.equal(
    holds(state, [388]).world.some((h) => h.kind === 'gate'),
    false,
  );
});

test('an agent parked on the usage limit is a fleet hold on the goal its task was for', () => {
  const state = stateWith({ parkedOnLimit: ['agent-a2'] });
  const { fleet, you } = holds(state, [376]);
  const limit = fleet.find((h) => h.kind === 'limit');
  assert.ok(limit, 'agent-a2 works pr:409, which #376 owns');
  assert.equal(limit.agentId, 'agent-a2');
  assert.equal(limit.goal, 376);
  assert.equal(limit.ref, 'pr:409');
  assert.equal(limit.needId, 'agent-a2');
  assert.equal(
    you.some((h) => h.kind === 'limit'),
    false,
    'the limit row is never the operator’s',
  );
  assert.equal(
    holds(state, [388]).fleet.some((h) => h.kind === 'limit'),
    false,
  );
});

test('rail rows lead in the rail’s order; the rest follow newest first', () => {
  const state = withAttention(
    stateWith({
      escalations: [
        escalation({
          id: 'older',
          agentId: 'agent-a1',
          context: { originRef: 'issue:388' },
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        escalation({
          id: 'newer',
          agentId: 'agent-a1',
          context: { originRef: 'issue:388' },
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
      ],
    }),
    412,
    { status: 'you', reasons: ['a merge is waiting on your verdict'], reviewWaitingSince: '2026-03-01T00:00:00.000Z' },
  );
  const needs = buildNeedsYou(state);
  const { you } = featureHolds(state, needs, [388]);
  const railOrder = needs.filter((n) => n.goalRef === 'issue:388').map((n) => n.id);
  assert.deepEqual(
    you.map((h) => h.needId ?? h.ref),
    [...railOrder, 'pr:412'],
  );
});

test('a waiting agent is holding, a running one working, each joined to its goal through its task', () => {
  const { agents } = holds(stateWith({}), [388, 376, 364]);
  assert.deepEqual(
    agents.map((a) => [a.agentId, a.state, a.goal, a.prNumber]),
    [
      ['agent-a1', 'working', 388, 412],
      ['agent-a2', 'holding', 376, 409],
    ],
    'agent-a0 has ended and is not present',
  );
  assert.equal(agents[0]?.note, 'Cutting the ranked list to the budget before the prompt is built, not after');
});

test('an agent with no note is named by its task title, and an agent on another goal is left out', () => {
  const base = stateWith({});
  const state: AppState = {
    ...base,
    agents: base.agents.map((a) => (a.id === 'agent-a1' ? { ...a, note: null } : a)),
  };
  const { agents } = holds(state, [388]);
  assert.deepEqual(
    agents.map((a) => [a.agentId, a.note]),
    [['agent-a1', 'Fix failing CI on PR #412']],
  );
});

test('goalPullRequests puts the stack bottom rung first, then the rest, then closed newest first', () => {
  const rows = goalPullRequests(stateWith({}), 390);
  assert.deepEqual(
    rows.map((r) => [r.pr.number, r.open, r.position, r.stackSize]),
    [
      [413, true, 1, 2],
      [414, true, 2, 2],
      [406, false, null, null],
      [388, false, null, null],
    ],
  );
});

test('goalPullRequests orders unstacked open pull requests newest first', () => {
  const base = stateWith({});
  const extra: OpenPullRequest = {
    ...(base.world.pullRequests.find((pr) => pr.number === 412) as OpenPullRequest),
    id: 'pr-499',
    number: 499,
    branch: 'issue/388/follow-up',
  };
  const state: AppState = { ...base, world: { ...base.world, pullRequests: [...base.world.pullRequests, extra] } };
  assert.deepEqual(
    goalPullRequests(state, 388).map((r) => [r.pr.number, r.open, r.position]),
    [
      [499, true, null],
      [412, true, null],
    ],
  );
});
