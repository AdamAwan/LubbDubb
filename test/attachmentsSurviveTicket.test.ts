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

/**
 * Issue #249, second half: an operator's screenshot survives the ticket-filing
 * fork.
 *
 * A code blueprint with a tracker configured is **not** dispatched — it is filed
 * as a watched ticket and the planning funnel takes over (issue #198). Left keyed
 * on the blueprint, the images would be visible to exactly one agent: whoever
 * writes the code for a job that no longer exists.
 *
 * Since #394 the harness files the ticket itself, on the request, so it knows the
 * issue number **before** anything is written to disk — the images land under
 * `issue:<n>` and never move. These tests are about the two things left: the
 * goal-scoped append at every later dispatch, and the strip the cockpit draws off
 * the same rows.
 */

/** A real PNG: the 8-byte signature is what the sniffer reads, the rest is filler. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 3)]);

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-survive-'));
  return loadConfig({
    auth: { enabled: false } as never,
    // The watch gate off: this file is about where an image goes, not about
    // which issues the harness picks up, and an unlabelled injected issue would
    // otherwise never be dispatched for at all.
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

/** A system whose *issue tracker* is GitHub while its world stays the fake one. */
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

/** Launch a code blueprint carrying `images`, and return the ticket it was filed as. */
async function fileBlueprint(system: System, images: { name: string; data: Buffer }[]): Promise<string> {
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

test('a blueprint’s images are written under the ticket it was filed as', async () => {
  const system = build();
  const ticketRef = await fileBlueprint(system, [
    { name: 'panel.png', data: PNG },
    { name: 'after.gif', data: GIF },
  ]);

  // Under the goal from the first write. Nothing is keyed on the blueprint and
  // then moved — the harness files the ticket itself, so the issue number is known
  // before any byte is written, and there is no window in which the image belongs
  // to something that is about to stop existing.
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

test('two blueprints keep their own images, under their own tickets', async () => {
  const system = build();
  const first = await fileBlueprint(system, [{ name: 'one.png', data: PNG }]);
  const second = await fileBlueprint(system, [{ name: 'two.gif', data: GIF }]);
  assert.notEqual(first, second, 'each blueprint files its own ticket');

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
  // Distinct files, both still there: a shared stem would have silently replaced
  // the first operator's screenshot with the second's.
  assert.notEqual(a[0]!.path, b[0]!.path);
  assert.deepEqual(readFileSync(a[0]!.path), PNG);
  assert.deepEqual(readFileSync(b[0]!.path), GIF);

  system.store.close();
});

test('every agent dispatched for the goal is handed the images, and only that goal’s', async () => {
  const system = build();
  const ticketRef = await fileBlueprint(system, [{ name: 'panel.png', data: PNG }]);
  const attachment = system.store.listAttachments(ticketRef)[0]!;

  // A second, unrelated goal beside it — the images must not follow *that* one
  // anywhere. The blueprint's own ticket is already in the world: the harness
  // filed it, so it is a real issue on the fake provider from that moment.
  system.connector.inject({ kind: 'new_issue', number: 315, title: 'Something else entirely', body: 'No image.' });
  // Twice: the cap is shared and the first cycle spends its headroom on whichever
  // goal it reaches first.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const mine = system.store
    .listTasks()
    .filter((t) => t.originRef?.startsWith(`${ticketRef}`))
    .map((t) => system.store.getTask(t.id)!);
  assert.ok(mine.length > 0, 'the funnel picked the goal up');
  for (const task of mine) {
    // The funnel dispatches for `issue:<n>:assay`, `:plan`, `:part:<slug>` — never
    // for `issue:<n>` exactly until the parts are gone. An exact-origin lookup
    // would therefore hand the screenshot to nobody, which is the bug this scoping
    // is the fix for.
    assert.ok(task.prompt.includes(attachment.path), `${task.originRef} is given the absolute path`);
    assert.match(task.prompt, /The operator attached an image/);
    // Appended, never interpolated: whatever the template rendered is still first.
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
  const ticketRef = await fileBlueprint(system, [{ name: 'panel.png', data: PNG }]);
  const { app } = await buildApp(system);

  // The strip hangs off the issue, which is where the operator now finds the goal —
  // there is no queued blueprint to hang it off, because nothing was queued.
  const state = buildStateSnapshot(system);
  const attachment = state.attachments[0]!;
  assert.equal(attachment.targetRef, ticketRef);
  const url = state.attachmentUrls[attachment.id]!;
  assert.equal(url, `/attachments/${attachment.id}`, 'auth is off here, so no capability is minted');

  // The route serves the stored bytes under the *sniffed* mime, and outside the
  // `/api` prefix — an `<img>` load carries no bearer token to get past the guard.
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
