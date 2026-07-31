import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { AppState, Agent } from '../web/src/types.js';

/**
 * These derivations lived inside `App`'s render body until skins split the
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
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: 1_000_000,
    viewingPlan: null,
    viewingRetro: null,
    viewingScratchpad: null,
    settingsOpen: false,
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

test('flags and files group by agent, and an agent with none is absent', () => {
  const state = stateWith({
    agents: [AGENT({ id: 'a1' }), AGENT({ id: 'a2' })],
    flags: [
      { agentId: 'a1', ref: 'x' },
      { agentId: 'a1', ref: 'y' },
    ] as never,
    files: [{ agentId: 'a2', path: 'p' }] as never,
  });
  const view = build(state);
  assert.equal(view.flagsByAgent.get('a1')?.length, 2);
  assert.equal(view.flagsByAgent.get('a2'), undefined);
  assert.equal(view.filesByAgent.get('a2')?.length, 1);
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

test('only open escalations and findings count toward the nudges', () => {
  const view = build(
    stateWith({
      escalations: [
        { id: 'e1', status: 'open' },
        { id: 'e2', status: 'answered' },
      ] as never,
      findings: [{ status: 'open' }, { status: 'dismissed' }, { status: 'open' }] as never,
      overlaps: [{ live: true }, { live: false }] as never,
    }),
  );
  assert.equal(view.openEscalations.length, 1);
  assert.equal(view.openFindingCount, 2);
  assert.equal(view.liveOverlapCount, 1);
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
