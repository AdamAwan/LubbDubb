import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { obstaclesForDispatch, renderObstacleNote } from '../src/obstacles/delivery.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import type { Obstacle, ObstacleKey } from '../src/types.js';

/**
 * The first delivery channel: **at dispatch, scoped to the keys**.
 *
 * What is asserted here is the scoping and the shape of it. The obstacles whose
 * keys intersect this dispatch reach its prompt; a row on another check does not,
 * and a `sighted` row reaches nobody at all. And it is **appended** to the
 * rendered prompt rather than interpolated — an `{obstacles}` placeholder would
 * be dropped in silence by any operator override written before this existed.
 * → `docs/spec/32-obstacles.md#delivery`
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacle-delivery-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
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

/**
 * Put a row on the board, at the state `voices` distinct goals carry it to.
 *
 * The keys are handed in already gated, which is the intake's own seam: what the
 * three gates decide is `test/obstacleMatch.test.ts`' subject, and what is
 * delivered is this one's.
 */
function board(system: System, what: string, check: string, file: string, voices: number): void {
  for (let i = 0; i < voices; i++) {
    system.store.recordObstacleSighting(
      {
        what,
        kind: 'obstacle',
        keys: [
          { kind: 'check', value: check, binds: true },
          { kind: 'path', value: file, binds: true },
        ],
        untilHours: null,
      },
      {
        agentId: `agent-${check}-${i}`,
        taskId: `task-${check}-${i}`,
        goalRef: `issue:${900 + i}`,
        sessionId: null,
        transition: null,
        words: what,
        whyNotMine: 'nothing of mine is near it.',
      },
    );
  }
}

/** One code dispatch, about one check, straight through the executor. */
async function dispatch(system: System, ciChecks: string[]): Promise<string> {
  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'dispatch_code_agent',
        title: 'Fix the check',
        prompt: 'THE TASK ITSELF',
        branch: 'pr/412',
        originRef: 'pr:412:ci',
        reason: 'r',
        rule: 'pr-ci-failing',
        ciChecks,
      },
    ],
  } as unknown as DispatchResult;
  await system.executor.execute('cyc', plan);
  const task = system.store.listTasks().find((t) => t.originRef === 'pr:412:ci');
  assert.ok(task, 'nothing was dispatched, so there is no prompt to read');
  return system.store.getTask(task.id)?.prompt ?? '';
}

test('an obstacle on this dispatch’s own check is appended to its prompt, and one on another check is not', async () => {
  const system = build();
  board(system, 'the windows runner wedges before the suite starts', 'test (windows)', 'src/a.ts', 2);
  board(system, 'the linter is out of memory on the monorepo', 'lint', 'src/b.ts', 2);

  const prompt = await dispatch(system, ['test (windows)']);

  // Appended, never interpolated: the rendered task prompt is still there whole,
  // with the board's note after it. An `{obstacles}` token would have been dropped
  // in silence by an override written before this existed.
  assert.match(prompt, /^THE TASK ITSELF/);
  assert.match(prompt, /the windows runner wedges before the suite starts/);
  assert.match(prompt, /do not go fixing one/i);
  // Keyed means delivered to the dispatches it is about — and to no others. A
  // fleet-wide block would have put both in front of both agents.
  assert.doesNotMatch(prompt, /linter is out of memory/);
  system.store.close();
});

test('a sighted row reaches nobody, however well its keys match', async () => {
  const system = build();
  board(system, 'the windows runner wedges before the suite starts', 'test (windows)', 'src/a.ts', 1);

  const prompt = await dispatch(system, ['test (windows)']);

  // **One report is not evidence.** It is also the case the harness cannot tell
  // apart from an agent mis-diagnosing its own breakage, so telling the fleet
  // would be telling it a genuinely new failure is already somebody else's.
  assert.doesNotMatch(prompt, /windows runner wedges/);
  assert.equal(system.store.listObstacles()[0]!.state, 'sighted');
  system.store.close();
});

test('a dispatch the board says nothing about carries nothing at all', async () => {
  const system = build();
  board(system, 'the windows runner wedges before the suite starts', 'test (windows)', 'src/a.ts', 2);

  const prompt = await dispatch(system, ['format:check']);

  // Empty means **empty**: no header over an empty list, so the prompt carries
  // nothing this subsystem put there at all.
  assert.doesNotMatch(prompt, /windows runner wedges/);
  assert.doesNotMatch(prompt, /What the fleet has already hit/);
  system.store.close();
});

/** A row as the pure matcher reads it, with none of the store in the way. */
function row(over: Partial<Obstacle>, keys: Partial<ObstacleKey>[]): { obstacle: Obstacle; keys: ObstacleKey[] } {
  return {
    obstacle: {
      id: 'obs-1',
      what: 'something is broken',
      kind: 'obstacle',
      state: 'standing',
      ownerRef: null,
      until: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      ...over,
    },
    keys: keys.map((key, i) => ({
      id: `obk-${i}`,
      obstacleId: 'obs-1',
      kind: 'check',
      value: 'x',
      binds: true,
      confirmations: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...key,
    })),
  };
}

test('the paths half is the goal’s own files, and a suggestion-only key delivers nothing', () => {
  const onPath = row({ id: 'obs-1' }, [{ kind: 'path', value: 'src/pool/desk.ts' }]);
  const onSignature = row({ id: 'obs-2' }, [{ kind: 'signature', value: 'error: enoent <n>', binds: false }]);
  const delivered = obstaclesForDispatch({
    rows: [onPath, onSignature],
    scopes: ['goal:issue:12'],
    paths: ['src/pool/desk.ts'],
  });

  assert.deepEqual(
    delivered.map((d) => d.obstacle.id),
    ['obs-1'],
  );
  // A key that may not resolve an obstacle may not decide who is told about one
  // either — otherwise "does not bind" would mean *binds when convenient*.
  assert.deepEqual(obstaclesForDispatch({ rows: [onSignature], scopes: [], paths: ['src/pool/desk.ts'] }), []);
});

test('the note is bounded and says what it dropped', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    row({ id: `obs-${i}`, what: `a long claim about the ${i}th thing that is broken in this repository today` }, [
      { kind: 'check', value: `check-${i}` },
    ]),
  );
  const note = renderObstacleNote(many);

  // An agent that reads a partial record as a whole one concludes something from
  // an absence that was merely trimmed, which is worse than no record at all.
  assert.match(note, /further obstacles on these checks and files are not shown/);
  assert.ok(note.length < 1_600, `the note is bounded, and this one is ${note.length} characters`);
  assert.equal(renderObstacleNote([]), '');
});
