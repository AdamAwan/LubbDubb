import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { validatePlanDocument, type PlanDocument } from '../src/plans/planDocument.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';

// Issue #475, "make a passed validation check's note optional" — the note stays
// required for a failed reading, and a passed one recorded with no note keeps its
// `resultBy: 'operator'` attribution rather than reading like a reset.

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

/** A goal carrying one live validation check, ready for a result to be posted to it. */
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

test('a failed result still refuses with no note', async () => {
  const system = build();
  seedCheck(system);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/csv-opens-in-excel/result',
    payload: { result: 'failed' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /note is required/);

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
