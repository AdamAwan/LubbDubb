import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { obstacleDesk } from './support/obstacles.js';
import { obstacleRepairOrigin, ownershipDoor, redBaseChecks } from '../src/obstacles/ownership.js';
import { blockedGoals, releasedBlocks } from '../src/obstacles/blocked.js';
import { obstacleOriginId } from '../src/issueOrigins.js';
import { phaseOf } from '../src/insights/spendInsights.js';
import { expeditedOrigins } from '../src/dispatcher/goalPriority.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Issue, Obstacle, ObstacleBlock, ObstacleStanding, PullRequest } from '../src/types.js';

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

test('a note is never owned, and neither is anything already taken', () => {
  assert.equal(ownershipDoor(standing({ kind: 'note' }), new Set()), null);
  assert.equal(ownershipDoor(standing({ state: 'sighted' }), new Set()), null);
  assert.equal(ownershipDoor(standing({ state: 'owned', ownerRef: 'issue:41' }), new Set()), null);
});

test('the second door opens only for what is blocking the fleet now', () => {
  assert.equal(ownershipDoor(standing(), new Set()), 'ticket');
  assert.equal(ownershipDoor(standing({}, { voices: 3 }), new Set()), 'repair');
  assert.equal(ownershipDoor(standing(), new Set(['test (windows)'])), 'repair');
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

function stand(system: System, voices = ['issue:900', 'issue:901']): string {
  for (const goal of voices) {
    system.store.obstacles.recordObstacleSighting(
      {
        what: 'the windows runner wedges before the suite starts',
        kind: 'obstacle',
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
  return system.store.obstacles.listObstacles()[0]!.id;
}

const EMPTY_WORLD = { takenAt: NOW, pullRequests: [], issues: [] };

test('the ticket door files once, with the watch label, and cannot be walked through twice', async () => {
  const system = build();
  const id = stand(system);
  const filed: { title: string; labels?: string[]; bug?: boolean; relatedTo?: number }[] = [];
  const desk = obstacleDesk(system.store, {
    filing: async (input) => {
      filed.push(input);
      return 'issue:841';
    },
    watchLabel: 'lubbdubb-watch',
  });

  await desk.ownership(EMPTY_WORLD);
  await desk.ownership(EMPTY_WORLD);

  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0]!.labels, ['lubbdubb-watch']);
  assert.equal(filed[0]!.bug, true);
  assert.equal(filed[0]!.relatedTo, 900, 'related to the goal that hit it first');
  assert.match(filed[0]!.title, /windows runner wedges/);

  const owned = system.store.obstacles.getObstacle(id)!;
  assert.equal(owned.state, 'owned');
  assert.equal(owned.ownerRef, 'issue:841');
  system.store.close();
});

test('a tracker that refuses hands the row back, rather than owning it with nothing', async () => {
  const system = build();
  const id = stand(system);
  const errors: string[] = [];
  let attempts = 0;
  const desk = obstacleDesk(system.store, {
    filing: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the tracker said no');
      return 'issue:842';
    },
    watchLabel: '',
    errors: { record: (e: { message: string }) => void errors.push(e.message) } as never,
  });

  await desk.ownership(EMPTY_WORLD);
  assert.equal(system.store.obstacles.getObstacle(id)!.state, 'standing');
  assert.equal(system.store.obstacles.getObstacle(id)!.ownerRef, null);
  assert.equal(errors.length, 1);

  await desk.ownership(EMPTY_WORLD);
  assert.equal(system.store.obstacles.getObstacle(id)!.ownerRef, 'issue:842');
  system.store.close();
});

test('the repair door is recorded, never taken: the desk owns a row the rule actually dispatched', async () => {
  const system = build();
  const id = stand(system, ['issue:900', 'issue:901', 'issue:902']);
  const desk = obstacleDesk(system.store);

  await desk.ownership(EMPTY_WORLD);
  assert.equal(system.store.obstacles.getObstacle(id)!.state, 'standing');

  system.store.tasks.createTask({
    kind: 'code',
    title: 'Repair it',
    prompt: 'fix',
    branch: `obstacle/${id}`,
    originRef: obstacleRepairOrigin(id),
  });
  await desk.ownership(EMPTY_WORLD);

  const owned = system.store.obstacles.getObstacle(id)!;
  assert.equal(owned.state, 'owned');
  assert.equal(owned.ownerRef, `obstacle:${id}`);
  system.store.close();
});

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
  assert.equal(obstacleOriginId('obstacle:obs-a'), 'obs-a');
  assert.equal(obstacleOriginId('issue:12'), null);
  assert.equal(phaseOf('obstacle:obs-a'), 'obstacle');

  const world = { openPrs: [], issues: [] as Issue[], plans: [], parts: [] };
  const flagged = [{ originRef: 'issue:900', setAt: NOW } as never];
  const byVoice = expeditedOrigins(flagged, { ...world, obstacles: [standing()] });
  assert.equal(byVoice('obstacle:obs-a'), true);
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
  assert.deepEqual(releasedBlocks([block], []), [block]);
});

test('conclude_work blocked parks the goal, and the desk brings it back', async () => {
  const system = build();
  const id = stand(system);
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Resolve issue #12',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

  assert.equal(system.agents.recordBlocked(agent.id, 'obs-nope', 'stuck').ok, false);

  const blocked = system.agents.recordBlocked(agent.id, id, 'the base will not build');
  assert.ok(blocked.ok);
  assert.deepEqual(
    system.store.obstacles.listObstacleBlocks().map((b) => [b.originRef, b.obstacleId]),
    [['issue:12', id]],
  );
  assert.equal(system.store.verdicts.listIssueConclusions().length, 0);

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
  const board = () => system.store.obstacles.obstacleBoard();
  const parked = await new RuleDispatcher().decide(
    ctx({ world, obstacles: board(), obstacleBlocks: system.store.obstacles.listObstacleBlocks() }),
  );
  assert.deepEqual(
    (parked.upcoming ?? []).filter((q) => q.origin === 'issue:12'),
    [],
    'the goal does not return to pickup while the obstacle stands',
  );

  system.store.obstacles.claimObstacle(id);
  system.store.obstacles.setObstacleOwner(id, 'issue:841');
  const desk = obstacleDesk(system.store);
  await desk.ownership(world);
  assert.equal(system.store.obstacles.listObstacleBlocks().length, 1);
  system.store.close();
});
