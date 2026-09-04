import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ObstacleOwnershipDesk } from '../src/obstacles/ownershipDesk.js';
import {
  ObstacleModelDesk,
  parseObstacleReading,
  type ObstacleReader,
  type ObstacleReadingRequest,
} from '../src/obstacles/desk.js';

/**
 * **A model may do anything whose mistakes are visible**, and the table in
 * `docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not` is
 * the whole permission list.
 *
 * The properties here are the ones that fail *silently* if this desk ever grows
 * past it: a merge it made would hide one agent's report inside another's — the
 * swallowed report answered *already owned*, nobody fixing it, nothing red — and a
 * key it slipped past the gates would do the same through the back door. Neither
 * shows up anywhere but here.
 */

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

/** One report, with whatever keys it was gated down to. */
function report(
  system: System,
  input: { what: string; goalRef: string; keys?: { kind: 'check' | 'path' | 'test'; value: string }[] },
): string {
  return system.store.recordObstacleSighting(
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

/**
 * Wait for the wall clock to leave the millisecond it is in.
 *
 * `obstacleInbox` is a **comparison and never a clock**: a row is back in the
 * inbox exactly when its `lastSeenAt` differs from the `read_at` the desk
 * recorded. Both are stamped from an ISO string, which is millisecond-resolution
 * — so two sightings inside one millisecond carry the *same* stamp, the second
 * one changes nothing the desk compares against, and the row does not come back.
 *
 * That is an edge in the store, not this test's subject. What the test is about is
 * that a further voice puts a read row back in the inbox, so it takes the clock
 * out of the question rather than failing one run in five on it. Bounded by a
 * millisecond, and it yields rather than spinning.
 */
async function nextMillisecond(): Promise<void> {
  const at = new Date().toISOString();
  while (new Date().toISOString() === at) await new Promise((resolve) => setImmediate(resolve));
}

/** A reader that answers with one canned reading and records what it was asked. */
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

// -- the one thing it may not do ----------------------------------------------

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
  // The newest row is the one the pass reads, and it is the one carrying no key
  // of its own — so every key the reading offers is one another row holds.
  const mine = report(system, { what: 'the windows runner wedges', goalRef: 'issue:1' });
  assert.notEqual(mine, theirs);

  const { reader } = scripted({ keys: ['check:test (windows)', 'path:src/harness.ts'] });
  await deskFor(system, reader).run();

  // Two rows in, two rows out. **Deciding two reports are one obstacle is the job
  // no model may do**, and a key arriving from one is not a back door to it.
  assert.equal(system.store.listObstacles().length, 2);
  assert.deepEqual(
    system.store.listObstacleKeys(mine).map((key) => key.value),
    [],
  );
  assert.deepEqual(
    system.store.listObstacleKeys(theirs).map((key) => key.value),
    ['test (windows)', 'src/harness.ts'],
  );
  // What it may do instead: say so, as a suggestion confirmed by id.
  assert.deepEqual(
    system.store.listObstacleSuggestions(mine).map((row) => row.id),
    [theirs],
  );
});

test('a suggestion reaches the next reporter as a near match, by id, and merges nothing', () => {
  const system = build();
  const one = report(system, { what: 'one thing', goalRef: 'issue:1' });
  const two = report(system, { what: 'another thing', goalRef: 'issue:2' });
  system.store.suggestObstacleMerge(one, two, 'model');

  const outcome = system.store.recordObstacleSighting(
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
  // The report landed where the keys put it — nothing followed the suggestion —
  // and the neighbour is offered by id for the agent to agree with, or not.
  assert.ok(outcome.near.some((row) => row.id === two || row.id === one));
  assert.equal(system.store.getObstacle(one)?.id, one);
  assert.equal(system.store.getObstacle(two)?.id, two);
});

// -- the same three gates -----------------------------------------------------

test('a bare check from the desk does not bind, and a path that names nothing is dropped', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  const { reader } = scripted({
    keys: ['check:nobody-reports-this', 'path:src/there-is-no-such-file.ts', 'signature:boom at <n>'],
  });
  await deskFor(system, reader).run();

  // Validation drops both — no provider is reporting that check and the tree has
  // no such file — and **the row is kept**, which is the gates' one direction.
  assert.deepEqual(
    system.store.listObstacleKeys(row).map((key) => key.value),
    ['boom at <n>'],
  );
  // A signature never binds, from this door as from every other.
  assert.equal(system.store.listObstacleKeys(row)[0]!.binds, false);
  assert.equal(system.store.getObstacle(row)?.what, 'something is red');
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

  const added = system.store.listObstacleKeys(row).find((key) => key.value === 'src/harness.ts');
  assert.ok(added);
  assert.equal(added.binds, true);
});

// -- it is a secretary, not a judge -------------------------------------------

test('nothing the desk writes moves a state, takes an owner or resolves anything', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  const before = system.store.getObstacle(row)!;
  const { reader } = scripted({
    keys: ['signature:boom'],
    near: [],
    purpose: 'ticket',
    ticket: { title: 'Fix: something is red', body: 'The fleet hit this.' },
  });
  await deskFor(system, reader).run();

  const after = system.store.getObstacle(row)!;
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
  // A wrong ticket is a ticket, and a documentation change is a pull request:
  // both are visible, which is why the door is a model's to choose.
  assert.equal(system.store.getObstacle(row)?.kind, 'note');

  // Owned is where it stops. Pulling a ticket out from under an agent dispatched
  // for it would be the one thing a reading may never do.
  report(system, { what: 'the readme disagrees with the code', goalRef: 'issue:2', keys: key });
  assert.equal(system.store.getObstacle(row)?.state, 'standing');
  assert.equal(system.store.claimObstacle(row), true);
  system.store.setObstacleOwner(row, 'issue:900');
  assert.equal(system.store.setObstacleKind(row, 'obstacle'), false);
  assert.equal(system.store.getObstacle(row)?.kind, 'note');
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
    // The house style is still there and still rendered — it is what a deployment
    // with no reader gets, and what this row would have got yesterday.
    ticketBody: (vars) => `house style: ${vars.claim}`,
    watchLabel: 'lubbdubb-watch',
  }).run({ takenAt: new Date().toISOString(), pullRequests: [], issues: [] });

  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, 'The windows runner wedges before the suite starts');
  assert.equal(filed[0]!.body, 'Two goals lost a session to it.');
  assert.equal(system.store.getObstacle(row)?.ownerRef, 'issue:841');
});

// -- the inbox ----------------------------------------------------------------

test('a board nobody has said anything new about calls no model at all', async () => {
  const system = build();
  const key = [{ kind: 'path' as const, value: 'README.md' }];
  const row = report(system, { what: 'something is red', goalRef: 'issue:1', keys: key });
  const first = scripted({ keys: [] });
  const desk = deskFor(system, first.reader);

  await desk.run();
  assert.equal(first.seen.length, 1);
  // Read once. A second pulse over an unchanged board is a pulse that calls
  // nothing — which is the whole of "only where the inbox is non-empty".
  await desk.run();
  assert.equal(first.seen.length, 1);

  // A further voice landing words on the row puts it back in the inbox: the words
  // that arrived are the only thing there is anything new to read. In a later
  // millisecond than the reading above, because that is what the inbox compares —
  // see `nextMillisecond`.
  await nextMillisecond();
  report(system, { what: 'something is red', goalRef: 'issue:2', keys: key });
  assert.equal(
    system.store.obstacleInbox().some(({ obstacle }) => obstacle.id === row),
    true,
  );
  await desk.run();
  assert.equal(first.seen.length, 2);
});

test("the harness's own words are never read as prose, and a row only it has said is not in the inbox", async () => {
  const system = build();
  // A harness voice: no agent, no goal, and the transition it saw in their place.
  system.store.recordObstacleSighting(
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
  // Nothing to read. Extraction is a language judgement over an *agent's* prose,
  // and a pass over the harness's own sentence would turn the branch name in it
  // into a key the check beside it grounds — the harness reaching `standing`
  // alone, through the one door the rest of the rules do not cover.
  assert.deepEqual(first.seen, []);

  // An agent joining that row puts it in the inbox — carrying that agent's words,
  // and only that agent's.
  const row = system.store.listObstacles()[0]!.id;
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
  // Recorded, not thrown — and the row is still unread, so the next pulse tries.
  assert.equal(
    system.store.obstacleInbox().some(({ obstacle }) => obstacle.id === row),
    true,
  );
  assert.equal(system.store.obstacleReading(row), null);
});

test('a deployment with no reader wired calls nothing and changes nothing', async () => {
  const system = build();
  const row = report(system, { what: 'something is red', goalRef: 'issue:1' });
  await deskFor(system).run();
  assert.equal(system.store.obstacleReading(row), null);
  assert.deepEqual(system.store.listObstacleKeys(row), []);
});

// -- the reading itself -------------------------------------------------------

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
  // Dropped and kept, the gates' rule one door further out.
  assert.deepEqual(parsed.keys, [{ kind: 'check', value: 'one' }]);
  // An id naming nothing on the board is a row nobody could ever confirm.
  assert.deepEqual(parsed.near, ['obs-real']);
  assert.equal(parsed.purpose, null);
  assert.equal(parsed.title, null);
  assert.equal(parsed.body, null);
});

test('nothing at all is a reading with nothing in it, and never a throw', () => {
  const parsed = parseObstacleReading(null, new Set());
  assert.deepEqual(parsed, { keys: [], near: [], purpose: null, title: null, body: null });
});
