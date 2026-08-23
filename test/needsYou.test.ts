import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Escalation, HumanTask, OrphanedWork, PlanPart, PlanPartView } from '../web/src/types.js';
import { buildNeedsYou, partHolding } from '../web/src/view/needsYou.js';
import type { NeedGroup, NeedKind, NeedRow } from '../web/src/view/needsYou.js';

// buildDemoState returns { state, transcripts }; this suite only needs the state.
const { buildDemoState: buildDemoSeed } = await import('../web/src/demo/fixtures.js');
const buildDemoState = () => buildDemoSeed().state;

function part(over: Partial<PlanPart>): PlanPartView {
  return {
    id: 'p:a',
    planId: 'p',
    slug: 'a',
    seq: 1,
    title: 'A',
    scope: 'src/a.ts',
    rationale: null,
    acceptance: null,
    touches: [],
    acceptanceMet: [],
    depth: 0,
    acceptanceCriteria: [],
    outsideScope: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
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

function task(over: Partial<HumanTask>): HumanTask {
  return {
    id: 't1',
    title: 'Provision creds',
    detail: null,
    originRef: 'issue:142',
    partId: null,
    kind: 'ask',
    agentId: null,
    taskId: null,
    status: 'open',
    resolution: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    dismissedAt: null,
    ...over,
  };
}

function orphan(over: Partial<OrphanedWork> = {}): OrphanedWork {
  return {
    taskId: 't9',
    agentId: null,
    title: 'Orphaned run',
    kind: 'code',
    originRef: null,
    branch: null,
    cwd: null,
    died: 'crashed',
    waitingReason: null,
    note: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    detectedAt: null,
    restorable: false,
    restoreBlocked: null,
    ...over,
  };
}

/** A snapshot with the four lists this suite varies replaced, and nothing cast. */
function stateWith(over: Partial<AppState>): AppState {
  return { ...buildDemoState(), ...over };
}

test('partHolding counts live direct dependents and ignores retired ones', () => {
  const parts = [
    part({ id: 'p:a', slug: 'a' }),
    part({ id: 'p:b', slug: 'b', dependsOn: ['a'] }),
    part({ id: 'p:c', slug: 'c', dependsOn: ['a'], status: 'retired' }),
    part({ id: 'q:d', planId: 'q', slug: 'd', dependsOn: ['a'] }),
  ];
  assert.equal(partHolding('p', 'a', parts), 1);
});

test('a parked agent and a bench task land in different groups', () => {
  const rows: NeedRow[] = buildNeedsYou(
    stateWith({
      escalations: [escalation({ id: 'e1', agentId: 'a1' })],
      humanTasks: [task({ id: 't1' })],
      proposals: [],
      recovery: [],
    }),
  );
  const kindsAndGroups: Array<[NeedKind, NeedGroup]> = rows.map((r) => [r.kind, r.group]);

  assert.deepEqual(kindsAndGroups, [
    ['escalation', 'blocking'],
    ['bench', 'yours'],
  ]);
});

test('recovery sorts above everything, because no pulse runs while it is up', () => {
  const rows = buildNeedsYou(
    stateWith({
      escalations: [escalation({ id: 'e1', agentId: 'a1' })],
      humanTasks: [],
      proposals: [],
      recovery: [orphan()],
    }),
  );

  assert.equal(rows[0]?.kind, 'recovery');
  assert.equal(rows[0]?.goalRef, null);
});

test('an ask opens its goal when that goal has a page, and the ask panel when it does not', () => {
  const state = buildDemoState();
  const known = state.world.issues[0];
  assert.ok(known, 'the demo fixtures must carry an issue');

  const rows = buildNeedsYou(
    stateWith({
      ...state,
      escalations: [
        escalation({ id: 'on-goal', agentId: 'a1', context: { originRef: `issue:${known.number}` } }),
        // A pull request no ticket owns: nothing in the world links #9999, so
        // there is no page to answer this on.
        escalation({ id: 'on-pr', agentId: 'a2', context: { originRef: 'pr:9999' } }),
        // A goal-shaped ref the world does not carry: `buildGoalPage` returns
        // null for it, so routing on the ref alone opens an empty surface.
        escalation({ id: 'on-ghost', agentId: 'a3', context: { originRef: 'issue:99999' } }),
      ],
      humanTasks: [],
      proposals: [],
      recovery: [],
      tasks: [],
    }),
  );
  const opens = new Map(rows.map((r) => [r.id, r.opens]));

  assert.equal(opens.get('on-goal'), 'goal');
  assert.equal(opens.get('on-pr'), 'ask');
  assert.equal(opens.get('on-ghost'), 'ask');
  // The ghost keeps saying which goal it names — only where it *goes* changes.
  assert.equal(rows.find((r) => r.id === 'on-ghost')?.goalRef, 'issue:99999');
  // And an orphan PR keeps saying what it *is* about, which is all the ask panel
  // has to name it by.
  assert.equal(rows.find((r) => r.id === 'on-pr')?.originRef, 'pr:9999');
});

/**
 * Most asks the harness raises come from a pull request, and most pull requests
 * belong to a goal — through a part's row, the tracker's own link, or the branch
 * convention. Reading only the literal `issue:` prefix sent every one of those to
 * a panel with no context around it while the goal sat one lookup away.
 */
test('an ask raised on a pull request opens the goal that pull request belongs to', () => {
  const state = buildDemoState();
  const linked = state.world.issues.find((i) => i.linkedPrNumber !== null);
  assert.ok(linked?.linkedPrNumber, 'the demo fixtures must carry an issue with a linked pull request');

  const rows = buildNeedsYou(
    stateWith({
      ...state,
      escalations: [escalation({ id: 'on-pr', agentId: 'a1', context: { originRef: `pr:${linked.linkedPrNumber}` } })],
      humanTasks: [],
      proposals: [],
      recovery: [],
      tasks: [],
    }),
  );

  const row = rows.find((r) => r.id === 'on-pr');
  assert.equal(row?.goalRef, `issue:${linked.number}`, 'the ask is read on the goal its pull request delivers');
  assert.equal(row?.opens, 'goal');
  // The subject it was raised on survives the resolution: the goal is where it is
  // *read*, the PR is what it is *about*.
  assert.equal(row?.originRef, `pr:${linked.linkedPrNumber}`);
});

test('a permission request is its own kind, not a plain escalation', () => {
  const rows = buildNeedsYou(
    stateWith({
      escalations: [
        escalation({
          id: 'e1',
          agentId: 'a1',
          context: { permission: { toolName: 'Bash', summary: 'rm -rf build' } },
        }),
      ],
      humanTasks: [],
      proposals: [],
      recovery: [],
    }),
  );

  assert.equal(rows[0]?.kind, 'permission');
});

test('within a group the row holding more work sorts first', () => {
  const parts = [
    part({ id: 'p:a', slug: 'a' }),
    part({ id: 'p:b', slug: 'b', dependsOn: ['a'] }),
    part({ id: 'p:c', slug: 'c', dependsOn: ['a'] }),
    part({ id: 'p:z', slug: 'z' }),
  ];
  const rows = buildNeedsYou(
    stateWith({
      planParts: parts,
      escalations: [],
      proposals: [],
      recovery: [],
      humanTasks: [
        task({ id: 'holds-none', partId: 'p:z', title: 'Holds nothing' }),
        task({ id: 'holds-two', partId: 'p:a', title: 'Holds two' }),
      ],
    }),
  );

  assert.deepEqual(
    rows.map((r) => r.id),
    ['holds-two', 'holds-none'],
  );
  assert.equal(rows[0]?.holding, 2);
  assert.equal(rows[1]?.holding, 0);
});

test('the view model exposes the queue and the selected goal together', async () => {
  const { buildViewModel } = await import('../web/src/view/viewModel.js');
  const state = buildDemoState();
  const ref = `issue:${state.world.issues[0]!.number}`;

  const view = buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: ref,
    consolePanel: null,
    tab: 'overview',
  });

  assert.equal(view.selectedGoal, ref);
  assert.equal(view.goalPage?.issue.number, state.world.issues[0]!.number);
  assert.deepEqual(view.needsYou, view.goalPage ? view.needsYou : []);
  assert.ok(Array.isArray(view.needsYou));
});

test('no selected goal means no goal page', async () => {
  const { buildViewModel } = await import('../web/src/view/viewModel.js');
  const state = buildDemoState();

  const view = buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: null,
    consolePanel: null,
    tab: 'overview',
  });

  assert.equal(view.goalPage, null);
});

/**
 * The goal-profile gate (#342) holds every dispatch for its goal and expires on
 * nothing but the answer, so a queue that does not carry it is how a goal stops
 * for good with nobody told. It was drawn on the goal's own page and nowhere
 * else, which is the page nobody opens for a goal that looks like it merely has
 * not come up yet.
 */
test('an unanswered profile proposal is a row, and an answered one is not', () => {
  const base = buildDemoState();
  const goal = base.world.issues[0]!;
  const proposed = (over: { awaiting: boolean }) =>
    stateWith({
      escalations: [],
      humanTasks: [],
      proposals: [],
      recovery: [],
      world: {
        ...base.world,
        issues: base.world.issues.map((i) =>
          i.number === goal.number
            ? {
                ...i,
                assay: {
                  verdict: 'workable' as const,
                  summary: 'Three subsystems and an auth guard between them.',
                  by: 'assayer' as const,
                  decidedAt: '2026-01-01T00:00:00.000Z',
                  commentRef: null,
                  proposedProfile: 'deep',
                  awaitingProfileAnswer: over.awaiting,
                },
              }
            : i,
        ),
      },
    });

  const rows = buildNeedsYou(proposed({ awaiting: true }));
  // `yours`, not `blocking`: the colour rule is about a held slot, and no agent
  // is parked on this one — the goal simply cannot start.
  assert.deepEqual(
    rows.map((r) => [r.kind, r.group, r.goalRef]),
    [['profile', 'yours', `issue:${goal.number}`]],
  );
  assert.equal(rows[0]?.opens, 'goal');
  assert.equal(rows[0]?.holding, 0, 'the gate stops the goal before there is a plan to hold parts');
  assert.equal(rows[0]?.agentId, null, 'the assayer that proposed it is gone, not parked');
  assert.ok(rows[0]?.title.includes('deep'), 'the row names the profile it is asking about');

  assert.deepEqual(buildNeedsYou(proposed({ awaiting: false })), [], 'a settled proposal asks nothing');
});

/** A demo agent that has a task on the snapshot, with that task beside it. */
function agentWithTask(state: AppState) {
  for (const agent of state.agents) {
    const t = state.tasks.find((x) => x.id === agent.taskId);
    if (t) return { agent, task: t };
  }
  throw new Error('the demo carries no agent with a task — this suite needs one');
}

test('a parked agent’s row says what that run is on, and never its id', () => {
  const demo = buildDemoState();
  const { agent, task: onIt } = agentWithTask(demo);
  const rows = buildNeedsYou({
    ...demo,
    escalations: [escalation({ id: 'e1', agentId: agent.id })],
    humanTasks: [],
    proposals: [],
    recovery: [],
    parkedOnLimit: [],
  });

  assert.equal(rows[0]?.agentId, agent.id, 'the id stays on the row — it is what opens the drawer');
  assert.equal(rows[0]?.agentLabel, onIt.title, 'and the label is the work, which is what a surface draws');
  assert.notEqual(rows[0]?.agentLabel, agent.id);
});

test('a usage-limit park is named by the work it stopped', () => {
  const demo = buildDemoState();
  const { agent, task: onIt } = agentWithTask(demo);
  const rows = buildNeedsYou({
    ...demo,
    escalations: [],
    humanTasks: [],
    proposals: [],
    recovery: [],
    parkedOnLimit: [agent.id],
  });

  const park = rows.find((r) => r.kind === 'limit');
  assert.equal(park?.agentLabel, onIt.title);
});

test('a title over more than one line is clamped to its first', () => {
  const demo = buildDemoState();
  const { agent, task: onIt } = agentWithTask(demo);
  const rows = buildNeedsYou({
    ...demo,
    tasks: demo.tasks.map((t) => (t.id === onIt.id ? { ...t, title: `${onIt.title}\nand a second paragraph` } : t)),
    escalations: [escalation({ id: 'e1', agentId: agent.id })],
    humanTasks: [],
    proposals: [],
    recovery: [],
    parkedOnLimit: [],
  });

  assert.equal(rows[0]?.agentLabel, onIt.title, 'a queue row is one line, and a title is free text');
});

test('an agent the snapshot no longer carries resolves to no label, not to its id', () => {
  const demo = buildDemoState();
  const rows = buildNeedsYou({
    ...demo,
    escalations: [escalation({ id: 'e1', agentId: 'agent_gone01234' })],
    humanTasks: [],
    proposals: [],
    recovery: [],
    parkedOnLimit: [],
  });

  assert.equal(rows[0]?.agentId, 'agent_gone01234');
  assert.equal(rows[0]?.agentLabel, null, 'null is what the rail words for itself — it never prints the id');
});

test('a burn notice names the spending run; every other human task carries neither id nor label', () => {
  const demo = buildDemoState();
  const { agent, task: onIt } = agentWithTask(demo);
  const rows = buildNeedsYou({
    ...demo,
    escalations: [],
    proposals: [],
    recovery: [],
    parkedOnLimit: [],
    humanTasks: [
      task({ id: 'burn1', kind: 'burn', agentId: agent.id, title: 'This run has spent $40' }),
      task({ id: 'ask1', kind: 'ask', agentId: agent.id }),
    ],
  });

  assert.equal(rows.find((r) => r.id === 'burn1')?.agentLabel, onIt.title);
  assert.equal(
    rows.find((r) => r.id === 'ask1')?.agentLabel,
    null,
    'the agent that merely asked is not what the row is about',
  );
});
