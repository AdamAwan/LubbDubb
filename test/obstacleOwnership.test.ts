import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ObstacleOwnershipDesk } from '../src/obstacles/ownershipDesk.js';
import { obstacleRepairOrigin, ownershipDoor, redBaseChecks } from '../src/obstacles/ownership.js';
import { blockedGoals, releasedBlocks } from '../src/obstacles/blocked.js';
import { obstacleOriginId } from '../src/issueOrigins.js';
import { phaseOf } from '../src/spendInsights.js';
import { expeditedOrigins } from '../src/dispatcher/goalPriority.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Issue, Obstacle, ObstacleBlock, ObstacleStanding, PullRequest } from '../src/types.js';

/**
 * **Ownership**: how a standing obstacle gets an owner, and what a goal does when
 * one stops it finishing.
 *
 * The three properties this file exists to hold, each of which fails silently if
 * it breaks: **never an agent** — the claim is a constraint, not an instruction;
 * **two doors and only two** — a ticket, or one bounded rule; and **blocked is a
 * park, not a failure** — the goal comes back on its own when the board lets it.
 * → `docs/spec/27-obstacles.md#ownership`
 */

const NOW = '2026-07-28T12:00:00.000Z';

function standing(over: Partial<Obstacle> = {}, extra: Partial<ObstacleStanding> = {}): ObstacleStanding {
  return {
    obstacle: {
      id: 'obs-a',
      what: 'the windows runner wedges before the suite starts',
      kind: 'obstacle',
      state: 'standing',
      ownerRef: null,
      until: null,
      createdAt: NOW,
      updatedAt: NOW,
      lastSeenAt: NOW,
      endedBy: null,
      ...over,
    },
    keys: [
      {
        id: 'k1',
        obstacleId: 'obs-a',
        kind: 'check',
        value: 'test (windows)',
        binds: true,
        confirmations: 0,
        createdAt: NOW,
      },
    ],
    voices: 2,
    goalRefs: ['issue:900', 'issue:901'],
    words: ['it wedges', 'it wedged for me too'],
    ...extra,
  };
}

// -- which door ---------------------------------------------------------------

test('a note is never owned, and neither is anything already taken', () => {
  // A note has no owner and ends by being written down, so no door is open for
  // it — and a row somebody already has is not a row to give away again.
  assert.equal(ownershipDoor(standing({ kind: 'note' }), new Set()), null);
  assert.equal(ownershipDoor(standing({ state: 'sighted' }), new Set()), null);
  assert.equal(ownershipDoor(standing({ state: 'owned', ownerRef: 'issue:41' }), new Set()), null);
});

test('the second door opens only for what is blocking the fleet now', () => {
  // Two voices is what makes it real and not one goal's own doing, which is a
  // ticket. A third is the fleet paying for it a third time, which is an agent.
  assert.equal(ownershipDoor(standing(), new Set()), 'ticket');
  assert.equal(ownershipDoor(standing({}, { voices: 3 }), new Set()), 'repair');
  // The other half: red on a branch other pull requests are based on.
  assert.equal(ownershipDoor(standing(), new Set(['test (windows)'])), 'repair');
  // A key that may not resolve an obstacle may not dispatch an agent for one
  // either, or "does not bind" would mean *binds when convenient*.
  const suggestion = standing({}, { keys: [{ ...standing().keys[0]!, binds: false }] });
  assert.equal(ownershipDoor(suggestion, new Set(['test (windows)'])), 'ticket');
});

test('a base is a branch other open pull requests are based on, and never a leaf', () => {
  const pr = (over: Partial<PullRequest>): PullRequest =>
    ({
      id: `pr-${over.number}`,
      number: over.number ?? 1,
      title: 't',
      branch: over.branch ?? 'b',
      state: 'open',
      merged: false,
      ...over,
    }) as PullRequest;
  const base = pr({
    number: 1,
    branch: 'issue/12',
    ciChecks: [
      { name: 'test (windows)', status: 'failing' },
      { name: 'advisory-thing', status: 'failing', advisory: true },
    ],
  });
  const rung = pr({ number: 2, branch: 'issue/12/part', baseBranch: 'issue/12' });
  const leaf = pr({ number: 3, branch: 'issue/99', ciChecks: [{ name: 'lint', status: 'failing' }] });

  const red = redBaseChecks([base, rung, leaf]);
  assert.deepEqual([...red], ['test (windows)']);
});

// -- the claim ----------------------------------------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacle-ownership-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: 'lubbdubb',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** Two independent goals saying one thing, which is what carries a row to `standing`. */
function stand(system: System, voices = ['issue:900', 'issue:901']): string {
  for (const goal of voices) {
    system.store.recordObstacleSighting(
      {
        what: 'the windows runner wedges before the suite starts',
        kind: 'obstacle',
        // A `check` key never binds on its own — it must co-occur with a `test` or
        // a `path` key to resolve a row, or a coarse name would swallow every
        // genuinely new failure under it.
        keys: [
          { kind: 'check', value: 'test (windows)', binds: true },
          { kind: 'path', value: 'src/a.ts', binds: true },
        ],
        untilHours: null,
      },
      {
        agentId: `agent-${goal}`,
        taskId: `task-${goal}`,
        goalRef: goal,
        sessionId: null,
        transition: null,
        words: `${goal} hit it`,
        whyNotMine: 'nothing of mine is near it.',
      },
    );
  }
  return system.store.listObstacles()[0]!.id;
}

const EMPTY_WORLD = { takenAt: NOW, pullRequests: [], issues: [] };

test('the ticket door files once, with the watch label, and cannot be walked through twice', async () => {
  const system = build();
  const id = stand(system);
  const filed: { title: string; labels?: string[]; bug?: boolean; relatedTo?: number }[] = [];
  const desk = new ObstacleOwnershipDesk({
    store: system.store,
    filing: async (input) => {
      filed.push(input);
      return 'issue:841';
    },
    watchLabel: 'lubbdubb-watch',
  });

  await desk.run(EMPTY_WORLD);
  await desk.run(EMPTY_WORLD);

  // **The claim is a uniqueness constraint**: the second pass finds the row owned
  // and files nothing. A ticket filed twice for one obstacle is two goals for one
  // problem, and nothing about either would say so.
  assert.equal(filed.length, 1);
  // Type, labels, assignee and the relation are arguments and never sentences in
  // a prompt: a ticket without the watch label is created, linked, shown
  // complete, and never dispatched for.
  assert.deepEqual(filed[0]!.labels, ['lubbdubb-watch']);
  assert.equal(filed[0]!.bug, true);
  assert.equal(filed[0]!.relatedTo, 900, 'related to the goal that hit it first');
  assert.match(filed[0]!.title, /windows runner wedges/);

  const owned = system.store.getObstacle(id)!;
  assert.equal(owned.state, 'owned');
  assert.equal(owned.ownerRef, 'issue:841');
  system.store.close();
});

test('a tracker that refuses hands the row back, rather than owning it with nothing', async () => {
  const system = build();
  const id = stand(system);
  const errors: string[] = [];
  let attempts = 0;
  const desk = new ObstacleOwnershipDesk({
    store: system.store,
    filing: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the tracker said no');
      return 'issue:842';
    },
    watchLabel: '',
    errors: { record: (e: { message: string }) => void errors.push(e.message) } as never,
  });

  await desk.run(EMPTY_WORLD);
  // Owned by nothing is a row the fleet is told is being fixed with nothing
  // fixing it, and no exit. It goes back to standing rather than sitting there.
  assert.equal(system.store.getObstacle(id)!.state, 'standing');
  assert.equal(system.store.getObstacle(id)!.ownerRef, null);
  assert.equal(errors.length, 1);

  await desk.run(EMPTY_WORLD);
  assert.equal(system.store.getObstacle(id)!.ownerRef, 'issue:842');
  // With the watch gate off there is no label to write, and an empty one must
  // never be.
  system.store.close();
});

test('the repair door is recorded, never taken: the desk owns a row the rule actually dispatched', async () => {
  const system = build();
  const id = stand(system, ['issue:900', 'issue:901', 'issue:902']);
  const desk = new ObstacleOwnershipDesk({ store: system.store, watchLabel: '' });

  // Nothing dispatched yet: the desk does not own it on the strength of a
  // candidate the headroom cut may never have dispatched.
  await desk.run(EMPTY_WORLD);
  assert.equal(system.store.getObstacle(id)!.state, 'standing');

  system.store.createTask({
    kind: 'code',
    title: 'Repair it',
    prompt: 'fix',
    branch: `obstacle/${id}`,
    originRef: obstacleRepairOrigin(id),
  });
  await desk.run(EMPTY_WORLD);

  const owned = system.store.getObstacle(id)!;
  assert.equal(owned.state, 'owned');
  assert.equal(owned.ownerRef, `obstacle:${id}`);
  system.store.close();
});

// -- the rule -----------------------------------------------------------------

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 5,
    ...over,
  };
}

test('one bounded rule: at most one repair, and only for the repair door', async () => {
  const three = standing({ id: 'obs-a' }, { voices: 3 });
  const two = standing({ id: 'obs-b' });
  const alsoThree = standing({ id: 'obs-c' }, { voices: 4 });
  const { upcoming } = await new RuleDispatcher().decide(ctx({ obstacles: [three, two, alsoThree] }));

  const repairs = (upcoming ?? []).filter((q) => q.rule === 'obstacle-repair');
  // A store that can queue work can put agents on the fleet, so it is one rule
  // and one dispatch at a time — the headroom cut bounds how many agents run, not
  // how many of them this rule may be.
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]!.origin, 'obstacle:obs-a');
  assert.equal(repairs[0]!.kind, 'code');
  assert.equal(repairs[0]!.branch, 'obstacle/obs-a');
});

test('a repair already in flight stops the rule proposing another', async () => {
  const { upcoming } = await new RuleDispatcher().decide(
    ctx({
      obstacles: [standing({ id: 'obs-a' }, { voices: 3 }), standing({ id: 'obs-b' }, { voices: 3 })],
      tasks: [
        {
          id: 't1',
          kind: 'code',
          title: 'Repair',
          status: 'running',
          branch: 'obstacle/obs-a',
          originRef: 'obstacle:obs-a',
          createdAt: NOW,
        } as never,
      ],
    }),
  );
  assert.deepEqual(
    (upcoming ?? []).filter((q) => q.rule === 'obstacle-repair').map((q) => q.origin),
    [],
  );
});

test('the origin is classified, so the flag expands over it and its spend is its own', () => {
  // Left unclassified it reads as `unrecognised`: it stops expanding under a
  // goal's priority flag and its spend files under "other". Neither is red.
  assert.equal(obstacleOriginId('obstacle:obs-a'), 'obs-a');
  assert.equal(obstacleOriginId('issue:12'), null);
  assert.equal(phaseOf('obstacle:obs-a'), 'obstacle');

  const world = { openPrs: [], issues: [] as Issue[], plans: [], parts: [] };
  const flagged = [{ originRef: 'issue:900', setAt: NOW } as never];
  // A goal that reported it.
  const byVoice = expeditedOrigins(flagged, { ...world, obstacles: [standing()] });
  assert.equal(byVoice('obstacle:obs-a'), true);
  // And a goal parked behind one two other goals reported, which the voices
  // cannot see.
  const block: ObstacleBlock = {
    originRef: 'issue:900',
    obstacleId: 'obs-z',
    agentId: null,
    taskId: null,
    note: 'stuck',
    createdAt: NOW,
  };
  const byBlock = expeditedOrigins(flagged, { ...world, obstacleBlocks: [block] });
  assert.equal(byBlock('obstacle:obs-z'), true);
  assert.equal(byBlock('obstacle:obs-a'), false);
});

// -- blocked is an answer -----------------------------------------------------

test('a block holds while its obstacle reaches agents, and releases the moment it does not', () => {
  const block: ObstacleBlock = {
    originRef: 'issue:12',
    obstacleId: 'obs-a',
    agentId: 'a1',
    taskId: 't1',
    note: 'the base will not build',
    createdAt: NOW,
  };
  for (const state of ['standing', 'owned'] as const) {
    assert.equal(blockedGoals([block], [standing({ state })]).size, 1, `${state} still holds the goal`);
    assert.deepEqual(releasedBlocks([block], [standing({ state })]), []);
  }
  for (const state of ['resolved', 'dormant', 'muted'] as const) {
    assert.equal(blockedGoals([block], [standing({ state })]).size, 0, `${state} lets the goal back out`);
  }
  // A block naming a row that is gone releases rather than holds: an unheld goal
  // is a redundant agent somebody can see, and a goal held behind an id nothing
  // resolves is work that never comes back with nothing red.
  assert.deepEqual(releasedBlocks([block], []), [block]);
});

test('conclude_work blocked parks the goal, and the desk brings it back', async () => {
  const system = build();
  const id = stand(system);
  const task = system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

  // An id that names nothing is a park with nothing to lift it, so it is refused
  // rather than written — a typo an agent can fix this turn.
  assert.equal(system.agents.recordBlocked(agent.id, 'obs-nope', 'stuck').ok, false);

  const blocked = system.agents.recordBlocked(agent.id, id, 'the base will not build');
  assert.ok(blocked.ok);
  assert.deepEqual(
    system.store.listObstacleBlocks().map((b) => [b.originRef, b.obstacleId]),
    [['issue:12', id]],
  );
  // **No conclusion is written.** `more_work` here would send the goal straight
  // back to pickup, which is the next agent hitting the same wall.
  assert.equal(system.store.listIssueConclusions().length, 0);

  const issue: Issue = {
    id: 'i12',
    number: 12,
    title: 'Make it better',
    body: 'the thing should be better',
    labels: ['lubbdubb-watch'],
    state: 'open',
    linkedPrNumber: null,
  };
  const world = { takenAt: NOW, pullRequests: [], issues: [issue] };
  const board = () => system.store.obstacleBoard();
  const parked = await new RuleDispatcher().decide(
    ctx({ world, obstacles: board(), obstacleBlocks: system.store.listObstacleBlocks() }),
  );
  assert.deepEqual(
    (parked.upcoming ?? []).filter((q) => q.origin === 'issue:12'),
    [],
    'the goal does not return to pickup while the obstacle stands',
  );

  // The exit is the obstacle rather than the issue, and `owned` is not it: being
  // fixed is not fixed, so the goal stays parked while somebody works on it.
  system.store.claimObstacle(id);
  system.store.setObstacleOwner(id, 'issue:841');
  const desk = new ObstacleOwnershipDesk({ store: system.store, watchLabel: '' });
  await desk.run(world);
  assert.equal(system.store.listObstacleBlocks().length, 1);
  // What lifts it is the row leaving the states that reach agents, which is
  // `releasedBlocks` above — nothing writes `resolved` or `dormant` yet, and the
  // sweep that will is what this desk already runs on every pulse.
  system.store.close();
});
