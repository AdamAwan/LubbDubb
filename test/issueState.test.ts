import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { CockpitState, TicketsPayload } from '../src/wire.js';
import type { TrackerItem, WorldSnapshot } from '../src/types.js';

/**
 * The two halves of one confirmed state write — the baseline `/api/state` serves,
 * and the mirror the Tickets tab is built from.
 *
 * Both are patched for the reason the label pair documents: the baseline is what the
 * cockpit redraws from, and the sweep that would carry the mirror runs last in a
 * cycle that coalesces away while another is in flight. Only ever called for a write
 * the provider took, so each is observed fact arriving early rather than a guess.
 */

const SINCE = '2026-07-01T00:00:00.000Z';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function item(over: Partial<TrackerItem> & Pick<TrackerItem, 'number'>): TrackerItem {
  return {
    title: `Ticket ${over.number}`,
    labels: [],
    state: 'open',
    workItemState: null,
    url: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function world(): WorldSnapshot {
  return {
    takenAt: '2026-08-01T00:00:00.000Z',
    pullRequests: [],
    closedPullRequests: [],
    issues: [
      { id: 'issue_a', number: 5, title: 'Five', body: '', labels: [], state: 'open', linkedPrNumber: null },
      { id: 'issue_b', number: 6, title: 'Six', body: '', labels: [], state: 'open', linkedPrNumber: null },
    ],
  } as unknown as WorldSnapshot;
}

test('a confirmed state lands on the baseline, and only on the item named', () => {
  const store = new Store(':memory:');
  store.setWorldBaseline(world());

  store.patchWorldState({ number: 5, state: 'In Review' });

  const after = store.getWorldBaseline();
  assert.equal(after?.issues.find((i) => i.number === 5)?.workItemState, 'In Review');
  assert.equal(
    after?.issues.find((i) => i.number === 6)?.workItemState,
    undefined,
    'an item nobody moved is untouched',
  );
  store.close();
});

test('an item the baseline no longer holds is skipped rather than invented', () => {
  const store = new Store(':memory:');
  store.setWorldBaseline(world());
  // The world this came from has aged out. Inventing a row would put an issue in
  // the cockpit that no snapshot ever described.
  store.patchWorldState({ number: 99, state: 'Doing' });
  assert.equal(store.getWorldBaseline()?.issues.length, 2);
  store.close();
});

test('the same write lands on the mirror, which is what the board’s columns are built from', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(SINCE, [item({ number: 5, workItemState: 'Ready' }), item({ number: 6 })]);

  store.patchTicketState({ number: 5, state: 'In Review' });

  const rows = store.listTrackerItems();
  assert.equal(rows.find((r) => r.number === 5)?.workItemState, 'In Review');
  assert.equal(rows.find((r) => r.number === 6)?.workItemState, null, 'and nothing else moves');
  store.close();
});

test('a number the mirror does not hold is skipped — the mirror is a record of what was seen', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(SINCE, [item({ number: 5 })]);
  store.patchTicketState({ number: 99, state: 'Doing' });
  assert.deepEqual(
    store.listTrackerItems().map((r) => r.number),
    [5],
  );
  store.close();
});

// ---------------------------------------------------------------------------
// The route, at the buildSystem seam
// ---------------------------------------------------------------------------

function boardSystem() {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
    issuePickupStates: ['Ready'],
    issueInReviewState: 'In Review',
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

test('POST /api/issues/:number/state writes the tracker and patches both readings', async () => {
  const system = boardSystem();
  system.connector.inject({ kind: 'new_issue', number: 30, title: 'Drag me' });
  await system.connector.setWorkItemState({ number: 30, state: 'Ready' });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const moved = await app.inject({
    method: 'POST',
    url: '/api/issues/30/state',
    payload: { state: 'In Review' },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(moved.json(), { ok: true, state: 'In Review' });

  // The baseline, which is what `/api/state` serves and the cockpit redraws from.
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json() as CockpitState;
  assert.equal(state.world.issues.find((i) => i.number === 30)?.workItemState, 'In Review');

  // And the mirror, which is what the board's own columns are built from. Asserted
  // separately because they are two readings, and patching only one is the bug.
  const page = (await app.inject({ method: 'GET', url: '/api/tickets?tracking=any' })).json() as TicketsPayload;
  assert.equal(page.rows.find((r) => r.number === 30)?.workItemState, 'In Review');
});

test('a provider refusal is quoted back as a 400, and neither reading moves', async () => {
  const system = boardSystem();
  system.connector.inject({ kind: 'new_issue', number: 31, title: 'Refused' });
  await system.connector.setWorkItemState({ number: 31, state: 'Ready' });
  await system.harness.runCycle('manual');

  // The provider is the authority on its own process template, so the refusal is
  // the provider's sentence rather than a guess this route made first.
  system.connector.setWorkItemState = () => Promise.reject(new Error('TF401347: invalid transition'));

  const { app } = await buildApp(system);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/issues/31/state',
    payload: { state: 'Nonsense' },
  });
  assert.equal(refused.statusCode, 400);
  assert.match((refused.json() as { error: string }).error, /invalid transition/);

  const page = (await app.inject({ method: 'GET', url: '/api/tickets?tracking=any' })).json() as TicketsPayload;
  assert.equal(page.rows.find((r) => r.number === 31)?.workItemState, 'Ready', 'the mirror is untouched');
  // A refusal is recorded, never swallowed.
  assert.ok(system.store.listErrors().some((e) => /invalid transition/.test(e.message)));
});

test('a provider that cannot write states refuses by saying so, and never reaches the sink', async () => {
  const system = boardSystem();
  system.connector.inject({ kind: 'new_issue', number: 32, title: 'No capability' });
  await system.harness.runCycle('manual');

  let called = false;
  system.connector.canSetWorkItemState = () => false;
  system.connector.setWorkItemState = () => {
    called = true;
    return Promise.resolve({ ok: true });
  };

  const { app } = await buildApp(system);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/issues/32/state',
    payload: { state: 'In Review' },
  });
  assert.equal(refused.statusCode, 400);
  assert.match((refused.json() as { error: string }).error, /cannot write/i);
  assert.equal(called, false, 'the throwing seam is never reached');
});

test('an empty state is refused by the schema, not sent to the provider as a blank', async () => {
  const system = boardSystem();
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const refused = await app.inject({ method: 'POST', url: '/api/issues/33/state', payload: { state: '' } });
  assert.equal(refused.statusCode, 400);
});
