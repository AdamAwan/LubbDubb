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
import type { Issue, IssueRelative, PullRequest, TrackerItem } from '../src/types.js';
import type { TicketsPayload } from '../src/wire.js';

// The cockpit draws the watch toggle from `/api/state`, which serves the world
// baseline and never a live provider read (16). So a tag the provider has just
// accepted stays invisible until something writes it onto that baseline — and
// the pulse cannot be that something: `runCycle` coalesces while a cycle is in
// flight, so the click that lands during one is followed by no world read at
// all and the button keeps its old state until the next beat. Every test here
// clicks with a cycle parked mid-read, which is that case, and asserts on what
// the cockpit's next refetch would draw.
//
// The Tickets tab is a *second* reader of the same tag and has to be asserted
// separately: it draws from `/api/tickets`, built from the mirror rather than
// the baseline, and the mirror's own writer — `TicketSweep` — runs last in the
// very cycle that coalesced. It is also the one surface carrying an explicit
// Unwatch, so a stale reading there is what an operator reports as a ticket
// they cannot un-watch (issue #417).

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

function pullRequest(over: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    id: `p${over.number}`,
    title: `PR ${over.number}`,
    branch: `feat/${over.number}`,
    baseBranch: 'main',
    ciStatus: 'passing',
    unresolvedComments: [],
    labels: [],
    ...over,
  };
}

function relative(number: number): IssueRelative {
  return { number, title: `Item ${number}`, issueType: 'User Story', workItemState: 'Active', state: 'open' };
}

function seed(system: System): void {
  system.store.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [pullRequest({ number: 50 }), pullRequest({ number: 51, labels: ['lubbdubb-watch'] })],
    closedPullRequests: [],
    issues: [
      issue({ number: 1, issueType: 'Feature', children: [relative(2)] }),
      issue({ number: 2, issueType: 'User Story' }),
      issue({ number: 9, issueType: 'User Story', labels: ['lubbdubb-watch'] }),
    ],
  });
}

/**
 * A cycle parked with its world read outstanding — the ordinary shape of a busy
 * harness, and the one where the `runCycle('manual')` a watch route ends with
 * answers "coalesced" and reads nothing. Returns the release.
 */
function parkCycle(system: System): () => Promise<void> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const read = system.connector.getState.bind(system.connector);
  system.connector.getState = async () => {
    const world = await read();
    await held;
    return world;
  };
  const cycle = system.harness.runCycle('timer');
  return async () => {
    release();
    await cycle;
  };
}

type App = Awaited<ReturnType<typeof buildApp>>['app'];

/** The labels `/api/state` would draw the toggle from, for one issue. */
async function issueLabels(app: App, number: number): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/state' });
  const body = res.json() as { world: { issues: { number: number; labels?: string[] }[] } };
  return body.world.issues.find((i) => i.number === number)?.labels ?? [];
}

/** The same, for a pull request. */
async function prLabels(app: App, number: number): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/state' });
  const body = res.json() as { world: { pullRequests: { number: number; labels?: string[] }[] } };
  return body.world.pullRequests.find((p) => p.number === number)?.labels ?? [];
}

/** One mirrored row, as a sweep would have written it. */
function tracked(number: number, labels: string[]): TrackerItem {
  return {
    number,
    title: `Item ${number}`,
    labels,
    state: 'open',
    workItemState: null,
    url: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
  };
}

/** Put the seeded issues in the mirror too, which is what the Tickets tab reads. */
function seedMirror(system: System): void {
  system.store.ensureTrackerSweep(30 * 24 * 60 * 60 * 1000);
  system.store.recordSweep('2026-07-01T00:00:00.000Z', [
    tracked(1, []),
    tracked(2, []),
    tracked(9, ['lubbdubb-watch']),
  ]);
}

/** The bucket the Tickets tab would draw for one row, and what its filter says. */
async function ticketWatch(app: App, number: number): Promise<string | undefined> {
  const res = await app.inject({ method: 'GET', url: '/api/tickets' });
  return (res.json() as TicketsPayload).rows.find((r) => r.number === number)?.watch;
}

/** The numbers one watch filter returns — the other half of the same reading. */
async function ticketsFiltered(app: App, watch: 'watched' | 'unwatched'): Promise<number[]> {
  const res = await app.inject({ method: 'GET', url: `/api/tickets?watch=${watch}` });
  return (res.json() as TicketsPayload).rows.map((r) => r.number);
}

test('watching an issue shows on the very next state read', async () => {
  const system = build();
  seed(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/2/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await issueLabels(app, 2), ['lubbdubb-watch']);
  await finish();
});

test('un-watching an issue shows on the very next state read', async () => {
  const system = build();
  seed(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/9/watch', payload: { watched: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await issueLabels(app, 9), []);
  await finish();
});

test('the cascade is visible too, not just the item clicked', async () => {
  const system = build();
  seed(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await issueLabels(app, 1), ['lubbdubb-watch']);
  assert.deepEqual(await issueLabels(app, 2), ['lubbdubb-watch']);
  await finish();
});

test('only the items whose write landed are patched', async () => {
  const system = build();
  seed(system);
  const connector = system.connector as unknown as {
    setIssueLabel: (input: { number: number; label: string; present: boolean }) => Promise<unknown>;
  };
  const write = connector.setIssueLabel.bind(connector);
  connector.setIssueLabel = async (input) => {
    if (input.number === 2) throw new Error('work item 2 is locked');
    return write(input);
  };
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(await issueLabels(app, 1), ['lubbdubb-watch']);
  assert.deepEqual(await issueLabels(app, 2), []);
  await finish();
});

test('watching a pull request shows on the very next state read', async () => {
  const system = build();
  seed(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/prs/50/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await prLabels(app, 50), ['lubbdubb-watch']);
  await finish();
});

test('un-watching a pull request shows on the very next state read', async () => {
  const system = build();
  seed(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/prs/51/watch', payload: { watched: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await prLabels(app, 51), []);
  await finish();
});

test('the ownership view of the tag moves with it, or pickup and the toggle disagree', async () => {
  const system = build();
  system.store.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [issue({ number: 7, issueType: 'User Story', labelsAddedByViewer: [] })],
  });
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/7/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  const state = await app.inject({ method: 'GET', url: '/api/state' });
  const body = state.json() as { world: { issues: { number: number; labelsAddedByViewer?: string[] }[] } };
  assert.deepEqual(body.world.issues.find((i) => i.number === 7)?.labelsAddedByViewer, ['lubbdubb-watch']);
  await finish();
});

test('the gate switched off writes no empty tag onto the baseline', async () => {
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
  seed(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/2/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await issueLabels(app, 2), []);
  await finish();
});

// ---------------------------------------------------------------------------
// The Tickets tab's reading of the same tag (issue #417)
// ---------------------------------------------------------------------------

test('un-watching shows on the very next tickets read, not a sweep later', async () => {
  const system = build();
  seed(system);
  seedMirror(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/9/watch', payload: { watched: false } });
  assert.equal(res.statusCode, 200);
  assert.equal(await ticketWatch(app, 9), 'unwatched', 'the row the operator just un-watched still reads watched');
  await finish();
});

test('the watch filter moves with the row, or the item is un-watched and unfindable', async () => {
  const system = build();
  seed(system);
  seedMirror(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  await app.inject({ method: 'POST', url: '/api/issues/9/watch', payload: { watched: false } });
  assert.deepEqual(await ticketsFiltered(app, 'unwatched'), [9, 2, 1]);
  assert.deepEqual(await ticketsFiltered(app, 'watched'), []);
  await finish();
});

test('watching shows there too, and cascades onto the children in the mirror', async () => {
  const system = build();
  seed(system);
  seedMirror(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(await ticketWatch(app, 1), 'watched');
  assert.equal(await ticketWatch(app, 2), 'watched', 'the cascade reaches the mirror as well as the baseline');
  await finish();
});

test('only the items whose write landed are patched in the mirror', async () => {
  const system = build();
  seed(system);
  seedMirror(system);
  const connector = system.connector as unknown as {
    setIssueLabel: (input: { number: number; label: string; present: boolean }) => Promise<unknown>;
  };
  const write = connector.setIssueLabel.bind(connector);
  connector.setIssueLabel = async (input) => {
    if (input.number === 2) throw new Error('work item 2 is locked');
    return write(input);
  };
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/1/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 400);
  assert.equal(await ticketWatch(app, 1), 'watched');
  assert.equal(await ticketWatch(app, 2), 'unwatched', 'a refused write must not show as a tag on the tab either');
  await finish();
});

test('an item the mirror has never seen is skipped rather than invented', async () => {
  const system = build();
  seed(system);
  seedMirror(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  // #9 is in the mirror; a number it has never swept is not, and the tab must not
  // grow a row for it — this table is a record of what the tracker handed us.
  const before = (await app.inject({ method: 'GET', url: '/api/tickets' })).json() as TicketsPayload;
  system.store.patchTicketLabels({ numbers: [4242], label: 'lubbdubb-watch', present: true });
  const after = (await app.inject({ method: 'GET', url: '/api/tickets' })).json() as TicketsPayload;
  assert.deepEqual(
    after.rows.map((r) => r.number),
    before.rows.map((r) => r.number),
  );
  await finish();
});

test('the gate switched off writes no empty tag onto the mirror either', async () => {
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
  seed(system);
  seedMirror(system);
  const { app } = await buildApp(system);
  const finish = parkCycle(system);

  const res = await app.inject({ method: 'POST', url: '/api/issues/2/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  const page = (await app.inject({ method: 'GET', url: '/api/tickets' })).json() as TicketsPayload;
  assert.deepEqual(page.rows.find((r) => r.number === 2)?.labels, []);
  await finish();
});
