import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ObstacleEndingsDesk } from '../src/obstacles/endingsDesk.js';
import {
  clockExpired,
  conditionMet,
  conditionsSettled,
  conditionsToWatch,
  decayed,
  notesToWriteUp,
  ownerLanded,
  writeUpReading,
} from '../src/obstacles/endings.js';
import type {
  Obstacle,
  ObstacleCondition,
  ObstacleStanding,
  PullRequest,
  WorkNode,
  WorldSnapshot,
} from '../src/types.js';

const NOW = '2026-07-28T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const WEEK = 7 * 24 * 60 * 60 * 1000;

function obstacle(over: Partial<Obstacle> = {}): Obstacle {
  return {
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
  };
}

function standing(over: Partial<Obstacle> = {}, extra: Partial<ObstacleStanding> = {}): ObstacleStanding {
  return {
    obstacle: obstacle(over),
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

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr-1',
    number: 1,
    title: 'a change',
    branch: 'issue/12',
    ciStatus: 'failing',
    ciChecks: [{ name: 'test (windows)', status: 'failing' }],
    unresolvedComments: [],
    ...over,
  };
}

function condition(over: Partial<ObstacleCondition> = {}): ObstacleCondition {
  return {
    id: 'c1',
    obstacleId: 'obs-a',
    kind: 'check-green',
    checkName: 'test (windows)',
    branch: 'issue/12',
    metAt: null,
    createdAt: NOW,
    ...over,
  };
}

test('a condition names a check the harness watches and a branch it saw it red on', () => {
  const watched = conditionsToWatch([standing()], [pr(), pr({ number: 2, branch: 'other', ciChecks: [] })]);
  assert.deepEqual(watched, [
    { obstacleId: 'obs-a', kind: 'check-green', checkName: 'test (windows)', branch: 'issue/12' },
  ]);
});

test('a suggestion never becomes a condition, and a sighted row gets none', () => {
  const suggestion = standing({}, { keys: [{ ...standing().keys[0]!, binds: false }] });
  assert.deepEqual(conditionsToWatch([suggestion], [pr()]), []);
  assert.deepEqual(conditionsToWatch([standing({ state: 'sighted' })], [pr()]), []);
  assert.deepEqual(conditionsToWatch([standing({ kind: 'note' })], [pr()]), []);
});

test('green, gone, and closed meet it — pending and no detail do not', () => {
  assert.equal(conditionMet(condition(), [pr({ ciChecks: [{ name: 'test (windows)', status: 'passing' }] })]), true);
  assert.equal(conditionMet(condition(), [pr({ ciChecks: [{ name: 'lint', status: 'passing' }] })]), true);
  assert.equal(conditionMet(condition(), []), true);
  assert.equal(conditionMet(condition(), [pr({ ciChecks: [{ name: 'test (windows)', status: 'pending' }] })]), false);
  assert.equal(conditionMet(condition(), [pr({ ciChecks: [{ name: 'test (windows)', status: 'failing' }] })]), false);
  assert.equal(conditionMet(condition(), [pr({ ciChecks: undefined })]), false);
});

test('every condition on a row has to be met, not any of them', () => {
  const both = [condition(), condition({ id: 'c2', branch: 'issue/13' })];
  const green = pr({ ciChecks: [{ name: 'test (windows)', status: 'passing' }] });
  assert.equal(conditionsSettled(both, [green, pr({ number: 2, branch: 'issue/13' })]), false);
  assert.equal(conditionsSettled(both, [green, pr({ number: 2, branch: 'issue/13', ciChecks: [] })]), true);
  assert.equal(conditionsSettled([], []), false);
});

test('the owner landing is read off the landing sweep', () => {
  const owned = obstacle({ state: 'owned', ownerRef: 'issue:841' });
  const landing = { prNumber: 7, goalRef: 'issue:841', sha: 'abc', recordedAt: NOW };
  assert.equal(ownerLanded(owned, [landing]), true);
  assert.equal(ownerLanded(owned, [{ ...landing, goalRef: 'issue:842' }]), false);
  assert.equal(ownerLanded(obstacle(), [landing]), false, 'a row nothing owns has no owner to land');
});

test('the clock expires what nothing settled, and cannot resolve one early', () => {
  const until = new Date(NOW_MS - 1).toISOString();
  const said = new Date(NOW_MS - 60_000).toISOString();
  assert.equal(clockExpired(obstacle({ until, lastSeenAt: said }), NOW_MS), true);
  assert.equal(clockExpired(obstacle({ until: new Date(NOW_MS + 1).toISOString(), lastSeenAt: said }), NOW_MS), false);
  assert.equal(
    clockExpired(obstacle({ until, lastSeenAt: said, state: 'owned', ownerRef: 'issue:841' }), NOW_MS),
    false,
  );
  assert.equal(clockExpired(obstacle(), NOW_MS + WEEK * 52), false);
  assert.equal(clockExpired(obstacle({ until, lastSeenAt: NOW }), NOW_MS), false);
});

test('decay reads the newest sighting, and never touches an owned row', () => {
  const stale = obstacle({ lastSeenAt: new Date(NOW_MS - WEEK).toISOString() });
  assert.equal(decayed(stale, NOW_MS, WEEK), true);
  assert.equal(decayed({ ...stale, lastSeenAt: NOW }, NOW_MS, WEEK), false);
  assert.equal(decayed({ ...stale, state: 'owned', ownerRef: 'issue:841' }, NOW_MS, WEEK), false);
});

test('a standing note is written up once, ever', () => {
  const note = standing({ kind: 'note' });
  assert.deepEqual(notesToWriteUp([note], new Set()).length, 1);
  assert.deepEqual(notesToWriteUp([note], new Set(['obs-a'])), []);
  assert.deepEqual(notesToWriteUp([standing({ kind: 'note', state: 'sighted' })], new Set()), []);
  assert.deepEqual(notesToWriteUp([standing()], new Set()), [], 'an obstacle is not written down, it is fixed');
});

test('a write-up settles on an observed merge, and never on an inferred one', () => {
  const node = (over: Partial<WorkNode>): WorkNode => ({
    ref: 'pr:7',
    kind: 'pr',
    parentRef: 'job:j1',
    baseRef: null,
    title: 'docs',
    status: 'merged',
    terminal: true,
    provenance: 'observed',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...over,
  });
  assert.equal(writeUpReading('j1', [node({})]), 'landed');
  assert.equal(writeUpReading('j1', [node({ provenance: 'inferred' })]), 'unknown');
  assert.equal(writeUpReading('j1', [node({ status: 'closed', terminal: true })]), 'abandoned');
  assert.equal(writeUpReading('j1', [node({ status: 'open', terminal: false })]), null);
  assert.equal(writeUpReading('j1', []), null);
  assert.equal(
    writeUpReading('j1', [node({ ref: 'job:j1', kind: 'job', parentRef: null, status: 'cancelled' })]),
    'abandoned',
  );
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacle-endings-'));
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

function stand(system: System, kind: 'obstacle' | 'note' = 'obstacle', untilHours: number | null = null): string {
  for (const goal of ['issue:900', 'issue:901']) {
    system.store.recordObstacleSighting(
      {
        what: 'the windows runner wedges before the suite starts',
        kind,
        keys: [
          { kind: 'check', value: 'test (windows)', binds: true },
          { kind: 'path', value: 'src/a.ts', binds: true },
        ],
        untilHours,
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

function world(prs: PullRequest[]): WorldSnapshot {
  return { takenAt: NOW, pullRequests: prs, issues: [] };
}

function desk(system: System, over: { now?: () => number; dormantMs?: number } = {}): ObstacleEndingsDesk {
  return new ObstacleEndingsDesk({
    store: system.store,
    dormantMs: over.dormantMs ?? WEEK,
    docsPrompt: (vars) => `write it down: ${vars.summary}`,
    now: over.now ?? (() => NOW_MS),
  });
}

test('a resolution takes two consecutive real readings, and one green reading is not enough', () => {
  const system = build();
  const id = stand(system);
  const endings = desk(system);
  const red = world([pr()]);
  const green = world([pr({ ciChecks: [{ name: 'test (windows)', status: 'passing' }] })]);

  endings.run(red);
  assert.equal(system.store.listObstacleConditions(id).length, 1);
  assert.equal(system.store.getObstacle(id)!.state, 'standing');

  endings.run(green);
  assert.equal(system.store.getObstacle(id)!.state, 'standing');
  assert.notEqual(system.store.listObstacleConditions(id)[0]!.metAt, null);

  endings.run(green);
  const resolved = system.store.getObstacle(id)!;
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.endedBy, 'condition');
  system.store.close();
});

test('a red reading between two green ones puts the count back to nothing', () => {
  const system = build();
  const id = stand(system);
  const endings = desk(system);
  const green = world([pr({ ciChecks: [{ name: 'test (windows)', status: 'passing' }] })]);

  endings.run(world([pr()]));
  endings.run(green);
  endings.run(world([pr()]));
  assert.equal(system.store.listObstacleConditions(id)[0]!.metAt, null);
  endings.run(green);
  assert.equal(system.store.getObstacle(id)!.state, 'standing');
  endings.run(green);
  assert.equal(system.store.getObstacle(id)!.state, 'resolved');
  system.store.close();
});

test('the owner landing ends an owned row, off the sweep and not off the merge', () => {
  const system = build();
  const id = stand(system);
  assert.ok(system.store.claimObstacle(id));
  system.store.setObstacleOwner(id, 'issue:841');

  const endings = desk(system);
  endings.run(world([]));
  assert.equal(system.store.getObstacle(id)!.state, 'owned', 'nothing has landed yet');

  system.store.recordGoalLanding({ prNumber: 7, goalRef: 'issue:841', sha: 'abc123' });
  endings.run(world([]));
  const ended = system.store.getObstacle(id)!;
  assert.equal(ended.state, 'resolved');
  assert.equal(ended.endedBy, 'landing');
  system.store.close();
});

test('the clock expires a row nothing settled, and a re-report brings it back whole', () => {
  const system = build();
  const expiring = stand(system, 'obstacle', 1);
  const until = Date.parse(system.store.getObstacle(expiring)!.until!);
  desk(system, { now: () => until + 1 }).run(world([]));
  const expired = system.store.getObstacle(expiring)!;
  assert.equal(expired.state, 'resolved');
  assert.equal(expired.endedBy, 'expiry');

  assert.equal(stand(system), expiring);
  const back = system.store.getObstacle(expiring)!;
  assert.equal(back.state, 'standing');
  assert.equal(back.endedBy, null, 'a reopened row does not go on saying which ending took it');
  assert.ok(system.store.listObstacleKeys(expiring).length > 0, 'the keys survive, so a re-report reopens it');
  system.store.close();
});

test('decay takes what nothing has said for obstacleDormantMs', () => {
  const system = build();
  const id = stand(system);
  const seen = Date.parse(system.store.getObstacle(id)!.lastSeenAt);
  desk(system, { now: () => seen + WEEK - 1 }).run(world([]));
  assert.equal(system.store.getObstacle(id)!.state, 'standing', 'inside the window it is still on the board');

  desk(system, { now: () => seen + WEEK }).run(world([]));
  const dormant = system.store.getObstacle(id)!;
  assert.equal(dormant.state, 'dormant');
  assert.equal(dormant.endedBy, 'decay');
  assert.ok(system.store.listObstacleKeys(id).length > 0, 'the keys survive, so a re-report reopens it');
  system.store.close();
});

test('a note is written up once, and the note ends when the change lands', () => {
  const system = build();
  const id = stand(system, 'note');
  const endings = desk(system);

  endings.run(world([]));
  const open = system.store.openObstacleWriteUps();
  assert.equal(open.length, 1);
  const jobId = open[0]!.jobId;
  assert.match(system.store.getJob(jobId)!.prompt, /write it down: the windows runner wedges/);
  assert.match(system.store.getJob(jobId)!.prompt, /merging it is what ends it/);

  endings.run(world([]));
  assert.equal(system.store.openObstacleWriteUps().length, 1);
  assert.equal(system.store.getObstacle(id)!.state, 'standing', 'a note stands until the change lands');

  system.store.recordWorkGraph([
    { ref: `job:${jobId}`, kind: 'job', parentRef: null, title: 'docs', status: 'done', terminal: true },
    {
      ref: 'pr:7',
      kind: 'pr',
      parentRef: `job:${jobId}`,
      title: 'docs',
      status: 'merged',
      terminal: true,
      provenance: 'observed',
    },
  ]);
  endings.run(world([]));
  const ended = system.store.getObstacle(id)!;
  assert.equal(ended.state, 'resolved');
  assert.equal(ended.endedBy, 'written-down');
  assert.equal(system.store.openObstacleWriteUps().length, 0);
  assert.equal(system.store.obstacleBoard()[0]!.obstacle.state, 'resolved');
  system.store.close();
});

test('a row already ended keeps the ending that took it', () => {
  const system = build();
  const id = stand(system);
  assert.equal(system.store.endObstacle(id, 'resolved', 'condition'), true);
  assert.equal(system.store.endObstacle(id, 'dormant', 'decay'), false, 'a row already ended keeps its ending');
  assert.equal(system.store.getObstacle(id)!.endedBy, 'condition');
  system.store.close();
});
