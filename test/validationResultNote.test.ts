import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { validatePlanDocument, type PlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function seedCheck(system: System, originRef = 'issue:12'): void {
  const parsed = validatePlanDocument({
    version: 1,
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'One small fix.',
    validation: {
      checks: [
        {
          id: 'csv-opens-in-excel',
          title: 'The export opens in Excel',
          do: 'Export a report and open the file.',
          expect: 'It opens with the columns intact.',
        },
      ],
    },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, {
    doc: (parsed as { ok: true; document: PlanDocument }).document,
    originRef,
    title: 'Issue',
  });
}

test('a passed result posts with no note, settles passed, and keeps operator attribution', async () => {
  const system = build();
  seedCheck(system);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/result',
    payload: { result: 'passed' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: true; check: { state: string; resultNote: string | null; resultBy: string | null } };
  assert.equal(body.check.state, 'passed');
  assert.equal(body.check.resultNote, null);
  assert.equal(body.check.resultBy, 'operator', 'a noteless pass must not read as an unattributed reset');

  await app.close();
  system.store.close?.();
});

/* The note was compulsory here, on the argument that a bare failure means nothing in a month. In
   practice the field went untyped or unread, so what it bought was a toll on the commonest act in
   the cockpit rather than a record — and it made recording a reading two presses. What keeps a bare
   reading honest is that it is attributed and reversible: `resultBy` says who took it and the reset
   route puts it back. → docs/spec/20-validation.md */
test('a failed result posts with no note, and still reads as the operator’s', async () => {
  const system = build();
  seedCheck(system);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/result',
    payload: { result: 'failed' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { check: { state: string; resultNote: string | null; resultBy: string | null } };
  assert.equal(body.check.state, 'failed');
  assert.equal(body.check.resultNote, null);
  assert.equal(body.check.resultBy, 'operator', 'a noteless failure must not read as an unattributed reset');

  await app.close();
  system.store.close?.();
});

/* The waiver's reason went the same way, and for the same reason — it is the other half of the same
   press. A reason is still recorded where one is sent. */
test('a waiver settles with no reason, and records one where it is given', async () => {
  const system = build();
  seedCheck(system);
  const { app } = await buildApp(system);

  const bare = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/waive',
    payload: {},
  });
  assert.equal(bare.statusCode, 200);
  const first = bare.json() as { check: { state: string; resultNote: string | null } };
  assert.equal(first.check.state, 'waived');
  assert.equal(first.check.resultNote, null);

  const said = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/waive',
    payload: { reason: 'the export path is going away next sprint' },
  });
  assert.equal(said.statusCode, 200);
  const second = said.json() as { check: { resultNote: string | null } };
  assert.equal(second.check.resultNote, 'the export path is going away next sprint');

  await app.close();
  system.store.close?.();
});

test('a passed result with a note still records it', async () => {
  const system = build();
  seedCheck(system);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/result',
    payload: { result: 'passed', note: 'ran it, columns intact' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { check: { resultNote: string | null; resultBy: string | null } };
  assert.equal(body.check.resultNote, 'ran it, columns intact');
  assert.equal(body.check.resultBy, 'operator');

  await app.close();
  system.store.close?.();
});

test('a failed result with a note behaves exactly as before', async () => {
  const system = build();
  seedCheck(system);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/result',
    payload: { result: 'failed', note: 'the export was truncated' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { check: { state: string; resultNote: string | null; resultBy: string | null } };
  assert.equal(body.check.state, 'failed');
  assert.equal(body.check.resultNote, 'the export was truncated');
  assert.equal(body.check.resultBy, 'operator');

  await app.close();
  system.store.close?.();
});
