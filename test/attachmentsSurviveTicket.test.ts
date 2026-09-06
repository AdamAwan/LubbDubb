import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 3)]);

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-survive-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    attachmentRoot: join(dir, 'attachments'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 6,
  });
}

function build(): System {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  system.config.integrations.issues = 'github';
  system.config.github = { owner: 'AdamAwan', repo: 'LubbDubb' };
  return system;
}

async function fileBrief(system: System, images: { name: string; data: Buffer }[]): Promise<string> {
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: {
      prompt: 'Make the panel look like this.',
      kind: 'code',
      attachments: images.map((i) => ({ name: i.name, data: i.data.toString('base64') })),
    },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
  return (res.json() as { ticketRef: string }).ticketRef;
}

test('a brief’s images are written under the ticket it was filed as', async () => {
  const system = build();
  const ticketRef = await fileBrief(system, [
    { name: 'panel.png', data: PNG },
    { name: 'after.gif', data: GIF },
  ]);

  const stored = system.store.listAttachments(ticketRef);
  assert.deepEqual(
    stored.map((a) => [a.index, a.label, a.mime]),
    [
      [0, 'panel.png', 'image/png'],
      [1, 'after.gif', 'image/gif'],
    ],
  );
  assert.deepEqual(
    stored.map((a) => a.path.split('/').pop()),
    ['0.png', '1.gif'],
  );
  for (const attachment of stored) assert.ok(existsSync(attachment.path), `${attachment.path} resolves`);
  assert.deepEqual(readFileSync(stored[0]!.path), PNG, 'the stored bytes are still the operator’s bytes');
  assert.ok(stored.every((a) => a.path.startsWith(system.config.attachmentRoot)));

  system.store.close();
});

test('two briefs keep their own images, under their own tickets', async () => {
  const system = build();
  const first = await fileBrief(system, [{ name: 'one.png', data: PNG }]);
  const second = await fileBrief(system, [{ name: 'two.gif', data: GIF }]);
  assert.notEqual(first, second, 'each brief files its own ticket');

  const a = system.store.listAttachments(first);
  const b = system.store.listAttachments(second);
  assert.deepEqual(
    a.map((x) => x.label),
    ['one.png'],
  );
  assert.deepEqual(
    b.map((x) => x.label),
    ['two.gif'],
  );
  assert.notEqual(a[0]!.path, b[0]!.path);
  assert.deepEqual(readFileSync(a[0]!.path), PNG);
  assert.deepEqual(readFileSync(b[0]!.path), GIF);

  system.store.close();
});

test('every agent dispatched for the goal is handed the images, and only that goal’s', async () => {
  const system = build();
  const ticketRef = await fileBrief(system, [{ name: 'panel.png', data: PNG }]);
  const attachment = system.store.listAttachments(ticketRef)[0]!;

  system.connector.inject({ kind: 'new_issue', number: 315, title: 'Something else entirely', body: 'No image.' });
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const mine = system.store
    .listTasks()
    .filter((t) => t.originRef?.startsWith(`${ticketRef}`))
    .map((t) => system.store.getTask(t.id)!);
  assert.ok(mine.length > 0, 'the funnel picked the goal up');
  for (const task of mine) {
    assert.ok(task.prompt.includes(attachment.path), `${task.originRef} is given the absolute path`);
    assert.match(task.prompt, /The operator attached an image/);
    assert.ok(!task.prompt.startsWith('---'), 'the note is appended to a rendered prompt, not the whole of it');
  }

  const others = system.store
    .listTasks()
    .filter((t) => t.originRef?.startsWith('issue:315'))
    .map((t) => system.store.getTask(t.id)!);
  assert.ok(others.length > 0, 'the other goal was picked up too');
  for (const task of others)
    assert.ok(!task.prompt.includes(attachment.path), `${task.originRef} sees nothing of another goal's images`);

  system.store.close();
});

test('the cockpit is shipped the images and a URL that serves them', async () => {
  const system = build();
  const ticketRef = await fileBrief(system, [{ name: 'panel.png', data: PNG }]);
  const { app } = await buildApp(system);

  const state = buildStateSnapshot(system);
  const attachment = state.attachments[0]!;
  assert.equal(attachment.targetRef, ticketRef);
  const url = state.attachmentUrls[attachment.id]!;
  assert.equal(url, `/attachments/${attachment.id}`, 'auth is off here, so no capability is minted');

  const served = await app.inject({ method: 'GET', url });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(served.rawPayload, PNG);

  const missing = await app.inject({ method: 'GET', url: '/attachments/att_nope' });
  assert.equal(missing.statusCode, 404);

  await app.close();
  system.store.close();
});
