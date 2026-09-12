import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ObstacleOwnershipDesk } from '../src/obstacles/ownershipDesk.js';
import {
  ObstacleModelDesk,
  parseObstacleReading,
  type ObstacleReader,
  type ObstacleReadingRequest,
} from '../src/obstacles/desk.js';

const CWD = process.cwd();

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obstacle-desk-'));
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

function report(
  system: System,
  input: { what: string; goalRef: string; keys?: { kind: 'check' | 'path' | 'test'; value: string }[] },
): string {
  return system.store.obstacles.recordObstacleSighting(
    {
      what: input.what,
      kind: 'obstacle',
      keys: (input.keys ?? []).map((key) => ({ ...key, binds: true })),
      untilHours: null,
    },
    {
      agentId: `agent-${input.goalRef}`,
      taskId: `task-${input.goalRef}`,
      goalRef: input.goalRef,
      sessionId: null,
      transition: null,
      words: `${input.goalRef} hit it`,
      whyNotMine: 'nothing of mine is near it.',
    },
  ).obstacle.id;
}

async function nextMillisecond(): Promise<void> {
  const at = new Date().toISOString();
  while (new Date().toISOString() === at) await new Promise((resolve) => setImmediate(resolve));
}

function scripted(answer: unknown): { reader: ObstacleReader; seen: ObstacleReadingRequest[] } {
  const seen: ObstacleReadingRequest[] = [];
  return {
    seen,
    reader: (request) => {
      seen.push(request);
      return Promise.resolve(answer);
    },
  };
}

function deskFor(system: System, reader?: ObstacleReader): ObstacleModelDesk {
  return new ObstacleModelDesk({ store: system.store, reader, repoRoot: CWD });
}

test('a key the desk reads that another row already holds suggests a merge and never makes one', async () => {
  const system = build();
  const theirs = report(system, {
    what: 'a different thing entirely',
    goalRef: 'issue:2',
    keys: [
      { kind: 'check', value: 'test (windows)' },
      { kind: 'path', value: 'src/harness.ts' },
    ],
  });
  const mine = report(system, { what: 'the windows runner wedges', goalRef: 'issue:1' });
  assert.notEqual(mine, theirs);

  const { reader } = scripted({ keys: ['check:test (windows)', 'path:src/harness.ts'] });
  await deskFor(system, reader).run();

  assert.equal(system.store.obstacles.listObstacles().length, 2);
  assert.deepEqual(
    system.store.obstacles.listObstacleKeys(mine).map((key) => key.value),
    [],
  );
  assert.deepEqual(
    system.store.obstacles.listObstacleKeys(theirs).map((key) => key.value),
    ['test (windows)', 'src/harness.ts'],
  );
  assert.deepEqual(
    system.store.obstacles.listObstacleSuggestions(mine).map((row) => row.id),
    [theirs],
  );
});

test('a suggestion reaches the next reporter as a near match, by id, and merges nothing', () => {
  const system = build();
  const one = report(system, { what: 'one thing', goalRef: 'issue:1' });
  const two = report(system, { what: 'another thing', goalRef: 'issue:2' });
  system.store.obstacles.suggestObstacleMerge(one, two, 'model');

  const outcome = system.store.obstacles.recordObstacleSighting(
    { what: 'one thing', kind: 'obstacle', keys: [], untilHours: null },
    {
      agentId: 'agent-3',
      taskId: 'task-3',
      goalRef: 'issue:3',
      sessionId: null,
      transition: null,
      words: 'issue:3 hit it',
      whyNotMine: 'not mine.',
    },
  );
  assert.ok(outcome.near.some((row) => row.id === two || row.id === one));
  assert.equal(system.store.obstacles.getObstacle(one)?.id, one);
  assert.equal(system.store.obstacles.getObstacle(two)?.id, two);
});

test('a bare check from the desk does not bind, and a path that names nothing is dropped', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  const { reader } = scripted({
    keys: ['check:nobody-reports-this', 'path:src/there-is-no-such-file.ts', 'signature:boom at <n>'],
  });
  await deskFor(system, reader).run();

  assert.deepEqual(
    system.store.obstacles.listObstacleKeys(row).map((key) => key.value),
    ['boom at <n>'],
  );
  assert.equal(system.store.obstacles.listObstacleKeys(row)[0]!.binds, false);
  assert.equal(system.store.obstacles.getObstacle(row)?.what, 'something is red');
});

test("a path the desk reads is bound by the row's own grounded check, exactly as an agent's would be", async () => {
  const system = build();
  const row = report(system, {
    what: 'the windows runner wedges',
    goalRef: 'issue:1',
    keys: [{ kind: 'check', value: 'test (windows)' }],
  });
  const { reader } = scripted({ keys: ['path:src/harness.ts'] });
  await deskFor(system, reader).run();

  const added = system.store.obstacles.listObstacleKeys(row).find((key) => key.value === 'src/harness.ts');
  assert.ok(added);
  assert.equal(added.binds, true);
});

test('nothing the desk writes moves a state, takes an owner or resolves anything', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  const before = system.store.obstacles.getObstacle(row)!;
  const { reader } = scripted({
    keys: ['signature:boom'],
    near: [],
    purpose: 'ticket',
    ticket: { title: 'Fix: something is red', body: 'The fleet hit this.' },
  });
  await deskFor(system, reader).run();

  const after = system.store.obstacles.getObstacle(row)!;
  assert.equal(after.state, before.state);
  assert.equal(after.state, 'sighted');
  assert.equal(after.ownerRef, null);
  assert.equal(after.endedBy, null);
});

test('what a row is for is the kind column, and never one an owner is already on', async () => {
  const system = build();
  const key = [{ kind: 'path' as const, value: 'README.md' }];
  const row = report(system, { what: 'the readme disagrees with the code', goalRef: 'issue:1', keys: key });
  const docs = scripted({ purpose: 'docs' });
  await deskFor(system, docs.reader).run();
  assert.equal(system.store.obstacles.getObstacle(row)?.kind, 'note');

  report(system, { what: 'the readme disagrees with the code', goalRef: 'issue:2', keys: key });
  assert.equal(system.store.obstacles.getObstacle(row)?.state, 'standing');
  assert.equal(system.store.obstacles.claimObstacle(row), true);
  system.store.obstacles.setObstacleOwner(row, 'issue:900');
  assert.equal(system.store.obstacles.setObstacleKind(row, 'obstacle'), false);
  assert.equal(system.store.obstacles.getObstacle(row)?.kind, 'note');
});

test('the ticket the desk wrote is the ticket that is filed', async () => {
  const system = build();
  const key = [{ kind: 'path' as const, value: 'README.md' }];
  report(system, { what: 'the windows runner wedges', goalRef: 'issue:1', keys: key });
  const row = report(system, { what: 'the windows runner wedges', goalRef: 'issue:2', keys: key });
  const { reader } = scripted({
    purpose: 'ticket',
    ticket: { title: 'The windows runner wedges before the suite starts', body: 'Two goals lost a session to it.' },
  });
  await deskFor(system, reader).run();

  const filed: { title: string; body: string }[] = [];
  await new ObstacleOwnershipDesk({
    store: system.store,
    filing: async (input) => {
      filed.push(input as { title: string; body: string });
      return 'issue:841';
    },
    ticketBody: (vars) => `house style: ${vars.claim}`,
    watchLabel: 'lubbdubb-watch',
  }).run({ takenAt: new Date().toISOString(), pullRequests: [], issues: [] });

  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, 'The windows runner wedges before the suite starts');
  assert.equal(filed[0]!.body, 'Two goals lost a session to it.');
  assert.equal(system.store.obstacles.getObstacle(row)?.ownerRef, 'issue:841');
});

test('a board nobody has said anything new about calls no model at all', async () => {
  const system = build();
  const key = [{ kind: 'path' as const, value: 'README.md' }];
  const row = report(system, { what: 'something is red', goalRef: 'issue:1', keys: key });
  const first = scripted({ keys: [] });
  const desk = deskFor(system, first.reader);

  await desk.run();
  assert.equal(first.seen.length, 1);
  await desk.run();
  assert.equal(first.seen.length, 1);

  await nextMillisecond();
  report(system, { what: 'something is red', goalRef: 'issue:2', keys: key });
  assert.equal(
    system.store.obstacles.obstacleInbox().some(({ obstacle }) => obstacle.id === row),
    true,
  );
  await desk.run();
  assert.equal(first.seen.length, 2);
});

test("the harness's own words are never read as prose, and a row only it has said is not in the inbox", async () => {
  const system = build();
  system.store.obstacles.recordObstacleSighting(
    {
      what: '`test (windows)` is failing on branch `base/one`',
      kind: 'obstacle',
      keys: [{ kind: 'check', value: 'test (windows)', binds: true }],
      untilHours: null,
    },
    {
      agentId: null,
      taskId: null,
      goalRef: null,
      sessionId: null,
      transition: 'base-red:test (windows)@base/one',
      words: '`test (windows)` is failing on branch `base/one`',
      whyNotMine: null,
    },
  );
  const first = scripted({ keys: [] });
  await deskFor(system, first.reader).run();
  assert.deepEqual(first.seen, []);

  const row = system.store.obstacles.listObstacles()[0]!.id;
  const joined = report(system, {
    what: 'the windows runner wedges',
    goalRef: 'issue:1',
    keys: [
      { kind: 'check', value: 'test (windows)' },
      { kind: 'path', value: 'src/harness.ts' },
    ],
  });
  assert.equal(joined, row);
  const second = scripted({ keys: [] });
  await deskFor(system, second.reader).run();
  assert.equal(second.seen.length, 1);
  assert.deepEqual(
    second.seen[0]!.sightings.map((s) => s.goalRef),
    ['issue:1'],
  );
});

test('a reader that throws costs the reading and never the pulse', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  const desk = new ObstacleModelDesk({
    store: system.store,
    reader: () => Promise.reject(new Error('the model said no')),
    repoRoot: CWD,
    errors: system.errors,
  });
  await desk.run();
  assert.equal(
    system.store.obstacles.obstacleInbox().some(({ obstacle }) => obstacle.id === row),
    true,
  );
  assert.equal(system.store.obstacles.obstacleReading(row), null);
});

test('a deployment with no reader wired calls nothing and changes nothing', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  await deskFor(system).run();
  assert.equal(system.store.obstacles.obstacleReading(row), null);
  assert.deepEqual(system.store.obstacles.listObstacleKeys(row), []);
});

test('half a reading is kept in the half that arrived', () => {
  const parsed = parseObstacleReading(
    {
      keys: ['check:one', 'nonsense', 42],
      near: ['obs-real', 'obs-gone', 7],
      purpose: 'sideways',
      ticket: { title: '  ' },
    },
    new Set(['obs-real']),
  );
  assert.deepEqual(parsed.keys, [{ kind: 'check', value: 'one' }]);
  assert.deepEqual(parsed.near, ['obs-real']);
  assert.equal(parsed.purpose, null);
  assert.equal(parsed.title, null);
  assert.equal(parsed.body, null);
});

test('nothing at all is a reading with nothing in it, and never a throw', () => {
  const parsed = parseObstacleReading(null, new Set());
  assert.deepEqual(parsed, { keys: [], near: [], purpose: null, title: null, body: null });
});
