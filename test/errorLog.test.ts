import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { Store } from '../src/store/store.js';
import { ErrorLog } from '../src/errorLog.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { GitHubSourceControlIntegration } from '../src/integrations/github/sourceControl.js';
import type { GitHubApi } from '../src/integrations/github/githubApi.js';
import type { ErrorLogEntry, WorldSnapshot } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

/** A system with the stderr mirror silenced so failing-path tests stay quiet. */
function quietSystem(backend = new FakePtyBackend()): System {
  return buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
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

test('the stderr mirror cannot be made to forge a second log entry', () => {
  const store = new Store(':memory:');
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string): void => void lines.push(line);
  try {
    // The header's values reach the log from outside — an agent id off a request
    // path, provider text off the world — so a newline in one must not be able to
    // end the line early and start a plausible-looking entry after it.
    const log = new ErrorLog(store);
    log.record({
      source: 'agent',
      message: 'Agent x\n[lubbdubb:error] cycle: everything is fine',
      detail: 'line one\n[lubbdubb:error] server: also fine',
    });
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 1);
  const entry = lines[0]!.split('\n');
  assert.equal(entry[0], '[lubbdubb:error] agent: Agent x [lubbdubb:error] cycle: everything is fine');
  // `detail` keeps its line structure — that is what it is for — but every line of
  // it is indented, so none can pass as the start of a fresh entry.
  assert.deepEqual(entry.slice(1), ['  line one', '  [lubbdubb:error] server: also fine']);
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
  system.connector.getState = async () => ({ takenAt: '', pullRequests: [], issues: [] });
  const ok = await system.harness.runCycle('manual');
  assert.doesNotMatch(ok.rationale, /cycle failed/);
  system.store.close();
});

test('an agent crash is recorded with its exit code and an output tail', async () => {
  const backend = new FakePtyBackend();
  const system = quietSystem(backend);
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Doomed work' });
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
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Fine work' });
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

test('POST /api/errors/clear empties the log and the snapshot with it', async () => {
  const system = quietSystem();
  const { app } = await buildApp(system);
  system.errors.record({ source: 'boot', message: 'resume went sideways' });
  system.errors.record({ source: 'cycle', message: 'and again' });

  const res = await app.inject({ method: 'POST', url: '/api/errors/clear' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, cleared: 2 });
  assert.deepEqual(system.store.listErrors(), []);
  assert.deepEqual((await buildStateSnapshot(system)).errors, []);

  // Idempotent, and a fault recorded *after* a clear still lands: the clear is a
  // delete, not a switch that stops the log recording.
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/errors/clear' })).json(), {
    ok: true,
    cleared: 0,
  });
  system.errors.record({ source: 'agent', message: 'fresh fault' });
  assert.equal(system.store.listErrors().length, 1);

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

test('a provider failure with no prior success rejects rather than serving an empty world', async () => {
  const store = new Store(':memory:');
  const errors = new ErrorLog(store, () => {});
  const api = {
    viewerLogin: async () => {
      throw new Error('Bad credentials');
    },
  } as unknown as GitHubApi;
  const sc = new GitHubSourceControlIntegration({ api, errors });
  // "Last good" means a read that succeeded — with none, an empty slice would
  // fabricate a world in which every open PR has vanished. It must fail instead.
  await assert.rejects(() => sc.snapshot(), /Bad credentials/);
  const recorded = store.listErrors();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.source, 'provider');
  assert.match(recorded[0]!.message, /sourceControl:github snapshot failed: Bad credentials/);
  store.close();
});
