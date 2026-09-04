import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { AppState, Agent } from '../web/src/types.js';

/**
 * These derivations lived inside `App`'s render body until the view model split the
 * cockpit into layers, which is why none of them had a test: a pure function
 * trapped in a component is only reachable through a browser.
 */

const AGENT = (over: Partial<Agent>): Agent =>
  ({ id: 'a1', status: 'running', taskId: 't1', startedAt: '2026-01-01T00:00:00.000Z', ...over }) as Agent;

function stateWith(over: Partial<AppState>): AppState {
  return {
    config: { heartbeatIntervalMs: 60_000 },
    control: { cap: 4, paused: false },
    agents: [],
    parkedOnLimit: [],
    stallParks: [],
    tasks: [],
    escalations: [],
    decisions: [],
    errors: [],
    worldEvents: [],
    dispatchRules: [],
    jobs: [],
    world: { pullRequests: [], issues: [] },
    ...over,
  } as unknown as AppState;
}

function build(state: AppState, over: Partial<Parameters<typeof buildViewModel>[0]> = {}) {
  return buildViewModel({
    state,
    now: 1_000_000,
    connected: true,
    demo: false,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: 1_000_000,
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: null,
    consolePanel: null,
    tab: 'overview',
    ...over,
  });
}

test('live and past split on the agent statuses that mean a process exists', () => {
  const state = stateWith({
    agents: [
      AGENT({ id: 'starting', status: 'starting' }),
      AGENT({ id: 'running', status: 'running' }),
      AGENT({ id: 'waiting', status: 'waiting' }),
      AGENT({ id: 'done', status: 'done' }),
      AGENT({ id: 'crashed', status: 'crashed' }),
    ],
  });
  const view = build(state);
  assert.deepEqual(
    view.live.map((a) => a.id),
    ['starting', 'running', 'waiting'],
  );
  assert.deepEqual(
    view.past.map((a) => a.id),
    ['done', 'crashed'],
  );
});

// A `crashed` row is neither live nor terminal, and the cockpit's whole top-line
// story ("the pulse is held") hangs off its presence rather than off a flag.
test('outstanding recovery decisions hold the pulse', () => {
  assert.equal(build(stateWith({})).pulseHeld, false);
  const held = build(stateWith({ recovery: [{ agentId: 'a1' }] as never }));
  assert.equal(held.pulseHeld, true);
});

test('the heartbeat counts down within the interval and wraps', () => {
  const state = stateWith({ config: { heartbeatIntervalMs: 60_000 } as never });
  const fresh = build(state, { now: 1_000_000, lastPulseAt: 1_000_000 });
  assert.equal(fresh.nextPulseIn, 60);
  assert.equal(fresh.pulseProgress, 0);

  const halfway = build(state, { now: 1_030_000, lastPulseAt: 1_000_000 });
  assert.equal(halfway.nextPulseIn, 30);
  assert.equal(halfway.pulseProgress, 50);

  // A pulse that never lands must not produce a negative countdown — it wraps,
  // so the bar keeps sweeping and the reading stays honest rather than absurd.
  const overdue = build(state, { now: 1_150_000, lastPulseAt: 1_000_000 });
  assert.ok(overdue.nextPulseIn > 0 && overdue.nextPulseIn <= 60);
});

// Files are no longer folded here at all: they are `GET /api/agents/:id/files`,
// fetched by the drawer that draws them. Flags still ride the snapshot — they are
// a chip per agent, not a list per agent.
test('flags group by agent, and an agent with none is absent', () => {
  const state = stateWith({
    agents: [AGENT({ id: 'a1' }), AGENT({ id: 'a2' })],
    flags: [
      { agentId: 'a1', ref: 'x' },
      { agentId: 'a1', ref: 'y' },
    ] as never,
  });
  const view = build(state);
  assert.equal(view.flagsByAgent.get('a1')?.length, 2);
  assert.equal(view.flagsByAgent.get('a2'), undefined);
});

// The proposal is keyed by the escalation it hangs off, which is what lets a
// decision-bearing inbox item offer accept/reject instead of a text box.
test('proposals are keyed by their escalation', () => {
  const view = build(
    stateWith({
      proposals: [{ id: 'p1', escalationId: 'e1' }, { id: 'p2' }] as never,
    }),
  );
  assert.equal(view.proposalFor.get('e1')?.id, 'p1');
  assert.equal(view.proposalFor.get('e2'), undefined);
});

test('only open escalations and live overlaps count toward the nudges', () => {
  const view = build(
    stateWith({
      escalations: [
        { id: 'e1', status: 'open', context: {} },
        { id: 'e2', status: 'answered', context: {} },
      ] as never,
      overlaps: [{ live: true }, { live: false }] as never,
    }),
  );
  assert.equal(view.openEscalations.length, 1);
  assert.equal(view.liveOverlapCount, 1);
});

/**
 * The join behind #245: a bot on the floor draws its own question, and it must be
 * the *same* reading the alerts desk lists — both off `status === 'open'`, so an
 * answer settles one row and clears both surfaces on the next snapshot. Keyed off
 * `agentId` rather than off the agent's status, because parking is only a request:
 * an agent that carried on working still owes the answer.
 */
test('an open question joins to the agent that asked it', () => {
  const view = build(
    stateWith({
      agents: [AGENT({ id: 'a1', status: 'running' }), AGENT({ id: 'a2', status: 'waiting' })],
      escalations: [
        { id: 'e1', status: 'open', agentId: 'a1', context: {}, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'e2', status: 'answered', agentId: 'a2', context: {}, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'e3', status: 'open', agentId: null, context: {}, createdAt: '2026-01-01T00:00:00.000Z' },
      ] as never,
    }),
  );
  assert.equal(view.escalationByAgent.get('a1')?.id, 'e1', 'a resumed agent still owes its answer');
  assert.equal(view.escalationByAgent.get('a2'), undefined, 'an answered question clears the bot too');
  assert.equal(view.escalationByAgent.size, 1, 'an escalation nobody raised belongs to no bot');
  // The desk lists both open ones; only the join drops the agent-less row.
  assert.deepEqual(
    view.openEscalations.map((e) => e.id),
    ['e1', 'e3'],
  );
});

test('streamed output is exposed only for the open drawer', () => {
  const state = stateWith({ agents: [AGENT({ id: 'a1' }), AGENT({ id: 'a2' })] });
  const output = new Map([
    ['a1', 'one'],
    ['a2', 'two'],
  ]);
  assert.equal(build(state, { liveOutput: output }).selectedOutput, undefined);
  assert.equal(build(state, { selected: 'a1', liveOutput: output }).selectedOutput, 'one');
  assert.equal(build(state, { selected: 'a1', liveOutput: output }).selectedAgent?.id, 'a1');
});

// An agent row outlives its task in a few paths (a requeue rewrites it), so the
// join has to tolerate a miss rather than assume one.
test('taskFor tolerates an agent whose task is gone', () => {
  const state = stateWith({
    agents: [AGENT({ id: 'a1', taskId: 't1' }), AGENT({ id: 'a2', taskId: 'gone' })],
    tasks: [{ id: 't1' }] as never,
  });
  const view = build(state);
  assert.equal(view.taskFor(view.state.agents[0]!)?.id, 't1');
  assert.equal(view.taskFor(view.state.agents[1]!), null);
});

/**
 * A desktop claim is in flight and is **not** an agent: it is synthesised from
 * the claim on the check, so nothing that counts a live agent can reach it.
 *
 * The cap is the assertion worth having. A claim that ever landed in `live` would
 * take a slot from work, which is the one thing validation promises never to do —
 * and it would do so through the fleet cap, which is read in three places.
 */
test('a claimed check becomes a keyboard entry, and never a live agent', () => {
  const state = stateWith({
    agents: [AGENT({ id: 'a1' })],
    validationChecks: [
      {
        originRef: 'issue:12',
        id: 'csv-opens',
        letter: 'B',
        title: 'The export opens',
        claimedBy: 'desktop (studio)',
        claimedAt: '2026-01-01T00:00:00.000Z',
      },
      { originRef: 'issue:12', id: 'pdf-prints', letter: 'C', title: 'The PDF prints', claimedBy: null },
    ] as never,
  });
  const view = build(state);
  assert.deepEqual(
    view.deskRuns.map((d) => [d.originRef, d.checkId, d.letter, d.label]),
    [['issue:12', 'csv-opens', 'B', 'desktop (studio)']],
    'one entry per live claim, and nothing for a check nobody holds',
  );
  assert.deepEqual(
    view.live.map((a) => a.id),
    ['a1'],
    'the fleet is the dispatched agents alone — this is what the cap counts',
  );
});

/**
 * The pulse that dispatches a candidate writes it into `upcoming` as `dispatching`
 * and creates the task that staffs it, in that order — so for one interval the
 * queue names work that is already out. Both bands of the Fleet card read the
 * joined list, so the same issue cannot be drawn as an agent and as up next.
 */
test('up next drops the rows the fleet is already out on', () => {
  const state = stateWith({
    agents: [AGENT({ id: 'a1', taskId: 't1' }), AGENT({ id: 'a2', taskId: 't2', status: 'done' })],
    tasks: [
      { id: 't1', originRef: 'issue:36273' },
      { id: 't2', originRef: 'issue:36279' },
    ] as never,
    readying: [{ id: 'r1', originRef: 'issue:36274', step: 'worktree' }] as never,
    upcoming: {
      cycleId: 'c1',
      at: '2026-01-01T00:00:00.000Z',
      items: [
        { origin: 'issue:36273', rule: 'issue-appraisal', status: 'dispatching' },
        { origin: 'issue:36274', rule: 'issue-appraisal', status: 'dispatching' },
        { origin: 'issue:36275', rule: 'issue-appraisal', status: 'dispatching' },
        { origin: 'issue:36279', rule: 'issue-appraisal', status: 'waiting' },
      ],
    },
  } as never);
  const view = build(state);
  assert.deepEqual(
    view.upNext.map((i) => i.origin),
    ['issue:36275', 'issue:36279'],
    'a live agent and a readying action each staff their origin; an ended agent staffs nothing',
  );
  assert.equal(view.state.upcoming?.items.length, 4, 'the snapshot itself is untouched');
});

test('up next is the whole queue when nothing is staffed', () => {
  const state = stateWith({
    upcoming: {
      cycleId: 'c1',
      at: '2026-01-01T00:00:00.000Z',
      items: [{ origin: 'issue:1', rule: 'issue-appraisal', status: 'waiting' }],
    },
  } as never);
  assert.deepEqual(
    build(state).upNext.map((i) => i.origin),
    ['issue:1'],
  );
});
