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

/**
 * **The harness is a voice.**
 *
 * Three properties, and each of them fails silently without a test: the harness's
 * own observation counts as **one of the two**, so a row it can see is `standing`
 * from the first agent's report; **the transition is the identity**, so the same
 * reading can never be counted twice; and the keys it carries go through the same
 * three gates an agent's do, with **no exemption** from a bare `check` not
 * binding.
 * → `docs/spec/32-obstacles.md#the-harness-is-a-voice`
 */

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

/** A base at `pr-base` and one rung stacked on it, as the world reports them. */
function stack(baseChecks: CiCheck[], rungs = 1): PullRequest[] {
  const base = pr({ id: 'pr-base', number: 100, branch: 'base/one', headSha: 'aaaaaaa1', ciChecks: baseChecks });
  const out = [base];
  for (let i = 0; i < rungs; i++)
    out.push(pr({ id: `pr-r${i}`, number: 200 + i, branch: `rung/${i}`, baseBranch: 'base/one', headSha: 'bbbbbbb1' }));
  return out;
}

// -- the reading --------------------------------------------------------------

test('a check going red on a branch other pull requests are based on is one transition, however many rungs', () => {
  const before = world(stack([check({ status: 'passing' })], 2));
  const after = world(stack([check()], 2));
  const seen = harnessSightings(before, after);
  // Two rungs, two readings, **one** transition: the base branch is what went red,
  // and counting the rungs would be one reading counted twice.
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
  // A red result followed by a green one on a *different* commit is the ordinary
  // shape of a fix, and calling that a flake would teach the fleet to disbelieve
  // every check anybody ever repaired.
  assert.deepEqual(harnessSightings(world([red]), world([pr({ ...green, headSha: 'ddddd22' })])), []);
});

test('the first pulse over a fresh store sees nothing at all', () => {
  // Every reading here is a comparison, and a single snapshot is not one.
  assert.deepEqual(harnessSightings(null, world(stack([check()]))), []);
});

// -- the desk -----------------------------------------------------------------

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

/** One agent's report, carrying a check **and** a locating key so it resolves. */
function agentReport(system: System, goalRef: string): void {
  system.store.recordObstacleSighting(
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

  const filed = system.store.listObstacles();
  assert.equal(filed.length, 1);
  // **One report is not evidence**, whoever made it — the harness gets no
  // shortcut past the gate it is there to make affordable.
  assert.equal(filed[0]!.state, 'sighted');
  const board = system.store.obstacleBoard();
  assert.equal(board[0]!.voices, 1);
  // Attributed to the harness rather than to a goal, and saying which transition
  // it saw.
  const sighting = system.store.listObstacleSightings(filed[0]!.id)[0]!;
  assert.equal(sighting.goalRef, null);
  assert.equal(sighting.agentId, null);
  assert.equal(sighting.transition, 'base-red:test (windows)@base/one');

  // The first agent's report joins it through the check key it names beside a
  // locating one, and that is the second voice.
  agentReport(system, 'issue:900');
  const after = system.store.obstacleBoard();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.voices, 2);
  assert.equal(after[0]!.obstacle.state, 'standing');
});

test('two harness readings of one transition are one voice and never two rows', () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  const before = world(stack([check({ status: 'passing' })], 2));
  const after = world(stack([check()], 2));
  // Both rungs on one pass, then the same transition seen again on a later pair:
  // an operator reading why a row is standing must never find one voice that is
  // really the same reading counted twice.
  desk.run(before, after);
  desk.run(before, after);
  const board = system.store.obstacleBoard();
  assert.equal(board.length, 1);
  assert.equal(board[0]!.voices, 1);
  assert.equal(board[0]!.obstacle.state, 'sighted');
});

test("the harness's own key goes through the gates, and a check the world does not report is dropped", () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  // The transition is real, but the *validation* set is the world this pass was
  // handed — strip the checks out of it and the key names nothing, so nothing is
  // filed rather than a row identified by a sentence.
  const after = world(stack([check()]));
  desk.run(world(stack([check({ status: 'passing' })])), {
    ...after,
    pullRequests: after.pullRequests.map((p) => ({ ...p, ciChecks: p.ciChecks && [] })),
  });
  assert.deepEqual(system.store.listObstacles(), []);
});

test('the key the harness files binds, but does not resolve a row on its own', () => {
  const system = build();
  const desk = new ObstacleVoiceDesk({ store: system.store });
  desk.run(world(stack([check({ status: 'passing' })])), world(stack([check()])));
  const [row] = system.store.obstacleBoard();
  // It binds — the endings desk promises to watch a condition off a *binding*
  // check key, and the ownership desk opens the repair door on one.
  assert.deepEqual(
    row!.keys.map((key) => [key.kind, key.value, key.binds]),
    [['check', 'test (windows)', true]],
  );
  // And it still does not resolve on its own: a second bare-check reading would
  // file a keyless duplicate, so the harness says nothing where the board already
  // holds the check.
  desk.run(world(stack([check({ status: 'passing' })])), world(stack([check()], 2)));
  assert.equal(system.store.listObstacles().length, 1);
});
