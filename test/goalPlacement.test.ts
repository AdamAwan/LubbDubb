import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { AreaPathDirectory } from '../src/intake/areaPaths.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import { normalizeAreaPath, placementAsks, truncateAreaPaths, type AreaPathTree } from '../src/intake/placement.js';
import { validateGoalAssay } from '../src/mcp/goalAssay.js';
import { goalFingerprint } from '../src/intake/assay.js';
import { AzureDevOpsWorkItemsIntegration } from '../src/integrations/azure/workItems.js';
import type { AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { Issue, IssueAssay, WorldSnapshot } from '../src/types.js';

/**
 * Where a goal belongs on the backlog — the parent it rolls up to and the area
 * node that puts it on a board — proposed by the assay and settled by one click.
 *
 * The failure this exists to stop is silent by construction: the work is done
 * correctly and the ticket is invisible to whoever plans the backlog. So the tests
 * here lean on the two readings that are themselves silent when wrong — an area
 * path compared against the wrong thing (an item is never *without* one), and a
 * question whose visibility outlives the fact it was asked about.
 */

const TREE: AreaPathTree = { root: 'Contoso', paths: ['Contoso\\Web', 'Contoso\\Web\\Checkout', 'Contoso\\Billing'] };

function assay(over: Partial<IssueAssay> = {}): IssueAssay {
  return {
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'Reconcile the statement totals.',
    goalRef: 'abc123',
    by: 'assayer',
    proposedProfile: null,
    profileAnsweredAt: null,
    proposedParent: null,
    parentSettledAt: null,
    proposedAreaPath: null,
    areaPathSettledAt: null,
    agentId: 'agent_1',
    taskId: 'task_1',
    commentRef: null,
    decidedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Reconcile statements',
    body: 'body',
    labels: [],
    state: 'open',
    issueType: 'User Story',
    parent: null,
    areaPath: 'Contoso',
    linkedPrNumber: null,
    ...over,
  };
}

// -- the two readings, and what ends them ------------------------------------

test('a proposal is asked while the live item still lacks the field, and not after', () => {
  const proposed = assay({ proposedParent: 345, proposedAreaPath: 'Contoso\\Web' });

  const both = placementAsks(proposed, issue(), TREE, 'abc123');
  assert.deepEqual(
    both.map((a) => a.field),
    ['parent', 'areaPath'],
    'both questions are open, parent first',
  );

  // The whole of "derived visibility": an operator who sets the field by hand in
  // the tracker ends the question on the next world read, with nothing written
  // here and no event to have witnessed.
  const parented = issue({
    parent: {
      number: 345,
      title: 'Statement reconciliation',
      issueType: 'Feature',
      workItemState: 'Active',
      state: 'open',
    },
  });
  assert.deepEqual(
    placementAsks(proposed, parented, TREE, 'abc123').map((a) => a.field),
    ['areaPath'],
  );
  assert.deepEqual(
    placementAsks(proposed, parented, TREE, 'abc123').map((a) => a.proposedAreaPath),
    ['Contoso\\Web'],
  );

  const filed = issue({ areaPath: 'Contoso\\Billing' });
  assert.deepEqual(
    placementAsks(proposed, filed, TREE, 'abc123').map((a) => a.field),
    ['parent'],
  );
});

test('an unclassified item is one on the project root, not one with an empty area path', () => {
  const proposed = assay({ proposedAreaPath: 'Contoso\\Web' });
  assert.equal(placementAsks(proposed, issue({ areaPath: 'Contoso' }), TREE, 'abc123').length, 1);
  // The separator and the casing are the provider's, not a value: an item filed
  // under the root by a client that wrote it either way is still unfiled, and a
  // reader comparing raw strings would report every classified item as
  // unclassified — or this one as classified — with nothing red.
  assert.equal(placementAsks(proposed, issue({ areaPath: 'contoso/' }), TREE, 'abc123').length, 1);
  assert.equal(placementAsks(proposed, issue({ areaPath: 'Contoso\\Web' }), TREE, 'abc123').length, 0);
  assert.equal(normalizeAreaPath('Contoso/Web'), normalizeAreaPath('contoso\\web\\'));
});

test('nothing is asked without a tree, on a flat tracker, or against superseded goal text', () => {
  const proposed = assay({ proposedParent: 345, proposedAreaPath: 'Contoso\\Web' });
  assert.deepEqual(
    placementAsks(proposed, issue(), null, 'abc123').map((a) => a.field),
    ['parent'],
    'with no tree the harness cannot say what unclassified means, so it does not guess',
  );
  assert.deepEqual(
    placementAsks(proposed, issue({ parent: undefined, areaPath: undefined }), null, 'abc123'),
    [],
    'a provider that tracks neither is never missing either',
  );
  assert.deepEqual(
    placementAsks(proposed, issue(), TREE, 'a-rewritten-ticket'),
    [],
    'a verdict about text the ticket no longer has asks nothing until it is assayed again',
  );
  assert.deepEqual(placementAsks(null, issue(), TREE, 'abc123'), []);
});

test('a settled question stays settled, whichever of the three answers it got', () => {
  const proposed = assay({ proposedParent: 345, proposedAreaPath: 'Contoso\\Web' });
  const settled = { ...proposed, parentSettledAt: '2026-08-02T00:00:00.000Z' };
  assert.deepEqual(
    placementAsks(settled, issue(), TREE, 'abc123').map((a) => a.field),
    ['areaPath'],
    'the operator said this goal wants no parent, and it changed nothing out there to notice',
  );
});

// -- the offer ---------------------------------------------------------------

test('the area offer is capped, and says how much it left out', () => {
  const many = { root: 'P', paths: Array.from({ length: 60 }, (_, i) => `P\\Team${i}`) };
  const { paths, omitted } = truncateAreaPaths(many);
  assert.equal(paths.length, 40);
  assert.equal(omitted, 20, 'a cut list read as the complete set is the failure the count exists to stop');
  assert.deepEqual(truncateAreaPaths(TREE), { paths: TREE.paths, omitted: 0 });
});

test('the assay tool takes a parent freely and an area path only from the offer', () => {
  const base = { status: 'workable', summary: 'clear enough' };

  const free = validateGoalAssay({ ...base, parent: 345 }, [], TREE.paths);
  assert.equal(free.ok && free.parent, 345);
  // A container the harness never listed is still a legal answer: the board it can
  // see is narrowed by tag and assignee, so the right parent is often not in it.
  assert.equal(validateGoalAssay({ ...base, parent: '#9001' }, [], TREE.paths).ok, true);
  assert.equal(validateGoalAssay({ ...base, parent: 'the billing feature' }, [], TREE.paths).ok, false);

  const chosen = validateGoalAssay({ ...base, area_path: 'contoso/web' }, [], TREE.paths);
  assert.equal(
    chosen.ok && chosen.areaPath,
    'Contoso\\Web',
    "answered in the provider's own spelling, since that is the string the write has to carry",
  );
  assert.equal(validateGoalAssay({ ...base, area_path: 'Contoso\\Payments' }, [], TREE.paths).ok, false);
  assert.equal(
    validateGoalAssay({ ...base, area_path: 'Contoso\\Web' }, [], []).ok,
    true,
    'a deployment whose tree the harness could not read asks nothing and refuses nothing',
  );

  const unclear = validateGoalAssay(
    { status: 'unclear', summary: 'no idea', parent: 345, area_path: 'Contoso\\Web' },
    [],
    TREE.paths,
  );
  assert.equal(unclear.ok && unclear.parent, null);
  assert.equal(unclear.ok && unclear.areaPath, null);
});

// -- the store ---------------------------------------------------------------

test('a placement proposal round-trips, is settled per field, and is re-asked after a re-assay', () => {
  const store = new Store(':memory:');
  try {
    store.recordAssay({
      originRef: 'issue:12',
      verdict: 'workable',
      summary: 's',
      goalRef: 'abc123',
      by: 'assayer',
      proposedParent: 345,
      proposedAreaPath: 'Contoso\\Web',
    });
    const stored = store.getAssay('issue:12');
    assert.equal(stored?.proposedParent, 345);
    assert.equal(stored?.proposedAreaPath, 'Contoso\\Web');
    assert.equal(stored?.parentSettledAt, null);

    assert.equal(store.settleAssayPlacement('issue:12', 'not-the-text-they-read', 'parent'), false);
    assert.equal(store.settleAssayPlacement('issue:12', 'abc123', 'parent'), true);
    assert.equal(store.settleAssayPlacement('issue:12', 'abc123', 'parent'), false, 'settling twice settles once');
    const half = store.getAssay('issue:12');
    assert.notEqual(half?.parentSettledAt, null);
    assert.equal(half?.areaPathSettledAt, null, 'the other question is untouched');

    // A rewritten ticket is a fresh reading, so the answer to the old one does not
    // carry over — the one signal that a dismissal may no longer be right.
    store.recordAssay({
      originRef: 'issue:12',
      verdict: 'workable',
      summary: 's',
      goalRef: 'rewritten',
      by: 'assayer',
      proposedParent: 777,
    });
    const again = store.getAssay('issue:12');
    assert.equal(again?.parentSettledAt, null);
    assert.equal(again?.proposedParent, 777);
  } finally {
    store.close();
  }
});

// -- the directory -----------------------------------------------------------

test('the area directory reads once per TTL and keeps the last good tree on a failure', async () => {
  let reads = 0;
  let fail = false;
  let clock = 1000;
  const errors: string[] = [];
  const directory = new AreaPathDirectory(
    {
      listAreaPaths: async () => {
        reads += 1;
        if (fail) throw new Error('token expired');
        return TREE;
      },
    },
    {
      now: () => clock,
      ttlMs: 100,
      // Only the message is read here; the entry an `ErrorRecorder` returns is
      // for the cockpit's stream and nothing in this path looks at it.
      errors: { record: ((e: { message: string }) => errors.push(e.message)) as unknown as ErrorRecorder['record'] },
    },
  );

  assert.equal(directory.current(), null, 'nothing is offered before the first read lands');
  await directory.refresh();
  assert.deepEqual(directory.current(), TREE);
  await directory.refresh();
  assert.equal(reads, 1, 'a tree inside its TTL is not re-read');

  clock += 200;
  fail = true;
  await directory.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(
    directory.current(),
    TREE,
    'a failed read leaves the last good tree standing — emptying it would read as "this project has no areas"',
  );
  assert.equal(errors.length, 1, 'and the failure is recorded rather than swallowed');
});

// -- the Azure write ---------------------------------------------------------

test('the Azure integration writes a parent as a hierarchy relation and an area path as a field', async () => {
  const calls: string[] = [];
  const api = {
    setWorkItemParent: async (id: number, parentId: number) => void calls.push(`parent:${id}->${parentId}`),
    setWorkItemAreaPath: async (id: number, areaPath: string) => void calls.push(`area:${id}->${areaPath}`),
    listAreaPaths: async () => TREE,
  } as unknown as AzureDevOpsApi;
  const integration = new AzureDevOpsWorkItemsIntegration({
    api,
    organization: 'contoso',
    project: 'Contoso',
    repository: 'web',
  });

  assert.deepEqual(await integration.listAreaPaths(), TREE);
  await integration.setWorkItemParent({ number: 12, parentNumber: 345 });
  await integration.setWorkItemAreaPath({ number: 12, areaPath: 'Contoso\\Web' });
  assert.deepEqual(calls, ['parent:12->345', 'area:12->Contoso\\Web']);
});

// -- the whole wiring, at the buildSystem seam -------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-placement-'));
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
  // The fake tracker deliberately has neither field — that is the whole of how a
  // flat provider behaves here — so the placement seam is stood up on the instance
  // rather than by configuring a provider that would then be lying about itself.
  const placed: string[] = [];
  system.connector.canPlaceWorkItem = () => true;
  system.connector.setWorkItemParent = async (input) => {
    placed.push(`parent:${input.number}->${input.parentNumber}`);
    return { ok: true };
  };
  system.connector.setWorkItemAreaPath = async (input) => {
    placed.push(`area:${input.number}->${input.areaPath}`);
    return { ok: true };
  };
  system.connector.listAreaPaths = async () => TREE;
  (system as System & { placed: string[] }).placed = placed;
  return system;
}

function worldWith(system: System, over: Partial<Issue> = {}): void {
  system.store.setWorldBaseline({
    takenAt: '2026-08-01T00:00:00.000Z',
    pullRequests: [],
    closedPullRequests: [],
    issues: [issue(over)],
  } as unknown as WorldSnapshot);
}

test('a proposal reaches the cockpit only while it stands, and one click settles it', async () => {
  const system = build();
  const placed = (system as System & { placed: string[] }).placed;
  await system.areaPaths.refresh();
  worldWith(system);
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'Reconcile the statement totals.',
    goalRef: goalRefOf(system),
    by: 'assayer',
    proposedParent: 345,
    proposedAreaPath: 'Contoso\\Web',
  });

  const { app } = await buildApp(system);
  try {
    const before = buildStateSnapshot(system);
    const asks = before.world.issues.find((i) => i.number === 12)?.assay?.placement ?? [];
    assert.deepEqual(
      asks.map((a) => a.field),
      ['parent', 'areaPath'],
      'both questions ship, derived from the live item rather than from anything stored',
    );
    assert.deepEqual(before.config.areaPaths, TREE.paths, 'and the operator is offered the same nodes the assayer was');

    const answered = await app.inject({ method: 'POST', url: '/api/issues/12/parent', payload: { parent: 345 } });
    assert.equal(answered.statusCode, 200);
    assert.deepEqual(placed, ['parent:12->345'], 'the write is the harness’s, through the sink');
    assert.notEqual(system.store.getAssay('issue:12')?.parentSettledAt, null);

    const dismissed = await app.inject({ method: 'POST', url: '/api/issues/12/area-path', payload: {} });
    assert.equal(dismissed.statusCode, 200);
    assert.deepEqual(placed, ['parent:12->345'], 'and "not applicable" writes nothing to the tracker at all');
    assert.notEqual(system.store.getAssay('issue:12')?.areaPathSettledAt, null);

    // Re-seeded with the item exactly as it was — still unparented, still on the
    // root — because that is the state the stamp exists for: the derived read is a
    // pulse behind the write, and a question that came back for one refresh would
    // read as a click that did not take.
    worldWith(system);
    const after = buildStateSnapshot(system);
    assert.deepEqual(after.world.issues.find((i) => i.number === 12)?.assay?.placement, []);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('nothing is drawn where nothing can write it', async () => {
  const system = build();
  system.connector.canPlaceWorkItem = () => false;
  await system.areaPaths.refresh();
  worldWith(system);
  system.store.recordAssay({
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 's',
    goalRef: goalRefOf(system),
    by: 'assayer',
    proposedParent: 345,
  });
  const state = buildStateSnapshot(system);
  assert.deepEqual(
    state.world.issues.find((i) => i.number === 12)?.assay?.placement,
    [],
    'three buttons that all 400 is the cockpit dead end in its purest form',
  );

  const { app } = await buildApp(system);
  try {
    const refused = await app.inject({ method: 'POST', url: '/api/issues/12/parent', payload: { parent: 345 } });
    assert.equal(refused.statusCode, 400);
  } finally {
    await app.close();
    system.store.close();
  }
});

/** The fingerprint of the goal text the world is carrying, as the assay stamps it. */
function goalRefOf(system: System): string {
  const live = system.store.getWorldBaseline()?.issues.find((i) => i.number === 12);
  return goalFingerprint(live?.title ?? null, live?.body ?? null);
}
