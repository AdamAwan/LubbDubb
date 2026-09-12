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
import { validateGoalAppraisal } from '../src/mcp/goalAppraisal.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { AzureDevOpsWorkItemsIntegration } from '../src/integrations/azure/workItems.js';
import type { AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { Issue, IssueAppraisal, WorldSnapshot } from '../src/types.js';

const TREE: AreaPathTree = { root: 'Contoso', paths: ['Contoso\\Web', 'Contoso\\Web\\Checkout', 'Contoso\\Billing'] };

function appraisal(over: Partial<IssueAppraisal> = {}): IssueAppraisal {
  return {
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'Reconcile the statement totals.',
    missing: [],
    goalRef: 'abc123',
    by: 'appraiser',
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

test('a proposal is asked while the live item still lacks the field, and not after', () => {
  const proposed = appraisal({ proposedParent: 345, proposedAreaPath: 'Contoso\\Web' });

  const both = placementAsks(proposed, issue(), TREE, 'abc123');
  assert.deepEqual(
    both.map((a) => a.field),
    ['parent', 'areaPath'],
    'both questions are open, parent first',
  );

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
  const proposed = appraisal({ proposedAreaPath: 'Contoso\\Web' });
  const areas = (i: Issue): string[] =>
    placementAsks(proposed, i, TREE, 'abc123')
      .filter((a) => a.field === 'areaPath')
      .map((a) => a.proposedAreaPath ?? '');
  assert.deepEqual(areas(issue({ areaPath: 'Contoso' })), ['Contoso\\Web']);
  assert.deepEqual(areas(issue({ areaPath: 'contoso/' })), ['Contoso\\Web']);
  assert.deepEqual(areas(issue({ areaPath: 'Contoso\\Web' })), []);
  assert.equal(normalizeAreaPath('Contoso/Web'), normalizeAreaPath('contoso\\web\\'));
});

test('nothing is asked without a tree, on a flat tracker, or against superseded goal text', () => {
  const proposed = appraisal({ proposedParent: 345, proposedAreaPath: 'Contoso\\Web' });
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
    [{ field: 'parent', proposedParent: null, proposedAreaPath: null }],
    'a verdict about text the ticket no longer has offers nothing — but the item still hangs off nothing',
  );
  assert.deepEqual(placementAsks(null, issue(), TREE, 'abc123'), [
    { field: 'parent', proposedParent: null, proposedAreaPath: null },
  ]);
});

test('the parent question is the fact, and the area path question is the proposal', () => {
  const silent = appraisal();
  assert.deepEqual(
    placementAsks(silent, issue(), TREE, 'abc123'),
    [{ field: 'parent', proposedParent: null, proposedAreaPath: null }],
    'an appraiser with no container to name does not make the orphan go away',
  );
  assert.deepEqual(
    placementAsks(appraisal({ proposedParent: 345 }), issue(), TREE, 'abc123').map((a) => a.proposedParent),
    [345],
    'where there is a proposal it is what the question offers',
  );

  assert.deepEqual(placementAsks(silent, issue({ issueType: 'Task' }), TREE, 'abc123'), [], 'a Task wanted no Feature');
  assert.deepEqual(placementAsks(silent, issue({ issueType: 'Feature' }), TREE, 'abc123'), [], 'a container sits atop');
  assert.deepEqual(placementAsks(silent, issue({ issueType: 'Defect' }), TREE, 'abc123'), [], 'not a default type');
  assert.deepEqual(
    placementAsks(silent, issue({ issueType: 'Defect' }), TREE, 'abc123', { parentedTypes: ['defect'] }).map(
      (a) => a.field,
    ),
    ['parent'],
    "a project's own type names, matched case-insensitively, are asked about like any other",
  );
  assert.deepEqual(
    placementAsks(silent, issue({ issueType: 'Feature' }), TREE, 'abc123', {
      containerTypes: [],
      parentedTypes: ['feature'],
    }).map((a) => a.field),
    ['parent'],
    'and `issueContainerTypes: []` turns the container half off, as it does everywhere else',
  );

  const parented = issue({
    parent: { number: 345, title: 'F', issueType: 'Feature', workItemState: 'Active', state: 'open' },
  });
  assert.deepEqual(placementAsks(silent, parented, TREE, 'abc123'), []);
  assert.deepEqual(
    placementAsks({ ...silent, parentSettledAt: '2026-08-02T00:00:00.000Z' }, issue(), TREE, 'abc123'),
    [],
    'the operator said this goal wants none',
  );
  assert.deepEqual(
    placementAsks(silent, issue({ parent: undefined }), TREE, 'abc123'),
    [],
    'and a provider that tracks no hierarchy is never missing a parent',
  );
});

test('a settled question stays settled, whichever of the three answers it got', () => {
  const proposed = appraisal({ proposedParent: 345, proposedAreaPath: 'Contoso\\Web' });
  const settled = { ...proposed, parentSettledAt: '2026-08-02T00:00:00.000Z' };
  assert.deepEqual(
    placementAsks(settled, issue(), TREE, 'abc123').map((a) => a.field),
    ['areaPath'],
    'the operator said this goal wants no parent, and it changed nothing out there to notice',
  );
});

test('the area offer is capped, and says how much it left out', () => {
  const many = { root: 'P', paths: Array.from({ length: 60 }, (_, i) => `P\\Team${i}`) };
  const { paths, omitted } = truncateAreaPaths(many);
  assert.equal(paths.length, 40);
  assert.equal(omitted, 20, 'a cut list read as the complete set is the failure the count exists to stop');
  assert.deepEqual(truncateAreaPaths(TREE), { paths: TREE.paths, omitted: 0 });
});

test('the appraisal tool takes a parent freely and an area path only from the offer', () => {
  const base = { status: 'workable', summary: 'clear enough' };

  const free = validateGoalAppraisal({ ...base, parent: 345 }, [], TREE.paths);
  assert.equal(free.ok && free.parent, 345);
  assert.equal(validateGoalAppraisal({ ...base, parent: '#9001' }, [], TREE.paths).ok, true);
  assert.equal(validateGoalAppraisal({ ...base, parent: 'the billing feature' }, [], TREE.paths).ok, false);

  const chosen = validateGoalAppraisal({ ...base, area_path: 'contoso/web' }, [], TREE.paths);
  assert.equal(
    chosen.ok && chosen.areaPath,
    'Contoso\\Web',
    "answered in the provider's own spelling, since that is the string the write has to carry",
  );
  assert.equal(validateGoalAppraisal({ ...base, area_path: 'Contoso\\Payments' }, [], TREE.paths).ok, false);
  assert.equal(
    validateGoalAppraisal({ ...base, area_path: 'Contoso\\Web' }, [], []).ok,
    true,
    'a deployment whose tree the harness could not read asks nothing and refuses nothing',
  );

  const unclear = validateGoalAppraisal(
    { status: 'unclear', summary: 'no idea', missing: ['Which statement?'], parent: 345, area_path: 'Contoso\\Web' },
    [],
    TREE.paths,
  );
  assert.equal(unclear.ok && unclear.parent, null);
  assert.equal(unclear.ok && unclear.areaPath, null);
});

test('a placement proposal round-trips, is settled per field, and is re-asked after a re-appraisal', () => {
  const store = new Store(':memory:');
  try {
    store.verdicts.recordAppraisal({
      originRef: 'issue:12',
      verdict: 'workable',
      summary: 's',
      goalRef: 'abc123',
      by: 'appraiser',
      proposedParent: 345,
      proposedAreaPath: 'Contoso\\Web',
    });
    const stored = store.verdicts.getAppraisal('issue:12');
    assert.equal(stored?.proposedParent, 345);
    assert.equal(stored?.proposedAreaPath, 'Contoso\\Web');
    assert.equal(stored?.parentSettledAt, null);

    assert.equal(store.verdicts.settleAppraisalPlacement('issue:12', 'not-the-text-they-read', 'parent'), false);
    assert.equal(store.verdicts.settleAppraisalPlacement('issue:12', 'abc123', 'parent'), true);
    assert.equal(
      store.verdicts.settleAppraisalPlacement('issue:12', 'abc123', 'parent'),
      false,
      'settling twice settles once',
    );
    const half = store.verdicts.getAppraisal('issue:12');
    assert.notEqual(half?.parentSettledAt, null);
    assert.equal(half?.areaPathSettledAt, null, 'the other question is untouched');

    store.verdicts.recordAppraisal({
      originRef: 'issue:12',
      verdict: 'workable',
      summary: 's',
      goalRef: 'rewritten',
      by: 'appraiser',
      proposedParent: 777,
    });
    const again = store.verdicts.getAppraisal('issue:12');
    assert.equal(again?.parentSettledAt, null);
    assert.equal(again?.proposedParent, 777);
  } finally {
    store.close();
  }
});

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
  system.store.world.setWorldBaseline({
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
  system.store.verdicts.recordAppraisal({
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'Reconcile the statement totals.',
    goalRef: goalRefOf(system),
    by: 'appraiser',
    proposedParent: 345,
    proposedAreaPath: 'Contoso\\Web',
  });

  const { app } = await buildApp(system);
  try {
    const before = buildStateSnapshot(system);
    const asks = before.world.issues.find((i) => i.number === 12)?.appraisal?.placement ?? [];
    assert.deepEqual(
      asks.map((a) => a.field),
      ['parent', 'areaPath'],
      'both questions ship, derived from the live item rather than from anything stored',
    );
    assert.deepEqual(
      before.config.areaPaths,
      TREE.paths,
      'and the operator is offered the same nodes the appraiser was',
    );

    const answered = await app.inject({ method: 'POST', url: '/api/issues/12/parent', payload: { parent: 345 } });
    assert.equal(answered.statusCode, 200);
    assert.deepEqual(placed, ['parent:12->345'], 'the write is the harness’s, through the sink');
    assert.notEqual(system.store.verdicts.getAppraisal('issue:12')?.parentSettledAt, null);

    const dismissed = await app.inject({ method: 'POST', url: '/api/issues/12/area-path', payload: {} });
    assert.equal(dismissed.statusCode, 200);
    assert.deepEqual(placed, ['parent:12->345'], 'and "not applicable" writes nothing to the tracker at all');
    assert.notEqual(system.store.verdicts.getAppraisal('issue:12')?.areaPathSettledAt, null);

    worldWith(system);
    const after = buildStateSnapshot(system);
    assert.deepEqual(after.world.issues.find((i) => i.number === 12)?.appraisal?.placement, []);
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
  system.store.verdicts.recordAppraisal({
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 's',
    goalRef: goalRefOf(system),
    by: 'appraiser',
    proposedParent: 345,
  });
  const state = buildStateSnapshot(system);
  assert.deepEqual(
    state.world.issues.find((i) => i.number === 12)?.appraisal?.placement,
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

function goalRefOf(system: System): string {
  const live = system.store.world.getWorldBaseline()?.issues.find((i) => i.number === 12);
  return goalFingerprint(live?.title ?? null, live?.body ?? null);
}
