import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Escalation, HumanTask, OrphanedWork, PlanPart } from '../web/src/types.js';
import { buildNeedsYou, partHolding } from '../web/src/view/needsYou.js';
import type { NeedGroup, NeedKind, NeedRow } from '../web/src/view/needsYou.js';

// buildDemoState returns { state, transcripts }; this suite only needs the state.
const { buildDemoState: buildDemoSeed } = await import('../web/src/demo/fixtures.js');
const buildDemoState = () => buildDemoSeed().state;

function part(over: Partial<PlanPart>): PlanPart {
  return {
    id: 'p:a',
    planId: 'p',
    slug: 'a',
    seq: 1,
    title: 'A',
    scope: 'src/a.ts',
    rationale: null,
    acceptance: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
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
        // A pull request is not a goal, so there is no page to answer this on.
        escalation({ id: 'on-pr', agentId: 'a2', context: { originRef: 'pr:142' } }),
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
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    viewingScratchpad: null,
    settingsOpen: false,
    spendOpen: false,
    reliabilityOpen: false,
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
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    viewingScratchpad: null,
    settingsOpen: false,
    spendOpen: false,
    reliabilityOpen: false,
    selectedGoal: null,
    consolePanel: null,
    tab: 'overview',
  });

  assert.equal(view.goalPage, null);
});
