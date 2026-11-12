import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { buildSystem } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { goalRecord } from '../src/retro/record.js';
import type { Task } from '../src/types.js';

function clockAt(start: number): { now: () => string; advance: (ms: number) => void } {
  let t = start;
  return { now: () => new Date(t).toISOString(), advance: (ms) => void (t += ms) };
}

function seed(store: Store, originRef: string | null, status: Task['status'], branch = 'b'): Task {
  return store.tasks.createTask({ kind: 'code', title: originRef ?? 't', prompt: 'p', branch, originRef, status });
}

const FULL_READ = /FROM tasks ORDER BY created_at DESC/;

function countFullReads(): { reads: () => number; restore: () => void } {
  const probe = new Database(':memory:');
  const proto = Object.getPrototypeOf(probe.prepare('SELECT 1')) as { all: (...args: unknown[]) => unknown };
  probe.close();
  const original = proto.all;
  let reads = 0;
  proto.all = function (this: { source: string }, ...args: unknown[]) {
    if (FULL_READ.test(this.source)) reads += 1;
    return original.apply(this, args);
  };
  return { reads: () => reads, restore: () => void (proto.all = original) };
}

test('listTasks hands back one read until a task is written', () => {
  const store = new Store(':memory:', clockAt(Date.parse('2026-01-01T00:00:00Z')).now);
  const counter = countFullReads();
  try {
    const first = seed(store, 'issue:1', 'running');
    const a = store.tasks.listTasks();
    const b = store.tasks.listTasks();
    assert.equal(a, b, 'a second read between writes is the same list');
    assert.equal(counter.reads(), 1);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0]), 'the shared list cannot be edited by a caller');

    const second = seed(store, 'issue:2', 'queued');
    const c = store.tasks.listTasks();
    assert.notEqual(c, a, 'a created task clears it');
    assert.deepEqual(c.map((t) => t.id).sort(), [first.id, second.id].sort());

    store.tasks.updateTask(first.id, { status: 'done' });
    const d = store.tasks.listTasks();
    assert.equal(d.find((t) => t.id === first.id)?.status, 'done', 'an updated task clears it');
    assert.equal(a.find((t) => t.id === first.id)?.status, 'running', 'and an earlier holder keeps its snapshot');
    assert.equal(counter.reads(), 3);
  } finally {
    counter.restore();
    store.close();
  }
});

test('listTasksTouchedSince is the active set plus whatever changed after the instant', () => {
  const clock = clockAt(Date.parse('2026-01-01T00:00:00Z'));
  const store = new Store(':memory:', clock.now);
  try {
    const oldDone = seed(store, 'issue:1', 'done');
    const oldRunning = seed(store, 'issue:2', 'running');
    const settlesLater = seed(store, 'issue:3', 'running');
    clock.advance(60_000);
    const since = clock.now();
    clock.advance(1_000);
    store.tasks.updateTask(settlesLater.id, { status: 'done' });
    const fresh = seed(store, 'issue:4', 'failed');

    const ids = store.tasks.listTasksTouchedSince(since).map((t) => t.id);
    assert.deepEqual(ids.sort(), [oldRunning.id, settlesLater.id, fresh.id].sort());
    assert.ok(!ids.includes(oldDone.id), 'a task settled before the instant is not read');
    assert.equal(new Set(ids).size, ids.length, 'an active task changed since is read once');
  } finally {
    store.close();
  }
});

test("a goal's retrospective reads its own tasks, and nobody else's", () => {
  const store = new Store(':memory:', clockAt(Date.parse('2026-01-01T00:00:00Z')).now);
  try {
    const mine = [seed(store, 'issue:12', 'done'), seed(store, 'issue:12:part:api', 'done')];
    const neighbour = seed(store, 'issue:120', 'done');
    seed(store, 'issue:1', 'done');
    seed(store, 'pr:12', 'done');
    store.agents.createAgent({ taskId: mine[1]!.id, cwd: '/w', pid: null });
    store.agents.createAgent({ taskId: neighbour.id, cwd: '/w', pid: null });
    assert.equal(goalRecord(store, 'issue:12').agentCount, 1);
    assert.deepEqual(
      store.tasks
        .listGoalTasks('issue:12', [])
        .map((t) => t.id)
        .sort(),
      mine.map((t) => t.id).sort(),
    );
  } finally {
    store.close();
  }
});

test('a cycle that writes no task reads the table at most once, and the next reads it not at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  const counter = countFullReads();
  try {
    system.runtimeControl.apply({ paused: true });
    system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
    await system.harness.runCycle('manual');
    assert.equal(counter.reads(), 1, `a cycle read the whole table ${counter.reads()} times`);

    const before = counter.reads();
    await system.harness.runCycle('manual');
    assert.equal(counter.reads(), before, 'nothing was written, so nothing is re-read');
  } finally {
    counter.restore();
    system.store.close();
  }
});

test('every statement that writes tasks is in TaskStore, and clears its list', () => {
  const files = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(`${d}/${e.name}`) : e.name.endsWith('.ts') ? [`${d}/${e.name}`] : [],
    );
  const WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+tasks\b/;
  const writers = files('src').filter((f) => WRITE.test(readFileSync(f, 'utf8')));
  assert.deepEqual(writers, ['src/store/tasks.ts'], 'a write elsewhere leaves listTasks serving the old table');

  const source = readFileSync('src/store/tasks.ts', 'utf8');
  const body = source.slice(source.indexOf('export class TaskStore'), source.indexOf('\n}\n'));
  const methods = body.split(/\n {2}(?=\w+\()/).slice(1);
  const writing = methods.filter((m) => WRITE.test(m));
  assert.ok(writing.length >= 2, 'createTask and updateTask are found, or this proves nothing');
  for (const m of writing)
    assert.match(m, /this\.summaries = null/, `${m.slice(0, m.indexOf('('))} must clear the list`);
});
