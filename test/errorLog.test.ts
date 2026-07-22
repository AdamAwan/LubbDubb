import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp, buildStateSnapshot } from '../src/server/app.js';
import { Store } from '../src/store/store.js';
import { ErrorLog } from '../src/errorLog.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { MicrosoftCalendarIntegration } from '../src/integrations/microsoft/calendar.js';
import type { ErrorLogEntry, WorldSnapshot } from '../src/types.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

/** A system with the stderr mirror silenced so failing-path tests stay quiet. */
function quietSystem(backend = new FakePtyBackend()): System {
  return buildSystem(testConfig(), { backend, errorMirror: () => {} });
}

test('store round-trips error entries, newest first', () => {
  const store = new Store(':memory:');
  store.recordError({ source: 'cycle', message: 'first' });
  store.recordError({ source: 'agent', message: 'second', detail: 'a stack' });
  const errors = store.listErrors();
  assert.equal(errors.length, 2);
  assert.equal(errors[0]!.message, 'second');
  assert.equal(errors[0]!.detail, 'a stack');
  assert.equal(errors[1]!.detail, null);
  store.close();
});

test('ErrorLog persists, mirrors, and emits `logged`', () => {
  const store = new Store(':memory:');
  const mirrored: ErrorLogEntry[] = [];
  const log = new ErrorLog(store, (e) => mirrored.push(e));
  const emitted: ErrorLogEntry[] = [];
  log.on('logged', (e) => emitted.push(e));
  const entry = log.record({ source: 'server', message: 'boom' });
  assert.equal(store.listErrors()[0]!.id, entry.id);
  assert.deepEqual(mirrored, [entry]);
  assert.deepEqual(emitted, [entry]);
  store.close();
});

test('a harness cycle exception is recorded, not thrown away', async () => {
  const system = quietSystem();
  system.connector.getState = async (): Promise<WorldSnapshot> => {
    throw new Error('provider exploded');
  };
  // Must not reject (a timer cycle would become an unhandled rejection).
  const report = await system.harness.runCycle('manual');
  assert.match(report.rationale, /cycle failed: provider exploded/);
  const errors = system.store.listErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.source, 'cycle');
  assert.match(errors[0]!.message, /provider exploded/);
  // The next cycle isn't wedged by the failed one.
  system.connector.getState = async () => ({ takenAt: '', pullRequests: [], issues: [], stories: [], calendar: [] });
  const ok = await system.harness.runCycle('manual');
  assert.doesNotMatch(ok.rationale, /cycle failed/);
  system.store.close();
});

test('an agent crash is recorded with its exit code and an output tail', async () => {
  const backend = new FakePtyBackend();
  const system = quietSystem(backend);
  system.connector.inject({ kind: 'new_story', title: 'Doomed work', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  backend.last().emit('fatal: cannot reach the model\n');
  backend.last().emitExit(2);

  assert.equal(system.store.getAgent(agentId)!.status, 'failed');
  const errors = system.store.listErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.source, 'agent');
  assert.match(errors[0]!.message, /exit code 2/);
  assert.match(errors[0]!.detail ?? '', /cannot reach the model/);
  system.store.close();
});

test('a clean agent finish records no error', async () => {
  const backend = new FakePtyBackend();
  const system = quietSystem(backend);
  system.connector.inject({ kind: 'new_story', title: 'Fine work', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  backend.last().emit('all good @@LUBBDUBB_DONE@@');
  assert.equal(system.store.listErrors().length, 0);
  system.store.close();
});

test('a route 500 is recorded and returned as a plain error', async () => {
  const system = quietSystem();
  const { app } = await buildApp(system);
  system.harness.runCycle = async () => {
    throw new Error('route kaboom');
  };
  const res = await app.inject({ method: 'POST', url: '/api/pulse' });
  assert.equal(res.statusCode, 500);
  const errors = system.store.listErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.source, 'server');
  assert.match(errors[0]!.message, /POST \/api\/pulse failed: route kaboom/);
  await app.close();
  system.store.close();
});

test('the /api/state snapshot carries the error log', async () => {
  const system = quietSystem();
  system.errors.record({ source: 'boot', message: 'resume went sideways' });
  const snapshot = await buildStateSnapshot(system);
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.errors[0]!.message, 'resume went sideways');
  system.store.close();
});

test('a provider snapshot failure is recorded and the last-good slice served', async () => {
  const store = new Store(':memory:');
  const errors = new ErrorLog(store, () => {});
  const cal = new MicrosoftCalendarIntegration({
    api: {
      listUpcomingEvents: async () => {
        throw new Error('AADSTS700003: token expired');
      },
    },
    store,
    errors,
    windowDays: 7,
  });
  const slice = await cal.snapshot();
  assert.deepEqual(slice.calendar, []);
  const recorded = store.listErrors();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.source, 'provider');
  assert.match(recorded[0]!.message, /calendar:microsoft365 snapshot failed: AADSTS700003/);
  store.close();
});
