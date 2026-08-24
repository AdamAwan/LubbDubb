import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Issue, IssueRelative } from '../src/types.js';

// Watching a Feature means watching the work it stands for. A container is never
// dispatched at, so a tag on one alone changes nothing an operator can see — the
// route walks its tree and writes the tag on every descendant, and un-watching
// walks the same tree so a dropped feature cannot leave its stories running.

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: 'lubbdubb',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

function issue(over: Partial<Issue> & { number: number }): Issue {
  return {
    id: `i${over.number}`,
    title: `Item ${over.number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function relative(number: number): IssueRelative {
  return { number, title: `Item ${number}`, issueType: 'User Story', workItemState: 'Active', state: 'open' };
}

/** A Feature over two stories, one of which has a task of its own. */
function seed(system: System): void {
  system.store.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [
      issue({ number: 1, issueType: 'Feature', children: [relative(2), relative(3)] }),
      issue({ number: 2, issueType: 'User Story', children: [relative(4)] }),
      issue({ number: 3, issueType: 'User Story' }),
      issue({ number: 4, issueType: 'Task' }),
      issue({ number: 9, issueType: 'User Story' }),
    ],
  });
}

/** Records what the outbound seam was asked to write, in order. */
function recordLabels(system: System): { number: number; label: string; present: boolean }[] {
  const writes: { number: number; label: string; present: boolean }[] = [];
  const connector = system.connector as unknown as {
    setIssueLabel: (input: { number: number; label: string; present: boolean }) => Promise<unknown>;
  };
  connector.setIssueLabel = async (input) => {
    writes.push({ ...input });
    return { ok: true };
  };
  return writes;
}

test('watching a Feature tags every item beneath it, the whole tree deep', async () => {
  const system = build();
  seed(system);
  const writes = recordLabels(system);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cascaded, 3);

  // The feature, its two stories, and the task under one of them.
  const watched = writes.filter((w) => w.label === 'lubbdubb-watch');
  assert.deepEqual(
    watched.map((w) => w.number),
    [1, 2, 3, 4],
  );
  assert.equal(
    watched.every((w) => w.present),
    true,
  );
  // One label and no other: there is no second tag to keep it exclusive with.
  assert.deepEqual(new Set(writes.map((w) => w.label)), new Set(['lubbdubb-watch']));
});

test('un-watching a Feature walks the same tree, so no child is left running', async () => {
  const system = build();
  seed(system);
  const writes = recordLabels(system);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    writes.filter((w) => w.label === 'lubbdubb-watch' && !w.present).map((w) => w.number),
    [1, 2, 3, 4],
  );
});

test('a leaf writes its own tag and nothing else', async () => {
  const system = build();
  seed(system);
  const writes = recordLabels(system);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/9/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cascaded, 0);
  assert.deepEqual(new Set(writes.map((w) => w.number)), new Set([9]));
});

test('an issue the snapshot does not carry still writes its own tag', async () => {
  const system = build();
  seed(system);
  const writes = recordLabels(system);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/404/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(new Set(writes.map((w) => w.number)), new Set([404]));
});

test('a partial cascade failure is reported rather than answered "watched"', async () => {
  const system = build();
  seed(system);
  const writes: number[] = [];
  const connector = system.connector as unknown as {
    setIssueLabel: (input: { number: number; label: string; present: boolean }) => Promise<unknown>;
  };
  connector.setIssueLabel = async (input) => {
    if (input.number === 3) throw new Error('work item 3 is locked');
    writes.push(input.number);
    return { ok: true };
  };
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 400);
  const error = res.json().error as string;
  assert.match(error, /Tagged 3 of 4/);
  assert.match(error, /#3/);
  assert.match(error, /work item 3 is locked/);
  // What landed still landed — the ones that succeeded are not rolled back.
  assert.deepEqual(new Set(writes), new Set([1, 2, 4]));
  // …and the failure is on the error log rather than swallowed into the 400.
  assert.equal(
    system.store.listErrors(50).some((e) => e.message.includes('work item 3 is locked')),
    true,
  );
});
