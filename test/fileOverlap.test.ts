import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFileOverlaps } from '../src/fileOverlap.js';
import type { Agent, AgentFile, Task } from '../src/types.js';

const T = (mins: number): string => new Date(Date.UTC(2026, 6, 26, 12, mins)).toISOString();

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'running',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: T(0),
    endedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: `task_${id}`,
    kind: 'code',
    title: `Task ${id}`,
    prompt: 'do it',
    branch: `branch-${id}`,
    originRef: `issue:${id}`,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: id,
    createdAt: T(0),
    updatedAt: T(0),
    ...over,
  } as Task;
}

function file(agentId: string, path: string, at = T(5)): AgentFile {
  return { id: `f_${agentId}_${path}`, agentId, path, tool: 'Edit', promoted: false, createdAt: at };
}

test('two concurrent code agents writing one path is an overlap', () => {
  const overlaps = detectFileOverlaps({
    files: [file('a', 'src/store/store.ts'), file('b', 'src/store/store.ts')],
    agents: [agent('a'), agent('b')],
    tasks: [task('a'), task('b')],
  });
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]!.path, 'src/store/store.ts');
  assert.equal(overlaps[0]!.writers.length, 2);
  assert.equal(overlaps[0]!.live, true);
  assert.equal(overlaps[0]!.sameWorktree, false);
  // Provenance is what makes it judgeable: which branch, working what.
  assert.deepEqual(overlaps[0]!.writers.map((w) => w.branch).sort(), ['branch-a', 'branch-b']);
  assert.deepEqual(overlaps[0]!.writers.map((w) => w.originRef).sort(), ['issue:a', 'issue:b']);
});

test('agents that never ran at the same time are not an overlap', () => {
  // The later agent's worktree was cut from a base that already held the earlier
  // one's work. Without this filter every long-lived file in the repo reports.
  const overlaps = detectFileOverlaps({
    files: [file('a', 'src/harness.ts', T(5)), file('b', 'src/harness.ts', T(30))],
    agents: [agent('a', { status: 'done', endedAt: T(10) }), agent('b', { startedAt: T(20) })],
    tasks: [task('a'), task('b')],
  });
  assert.deepEqual(overlaps, []);
});

test('one agent writing a path many times is never an overlap with itself', () => {
  const overlaps = detectFileOverlaps({
    files: [file('a', 'src/x.ts', T(1)), { ...file('a', 'src/x.ts', T(9)), id: 'f2' }],
    agents: [agent('a')],
    tasks: [task('a')],
  });
  assert.deepEqual(overlaps, []);
});

test('desk agents are excluded — their scratch dirs make one path name two files', () => {
  const overlaps = detectFileOverlaps({
    files: [file('a', 'notes.md'), file('b', 'notes.md')],
    agents: [agent('a'), agent('b')],
    tasks: [task('a', { kind: 'desk', branch: null }), task('b', { kind: 'desk', branch: null })],
  });
  assert.deepEqual(overlaps, []);
});

test('two live agents on one branch are flagged as sharing a worktree', () => {
  // WorktreeManager is reuse-first, so one branch is one directory: this is the
  // same file on disk under two processes, with no merge to reconcile it.
  const overlaps = detectFileOverlaps({
    files: [file('a', 'src/x.ts'), file('b', 'src/x.ts')],
    agents: [agent('a'), agent('b')],
    tasks: [task('a', { branch: 'issue/12' }), task('b', { branch: 'issue/12' })],
  });
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]!.sameWorktree, true);
});

test('only the writers that were actually concurrent are named', () => {
  // c ran long after a and b. Naming it would be an accusation the rows don't support.
  const overlaps = detectFileOverlaps({
    files: [file('a', 'src/x.ts', T(3)), file('b', 'src/x.ts', T(4)), file('c', 'src/x.ts', T(50))],
    agents: [
      agent('a', { status: 'done', endedAt: T(10) }),
      agent('b', { status: 'done', endedAt: T(10) }),
      agent('c', { status: 'done', startedAt: T(40), endedAt: T(55) }),
    ],
    tasks: [task('a'), task('b'), task('c')],
  });
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0]!.writers.map((w) => w.agentId).sort(), ['a', 'b']);
  assert.equal(overlaps[0]!.live, false);
});

test('a settled overlap is kept, and live ones rank above it', () => {
  const overlaps = detectFileOverlaps({
    files: [
      file('a', 'old.ts', T(3)),
      file('b', 'old.ts', T(4)),
      file('c', 'now.ts', T(45)),
      file('d', 'now.ts', T(46)),
    ],
    agents: [
      agent('a', { status: 'done', endedAt: T(10) }),
      agent('b', { status: 'done', endedAt: T(10) }),
      agent('c', { startedAt: T(40) }),
      agent('d', { startedAt: T(41) }),
    ],
    tasks: [task('a'), task('b'), task('c'), task('d')],
  });
  assert.deepEqual(
    overlaps.map((o) => o.path),
    ['now.ts', 'old.ts'],
  );
  assert.equal(overlaps[0]!.live, true);
  assert.equal(overlaps[1]!.live, false);
});

test('a file row whose agent or task is gone is ignored rather than throwing', () => {
  const overlaps = detectFileOverlaps({
    files: [file('a', 'src/x.ts'), file('ghost', 'src/x.ts')],
    agents: [agent('a')],
    tasks: [task('a')],
  });
  assert.deepEqual(overlaps, []);
});
