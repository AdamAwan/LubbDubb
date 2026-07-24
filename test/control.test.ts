import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { WebSocket } from 'ws';
import type { ServerEvent } from '../src/server/hub.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

test('POST /api/control changes the cap and reflects it in /api/state', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/control', payload: { cap: 5 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, cap: 5, paused: false });
  assert.equal(system.runtimeControl.cap, 5);

  const state = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.deepEqual(state.control, { cap: 5, paused: false });

  await app.close();
  system.store.close();
});

test('POST /api/control toggles pause independently of the cap', async () => {
  const system = buildSystem(testConfig({ maxConcurrentAgents: 4 }), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/control', payload: { paused: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, cap: 4, paused: true });
  assert.equal(system.runtimeControl.paused, true);
  assert.equal(system.runtimeControl.cap, 4, 'pausing leaves the chosen cap intact');

  await app.close();
  system.store.close();
});

test('POST /api/control rejects an invalid cap with 400 and does not mutate', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  for (const cap of [-1, 2.5, 'nope'] as const) {
    const res = await app.inject({ method: 'POST', url: '/api/control', payload: { cap } });
    assert.equal(res.statusCode, 400, `cap=${String(cap)} should be rejected`);
  }
  assert.equal(system.runtimeControl.cap, 3, 'cap unchanged after rejected requests');

  await app.close();
  system.store.close();
});

test('POST /api/control broadcasts control:changed to connected cockpits', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  const { app, hub } = await buildApp(system);

  const sent: ServerEvent[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerEvent),
    on: () => {},
  } as unknown as WebSocket;
  hub.add(socket);

  await app.inject({ method: 'POST', url: '/api/control', payload: { cap: 2, paused: true } });
  const ev = sent.find((e) => e.type === 'control:changed');
  assert.ok(ev, 'a control:changed event is broadcast');
  assert.equal(ev.type === 'control:changed' && ev.cap, 2);
  assert.equal(ev.type === 'control:changed' && ev.paused, true);

  await app.close();
  system.store.close();
});
