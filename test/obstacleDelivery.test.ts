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

  assert.match(prompt, /^THE TASK ITSELF/);
  assert.match(prompt, /the windows runner wedges before the suite starts/);
  assert.match(prompt, /do not go fixing one/i);
  assert.doesNotMatch(prompt, /linter is out of memory/);
  system.store.close();
});

test('a sighted row reaches nobody, however well its keys match', async () => {
  const system = build();
  board(system, 'the windows runner wedges before the suite starts', 'test (windows)', 'src/a.ts', 1);

  const prompt = await dispatch(system, ['test (windows)']);

  assert.doesNotMatch(prompt, /windows runner wedges/);
  assert.equal(system.store.listObstacles()[0]!.state, 'sighted');
  system.store.close();
});

test('a dispatch the board says nothing about carries nothing at all', async () => {
  const system = build();
  board(system, 'the windows runner wedges before the suite starts', 'test (windows)', 'src/a.ts', 2);

  const prompt = await dispatch(system, ['format:check']);

  assert.doesNotMatch(prompt, /windows runner wedges/);
  assert.doesNotMatch(prompt, /What the fleet has already hit/);
  system.store.close();
});

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
      endedBy: null,
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
  assert.deepEqual(obstaclesForDispatch({ rows: [onSignature], scopes: [], paths: ['src/pool/desk.ts'] }), []);
});

test('the note is bounded and says what it dropped', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    row({ id: `obs-${i}`, what: `a long claim about the ${i}th thing that is broken in this repository today` }, [
      { kind: 'check', value: `check-${i}` },
    ]),
  );
  const note = renderObstacleNote(many);

  assert.match(note, /further obstacles on these checks and files are not shown/);
  assert.ok(note.length < 1_600, `the note is bounded, and this one is ${note.length} characters`);
  assert.equal(renderObstacleNote([]), '');
});
