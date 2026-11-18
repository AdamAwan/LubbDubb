import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { handleAppraisal, handledContext } from '../src/handled/handled.js';
import type { AreaPathTree } from '../src/intake/placement.js';
import type { WorldSnapshot } from '../src/types.js';
import type { HandledPayload } from '../src/wire.js';

// → docs/spec/43-handled-for-you.md

const TREE: AreaPathTree = { root: 'Contoso', paths: ['Contoso\\Web', 'Contoso\\Billing'] };
const TITLE = 'Reconcile statements';
const BODY = 'body';

function build(): { system: System; writes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-handled-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: 'ld',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      agentModels: {
        profiles: {
          fast: { model: 'haiku', rank: 1, description: 'mechanical work' },
          deep: { model: 'opus', rank: 3, description: 'hard work' },
        },
        default: 'fast',
      },
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  const writes: string[] = [];
  system.connector.canPlaceWorkItem = () => true;
  system.connector.setWorkItemAreaPath = async (input) => {
    writes.push(`area:${input.areaPath}`);
    return { ok: true };
  };
  system.connector.setIssueLabel = async (input) => {
    if (input.present) writes.push(`label:${input.label}`);
    return { ok: true };
  };
  system.connector.listAreaPaths = async () => TREE;
  return { system, writes };
}

async function appraised(system: System, verdict: 'workable' | 'unclear' = 'workable'): Promise<void> {
  await system.areaPaths.refresh();
  system.store.world.setWorldBaseline({
    takenAt: '2026-08-01T00:00:00.000Z',
    pullRequests: [],
    closedPullRequests: [],
    issues: [
      {
        id: 'i12',
        number: 12,
        title: TITLE,
        body: BODY,
        labels: [],
        state: 'open',
        issueType: 'User Story',
        parent: null,
        areaPath: 'Contoso',
        linkedPrNumber: null,
      },
    ],
  } as unknown as WorldSnapshot);
  system.store.verdicts.recordAppraisal({
    originRef: 'issue:12',
    verdict,
    summary: 's',
    goalRef: goalFingerprint(TITLE, BODY),
    by: 'appraiser',
    proposedProfile: 'deep',
    profileDiverges: true,
    proposedAreaPath: 'Contoso\\Web',
  });
}

test('a workable appraisal moves the board and pins the profile without asking, and records both', async () => {
  const { system, writes } = build();
  await appraised(system);
  const handled = await handleAppraisal(handledContext(system.config, system), 12);

  assert.deepEqual(handled.map((a) => [a.kind, a.before, a.after]).sort(), [
    ['placement', 'Contoso', 'Contoso\\Web'],
    ['profile', null, 'deep'],
  ]);
  assert.ok(writes.includes('area:Contoso\\Web'));
  assert.ok(writes.includes('label:ld-model-deep'));

  const state = buildStateSnapshot(system);
  assert.equal(state.handledOpen, 2);
  assert.deepEqual(
    state.asks.filter((a) => a.kind === 'profile' || a.id.startsWith('placement:areaPath:')).map((a) => a.id),
    [],
    'neither ask reaches the rail',
  );
  assert.ok(
    state.asks.some((a) => a.id.startsWith('placement:parent:')),
    'a missing parent Feature is still asked: there is no undo for setting one',
  );
});

test('an appraisal that is not workable is left to the operator', async () => {
  const { system, writes } = build();
  await appraised(system, 'unclear');
  assert.deepEqual(await handleAppraisal(handledContext(system.config, system), 12), []);
  assert.deepEqual(writes, []);
});

test('undo puts the recorded value back, redo does it again, and check clears the count', async () => {
  const { system, writes } = build();
  await appraised(system);
  const handled = await handleAppraisal(handledContext(system.config, system), 12);
  const board = handled.find((a) => a.kind === 'placement');
  assert.ok(board);

  const { app } = await buildApp(system);
  try {
    const undo = await app.inject({ method: 'POST', url: `/api/handled/${board.id}/undo` });
    assert.equal(undo.statusCode, 200);
    assert.equal(writes.at(-1), 'area:Contoso');
    assert.equal(system.store.handled.get(board.id)?.state, 'undone');

    const twice = await app.inject({ method: 'POST', url: `/api/handled/${board.id}/undo` });
    assert.equal(twice.statusCode, 400, 'an undone action is not undone again');

    const redo = await app.inject({ method: 'POST', url: `/api/handled/${board.id}/redo` });
    assert.equal(redo.statusCode, 200);
    assert.equal(writes.at(-1), 'area:Contoso\\Web');

    const check = await app.inject({
      method: 'POST',
      url: '/api/handled/check',
      payload: { ids: handled.map((a) => a.id) },
    });
    assert.equal(check.statusCode, 200);
    assert.equal(buildStateSnapshot(system).handledOpen, 0);

    const listed = (await app.inject({ method: 'GET', url: '/api/handled' })).json<HandledPayload>();
    assert.deepEqual(
      listed.actions.map((a) => a.state),
      ['checked', 'checked'],
    );
  } finally {
    await app.close();
  }
});
