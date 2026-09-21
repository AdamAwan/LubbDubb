import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { HumanTask } from '../src/types.js';

/* The validate bench row settles at the press that answers its last check, not at the pulse after
   it — the operator recording the reading is looking straight at the row.
   → docs/spec/20-validation.md#saying-so-on-the-bench */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vsettle-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 0,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
    },
  );
}

function seed(system: System, ids: readonly string[]): void {
  system.store.validation.ingestValidation('issue:12', {
    checks: ids.map((id, seq) => ({
      id,
      seq,
      title: `Check ${id}`,
      do: 'Run it.',
      expect: 'It holds.',
      proof: null,
      uses: [],
      covers: [],
      fleetCandidate: false,
      candidateWhy: null,
    })),
    resources: [],
    supersededReason: 'the plan no longer declares it',
    amendNote: 'the plan was re-read',
  });
  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
}

function fileRow(system: System): HumanTask {
  system.validationReady.run({ issues: [] });
  const filed = system.store.humanTasks.listHumanTasksOfKind('validate');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.status, 'open');
  return filed[0]!;
}

test('the reading that answers the last check settles the validate row, with no pulse in between', async () => {
  const system = build();
  seed(system, ['first', 'second']);
  const row = fileRow(system);
  const { app } = await buildApp(system);

  const one = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/first/result',
    payload: { result: 'passed' },
  });
  assert.equal(one.statusCode, 200);
  assert.equal(
    system.store.humanTasks.getHumanTask(row.id)!.status,
    'open',
    'a check still owed to a person keeps the row',
  );

  const two = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/second/result',
    payload: { result: 'passed' },
  });
  assert.equal(two.statusCode, 200);
  const settled = system.store.humanTasks.getHumanTask(row.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /nothing is left for you to run/);

  await app.close();
  system.store.close?.();
});

test('waiving the last check settles it, and handing the last one to the fleet does too', async () => {
  for (const last of ['waive', 'handover'] as const) {
    const system = build();
    seed(system, ['only']);
    const row = fileRow(system);
    const { app } = await buildApp(system);

    const res = await app.inject({
      method: 'POST',
      url: `/api/issues/12/validation/only/${last}`,
      payload: last === 'handover' ? { to: 'fleet' } : {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      system.store.humanTasks.getHumanTask(row.id)!.status,
      'done',
      `${last} leaves nothing owed to a person`,
    );

    await app.close();
    system.store.close?.();
  }
});

/* A reading that says the check did not hold is still owed to somebody, and rule `validation-failed`
   reads it on its own origin — so the press that records it must leave the row standing. */
test('a failed reading, and a deferral, leave the row where it is', async () => {
  for (const press of ['failed', 'deferred'] as const) {
    const system = build();
    seed(system, ['only']);
    const row = fileRow(system);
    const { app } = await buildApp(system);

    const res = await app.inject({
      method: 'POST',
      url: press === 'failed' ? '/api/issues/12/validation/only/result' : '/api/issues/12/validation/only/defer',
      payload: press === 'failed' ? { result: 'failed' } : { reason: 'the staging tenant is down' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(system.store.humanTasks.getHumanTask(row.id)!.status, 'open', `${press} is not an answer`);

    await app.close();
    system.store.close?.();
  }
});

/* The pass is the pulse's, read a moment earlier: the press must never file or reopen a row, which
   are the arms that need the world to word one from. */
test('a reading on a goal with no row files nothing', async () => {
  const system = build();
  seed(system, ['only']);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/only/result',
    payload: { result: 'passed' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(system.store.humanTasks.listHumanTasksOfKind('validate'), []);

  await app.close();
  system.store.close?.();
});
