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
import type { Agent, Job } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Issue #249, second half: an operator's screenshot survives the ticket-filing
 * fork.
 *
 * A code blueprint with a tracker configured is **not** dispatched — it is filed
 * as a watched ticket and the planning funnel takes over (issue #198). The images
 * arrive keyed `job:<id>`, so left alone they would be visible to exactly one
 * agent: the one that files the ticket and writes no code. These tests are about
 * the three things that stop that — the re-key at `link_ticket`, the goal-scoped
 * append at every later dispatch, and the strip the cockpit draws off the same
 * rows.
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

/** The desk agent the blueprint's filing job dispatches as — the credential `link_ticket` resolves. */
function filingAgent(system: System, job: Job): Agent {
  const task = system.store.createTask({
    kind: 'desk',
    title: job.title,
    prompt: job.prompt,
    branch: null,
    originRef: `job:${job.id}`,
    originTitle: job.title,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-desk-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/** Launch a code blueprint carrying `images`, and return the filing job it became. */
async function fileBlueprint(system: System, images: { name: string; data: Buffer }[]): Promise<Job> {
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
  return (res.json() as { job: Job }).job;
}

test('link_ticket moves the blueprint’s images onto the ticket it filed', async () => {
  const system = build();
  const job = await fileBlueprint(system, [
    { name: 'panel.png', data: PNG },
    { name: 'after.gif', data: GIF },
  ]);
  // They arrive on the filing job, which is the ref the route could key them
  // under — nothing knows the issue number yet, because no issue exists.
  const before = system.store.listAttachments(`job:${job.id}`);
  assert.deepEqual(
    before.map((a) => a.path.split('/').pop()),
    ['0.png', '1.gif'],
  );
  const oldDir = before[0]!.path.slice(0, before[0]!.path.lastIndexOf('/'));

  const agent = filingAgent(system, job);
  const linked = await callTool(system, agent, 'link_ticket', { ref: 'issue:314' });
  assert.equal(linked.isError, false);
  assert.match(linked.text, /2 images the operator attached/);

  // Rows: re-keyed to the goal, in order, still the operator's own labels.
  const after = system.store.listAttachments('issue:314');
  assert.deepEqual(
    after.map((a) => [a.index, a.label, a.mime]),
    [
      [0, 'panel.png', 'image/png'],
      [1, 'after.gif', 'image/gif'],
    ],
  );
  assert.deepEqual(system.store.listAttachments(`job:${job.id}`), [], 'nothing is left on the job');

  // Files: moved, and every row still names a path that resolves — which is the
  // failure the move-then-rewrite ordering exists to make impossible.
  for (const attachment of after) assert.ok(existsSync(attachment.path), `${attachment.path} resolves`);
  assert.deepEqual(readFileSync(after[0]!.path), PNG, 'the stored bytes are still the operator’s bytes');
  assert.equal(existsSync(oldDir), false, 'the job’s directory is gone, not left as a second copy');
  assert.ok(after.every((a) => a.path.startsWith(system.config.attachmentRoot)));

  system.store.close();
});

test('a re-key onto an issue that already has images renumbers rather than overwriting', async () => {
  const system = build();
  // The first blueprint's images end up on issue:314.
  const first = await fileBlueprint(system, [{ name: 'one.png', data: PNG }]);
  await callTool(system, filingAgent(system, first), 'link_ticket', { ref: 'issue:314' });

  // A second blueprint whose agent decides it is the same goal — `link_ticket`
  // explicitly accepts "the existing one you decided it duplicates".
  const second = await fileBlueprint(system, [{ name: 'two.gif', data: GIF }]);
  await callTool(system, filingAgent(system, second), 'link_ticket', { ref: 'issue:314' });

  const all = system.store.listAttachments('issue:314');
  assert.deepEqual(
    all.map((a) => [a.index, a.label]),
    [
      [0, 'one.png'],
      [1, 'two.gif'],
    ],
    'the second arrival takes the next free index',
  );
  // Distinct files, both still there: a fixed stem would have silently replaced
  // the first operator's screenshot with the second's.
  assert.notEqual(all[0]!.path, all[1]!.path);
  assert.deepEqual(readFileSync(all[0]!.path), PNG);
  assert.deepEqual(readFileSync(all[1]!.path), GIF);

  system.store.close();
});

test('every agent dispatched for the goal is handed the images, and only that goal’s', async () => {
  const system = build();
  const job = await fileBlueprint(system, [{ name: 'panel.png', data: PNG }]);
  await callTool(system, filingAgent(system, job), 'link_ticket', { ref: 'issue:314' });
  const attachment = system.store.listAttachments('issue:314')[0]!;

  // The ticket the filing agent said it created, now in the world. A second,
  // unrelated goal beside it — the images must not follow *that* one anywhere.
  system.connector.inject({
    kind: 'new_issue',
    number: 314,
    title: 'Make the panel look like this',
    body: 'See image.',
  });
  system.connector.inject({ kind: 'new_issue', number: 315, title: 'Something else entirely', body: 'No image.' });
  // Twice: the cap is shared and the first cycle spends its headroom on the goal
  // that was already in the world.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const mine = system.store.listTasks().filter((t) => t.originRef?.startsWith('issue:314'));
  assert.ok(mine.length > 0, 'the funnel picked the goal up');
  for (const task of mine) {
    // The funnel dispatches for `issue:314:assay`, `:plan`, `:part:<slug>` — never
    // for `issue:314` exactly until the parts are gone. An exact-origin lookup
    // would therefore hand the screenshot to nobody, which is the bug this scoping
    // is the fix for.
    assert.ok(task.prompt.includes(attachment.path), `${task.originRef} is given the absolute path`);
    assert.match(task.prompt, /The operator attached an image/);
    // Appended, never interpolated: whatever the template rendered is still first.
    assert.ok(!task.prompt.startsWith('---'), 'the note is appended to a rendered prompt, not the whole of it');
  }

  const others = system.store.listTasks().filter((t) => t.originRef?.startsWith('issue:315'));
  assert.ok(others.length > 0, 'the other goal was picked up too');
  for (const task of others)
    assert.ok(!task.prompt.includes(attachment.path), `${task.originRef} sees nothing of another goal's images`);

  system.store.close();
});

test('the cockpit is shipped the images and a URL that serves them', async () => {
  const system = build();
  const job = await fileBlueprint(system, [{ name: 'panel.png', data: PNG }]);
  const { app } = await buildApp(system);

  // Before the fork resolves, the strip hangs off the queued blueprint…
  const queued = buildStateSnapshot(system);
  assert.deepEqual(
    queued.attachments.map((a) => a.targetRef),
    [`job:${job.id}`],
  );

  // …and after it, off the issue, which is where the operator now finds the goal.
  await callTool(system, filingAgent(system, job), 'link_ticket', { ref: 'issue:314' });
  const state = buildStateSnapshot(system);
  const attachment = state.attachments[0]!;
  assert.equal(attachment.targetRef, 'issue:314');
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
