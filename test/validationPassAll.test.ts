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

function seedChecks(system: System, originRef = 'issue:12'): void {
  const check = (id: string) => ({ id, title: id, do: 'Do it.', expect: 'It works.' });
  const parsed = validatePlanDocument({
    version: 1,
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'One small fix.',
    validation: { checks: [check('a'), check('b'), check('failed'), check('fleet')] },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, {
    doc: (parsed as { ok: true; document: PlanDocument }).document,
    originRef,
    title: 'Issue',
  });
  system.store.validation.recordValidationResult(originRef, 'failed', { state: 'failed', note: null, by: 'operator' });
  system.store.validation.setValidationActor(originRef, 'fleet', 'fleet');
}

test("mark all passed records a person's owed checks in one call, and skips a failed or fleet one", async () => {
  const system = build();
  seedChecks(system);
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/pass',
    payload: { checkIds: ['a', 'b', 'failed', 'fleet', 'nope'] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { passed: string[] }).passed, ['a', 'b']);
  const state = (id: string) => system.store.validation.getValidationCheck('issue:12', id)?.state;
  assert.equal(state('a'), 'passed');
  assert.equal(state('b'), 'passed');
  assert.equal(state('failed'), 'failed');
  assert.equal(state('fleet'), 'unrun');
  assert.equal(system.store.validation.getValidationCheck('issue:12', 'a')?.resultBy, 'operator');

  const again = await app.inject({
    method: 'POST',
    url: '/api/issues/12/validation/pass',
    payload: { checkIds: ['a'] },
  });
  assert.equal(again.statusCode, 409);

  await app.close();
  system.store.close?.();
});
