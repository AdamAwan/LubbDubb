import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ObstacleVoiceDesk } from '../src/obstacles/voiceDesk.js';
import { harnessSightings } from '../src/obstacles/voice.js';
import type { CiCheck, PullRequest, WorldSnapshot } from '../src/types.js';

const NOW = '2026-07-28T12:00:00.000Z';

function check(over: Partial<CiCheck> = {}): CiCheck {
  return { name: 'test (windows)', status: 'failing', ...over } as CiCheck;
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr-1',
    number: 1,
    title: 'a change',
    branch: 'feature/one',
    baseBranch: 'main',
    merged: false,
    unresolvedComments: [],
    ...over,
  } as PullRequest;
}

function world(prs: PullRequest[]): WorldSnapshot {
  return { takenAt: NOW, pullRequests: prs, issues: [] };
}

function stack(baseChecks: CiCheck[], rungs = 1): PullRequest[] {
  const base = pr({ id: 'pr-base', number: 100, branch: 'base/one', headSha: 'aaaaaaa1', ciChecks: baseChecks });
  const out = [base];
  for (let i = 0; i < rungs; i++)
    out.push(pr({ id: `pr-r${i}`, number: 200 + i, branch: `rung/${i}`, baseBranch: 'base/one', headSha: 'bbbbbbb1' }));
  return out;
}

test('a check going red on a branch other pull requests are based on is one transition, however many rungs', () => {
  const before = world(stack([check({ status: 'passing' })], 2));
  const after = world(stack([check()], 2));
  const seen = harnessSightings(before, after);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.checkName, 'test (windows)');
  assert.equal(seen[0]!.transition, 'base-red:test (windows)@base/one');
  assert.match(seen[0]!.what, /failing on branch `base\/one`/);
});

test('a check flapping red-then-green on one head is a transition, and a push in between is not', () => {
  const red = pr({ headSha: 'cccccc1', ciChecks: [check()] });
  const green = pr({ headSha: 'cccccc1', ciChecks: [check({ status: 'passing' })] });
  const seen = harnessSightings(world([red]), world([green]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.transition, 'flake:test (windows)@cccccc1');
  assert.deepEqual(harnessSightings(world([red]), world([pr({ ...green, headSha: 'ddddd22' })])), []);
});

test('the first pulse over a fresh store sees nothing at all', () => {
  assert.deepEqual(harnessSightings(null, world(stack([check()]))), []);
});

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacle-voice-'));
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

function agentReport(system: System, goalRef: string): void {
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
      agentId: `agent-${goalRef}`,
      taskId: `task-${goalRef}`,
      goalRef,
      sessionId: null,
      transition: null,
      words: `${goalRef} hit it`,
      whyNotMine: 'nothing of mine is near it.',
    },
  );
}

test('a harness voice and one agent voice reach standing, and the harness alone does not', () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  desk.run(world(stack([check({ status: 'passing' })])), world(stack([check()])));

  const filed = system.store.obstacles.listObstacles();
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.state, 'sighted');
  const board = system.store.obstacles.obstacleBoard();
  assert.equal(board[0]!.voices, 1);
  const sighting = system.store.obstacles.listObstacleSightings(filed[0]!.id)[0]!;
  assert.equal(sighting.goalRef, null);
  assert.equal(sighting.agentId, null);
  assert.equal(sighting.transition, 'base-red:test (windows)@base/one');

  agentReport(system, 'issue:900');
  const after = system.store.obstacles.obstacleBoard();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.voices, 2);
  assert.equal(after[0]!.obstacle.state, 'standing');
});

test('two harness readings of one transition are one voice and never two rows', () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  const before = world(stack([check({ status: 'passing' })], 2));
  const after = world(stack([check()], 2));
  desk.run(before, after);
  desk.run(before, after);
  const board = system.store.obstacles.obstacleBoard();
  assert.equal(board.length, 1);
  assert.equal(board[0]!.voices, 1);
  assert.equal(board[0]!.obstacle.state, 'sighted');
});

test("the harness's own key goes through the gates, and a check the world does not report is dropped", () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  const after = world(stack([check()]));
  desk.run(world(stack([check({ status: 'passing' })])), {
    ...after,
    pullRequests: after.pullRequests.map((p) => ({ ...p, ciChecks: p.ciChecks && [] })),
  });
  assert.deepEqual(system.store.obstacles.listObstacles(), []);
});

test('the key the harness files binds, but does not resolve a row on its own', () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  desk.run(world(stack([check({ status: 'passing' })])), world(stack([check()])));
  const [row] = system.store.obstacles.obstacleBoard();
  assert.deepEqual(
    row!.keys.map((key) => [key.kind, key.value, key.binds]),
    [['check', 'test (windows)', true]],
  );
  desk.run(world(stack([check({ status: 'passing' })])), world(stack([check()], 2)));
  assert.equal(system.store.obstacles.listObstacles().length, 1);
});
