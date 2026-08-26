import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import {
  ACCEPTED_IMAGE_MIMES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  prepareAttachments,
} from '../src/jobs/attachments.js';

/**
 * Issue #249: an operator's screenshot reaches the agent that runs the brief.
 *
 * The interesting seams are the bounds (decided on decoded bytes, never on what
 * the client said), the disk (one canonical file, named from the *sniffed* format
 * rather than from the client's filename) and the prompt (appended, never
 * interpolated).
 */

/** A real PNG: the 8-byte signature is what the sniffer reads, the rest is filler. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 3)]);

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-attach-'));
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
    maxConcurrentAgents: 2,
  });
}

function buildTestSystem() {
  return buildSystem(testConfig(), {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
}

test('the accepted formats are decided by magic bytes, not by what the client said', () => {
  const ok = prepareAttachments([{ name: 'screen.jpg', data: PNG.toString('base64') }]);
  assert.equal(ok.ok, true);
  // The name claims JPEG and nothing asked the client: the bytes are a PNG, so
  // that is the mime stored and `png` is the extension the file is written under.
  assert.deepEqual(ok.ok && ok.files.map((f) => [f.mime, f.ext, f.index]), [['image/png', 'png', 0]]);

  const text = prepareAttachments([{ name: 'notes.png', data: Buffer.from('not an image at all').toString('base64') }]);
  assert.equal(text.ok, false);
  assert.match(text.ok === false ? text.error : '', /notes\.png is not one of the accepted image formats/);
  // The refusal lists what *is* accepted, so an operator can act on it.
  for (const mime of ACCEPTED_IMAGE_MIMES) assert.match(text.ok === false ? text.error : '', new RegExp(mime));
});

test('the bounds are per-file size and a count, and a refusal names the file', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES, 1)]);
  const oversized = prepareAttachments([{ name: 'huge.png', data: big.toString('base64') }]);
  assert.equal(oversized.ok, false);
  assert.match(oversized.ok === false ? oversized.error : '', /huge\.png is .* the limit is 5\.0 MB/);

  const tooMany = prepareAttachments(
    Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `${i}.png`, data: PNG.toString('base64') })),
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.ok === false ? tooMany.error : '', /at most 4 attachments/);

  // A pasted screenshot has no filename; the refusal still names *something*.
  const unnamed = prepareAttachments([{ data: Buffer.from('nope').toString('base64') }]);
  assert.match(unnamed.ok === false ? unnamed.error : '', /attachment 1 is not one of the accepted/);
});

test('POST /api/jobs stores an attachment on disk and queues the job', async () => {
  const system = buildTestSystem();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: {
      prompt: 'Make the panel look like this.',
      kind: 'desk',
      attachments: [
        { name: 'panel.png', data: PNG.toString('base64') },
        { name: '../../etc/passwd', data: GIF.toString('base64') },
      ],
    },
  });
  assert.equal(res.statusCode, 200);

  const job = system.store.listJobs()[0]!;
  const stored = system.store.listAttachments(`job:${job.id}`);
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((a) => a.mime),
    ['image/png', 'image/gif'],
  );
  // The client's filename never reaches the filesystem: the stem is the index and
  // the extension comes from the sniffed format, which is what makes traversal a
  // category that cannot arise rather than a string to sanitise.
  assert.deepEqual(
    stored.map((a) => a.path.split('/').pop()),
    ['0.png', '1.gif'],
  );
  assert.equal(stored[1]!.label, '../../etc/passwd', 'the operator still sees their own name');
  assert.deepEqual(readFileSync(stored[0]!.path), PNG, 'the stored bytes are the operator’s bytes');
  assert.equal(stored[0]!.bytes, PNG.length);
  // Outside every worktree, so nothing can commit it onto a branch.
  assert.ok(stored[0]!.path.startsWith(system.config.attachmentRoot));

  await app.close();
  system.store.close();
});

test('a refused attachment queues no job', async () => {
  const system = buildTestSystem();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'Like this.', kind: 'desk', attachments: [{ name: 'x.pdf', data: 'JVBERi0xLjQK' }] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /x\.pdf is not one of the accepted image formats/);
  assert.equal(system.store.listJobs().length, 0, 'nothing was queued');
  // A brief that says "like this" without the "this" is worse than none, so
  // the refusal is the whole outcome — no directory, no row, no job.
  assert.equal(existsSync(system.config.attachmentRoot) ? readdirSync(system.config.attachmentRoot).length : 0, 0);

  // The count bound refuses in the schema, before anything is decoded.
  const many = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: {
      prompt: 'Like these.',
      kind: 'desk',
      attachments: Array.from({ length: 5 }, () => ({ data: PNG.toString('base64') })),
    },
  });
  assert.equal(many.statusCode, 400);
  assert.equal(system.store.listJobs().length, 0);

  await app.close();
  system.store.close();
});

test('a dispatched brief is told where to read its attachment', async () => {
  const system = buildTestSystem();
  const { app } = await buildApp(system);

  await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: {
      prompt: 'Make the panel look like this.',
      kind: 'desk',
      attachments: [{ name: 'panel.png', data: PNG.toString('base64') }],
    },
  });

  const job = system.store.listJobs()[0]!;
  const task = system.store.getTask(system.store.getJob(job.id)!.taskId!)!;
  const attachment = system.store.listAttachments(`job:${job.id}`)[0]!;
  // Appended, not interpolated: the operator's own prompt survives verbatim at
  // the top, so an override that never learned about attachments loses nothing.
  assert.ok(task.prompt.startsWith('Make the panel look like this.'));
  assert.ok(task.prompt.includes(attachment.path), 'the agent is given the absolute path');
  assert.match(task.prompt, /The operator attached an image/);

  // An unrelated dispatch is handed nothing — an attachment belongs to one request.
  const other = system.store.createJob({ title: 'Elsewhere', prompt: 'Something else.', kind: 'desk' });
  await system.harness.runCycle('manual');
  const otherTask = system.store.getTask(system.store.getJob(other.id)!.taskId!)!;
  assert.equal(otherTask.prompt, 'Something else.');

  await app.close();
  system.store.close();
});

test('cancelling a brief forgets its attachments', async () => {
  const system = buildTestSystem();
  const { app } = await buildApp(system);

  // Queued behind the cap so it is still cancellable: the fleet is filled first.
  system.runtimeControl.apply({ paused: true });
  await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: { prompt: 'Like this.', kind: 'desk', attachments: [{ name: 'a.png', data: PNG.toString('base64') }] },
  });
  const job = system.store.listQueuedJobs()[0]!;
  const path = system.store.listAttachments(`job:${job.id}`)[0]!.path;
  assert.ok(existsSync(path));

  const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
  assert.equal(cancelled.statusCode, 200);
  // The one deletion in the story: nothing downstream can want a brief that
  // never ran. Rows first, then the files.
  assert.deepEqual(system.store.listAttachments(`job:${job.id}`), []);
  assert.equal(existsSync(path), false);

  await app.close();
  system.store.close();
});

test('every launch grants read access to the attachment root', () => {
  const system = buildTestSystem();
  // The path in the prompt is outside the agent's worktree, so without this the
  // agent is handed a file it cannot open. It rides in `--settings`, not in
  // `--allowedTools`, so an operator adjusting one cannot clobber the MCP grants.
  const args = buildClaudeStreamArgs({
    allowedTools: ['Bash(npm:*)'],
    additionalDirectories: [system.config.attachmentRoot],
  });
  const settings: unknown = JSON.parse(args[args.indexOf('--settings') + 1]!);
  const permissions = (settings as { permissions: { allow: string[]; additionalDirectories: string[] } }).permissions;
  assert.deepEqual(permissions.allow, ['Bash(npm:*)'], 'the allow-list is untouched by the new key');
  assert.deepEqual(permissions.additionalDirectories, [system.config.attachmentRoot]);
  system.store.close();
});
