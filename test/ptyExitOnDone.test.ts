import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function session(backend: FakePtyBackend, opts: Partial<ConstructorParameters<typeof PtySession>[1]> = {}) {
  return new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 5,
    ...opts,
  });
}

test('exitOnDone: the done sentinel triggers /exit + Enter into the pty', async () => {
  const backend = new FakePtyBackend();
  const s = session(backend, { exitOnDone: true, exitGraceMs: 1000 });
  let done = false;
  s.on('done', () => (done = true));
  s.start();
  backend.last().emit('all finished\r\n@@LUBBDUBB_DONE@@\r\n');
  assert.equal(done, true);
  assert.equal(s.status, 'done');
  // /exit is written immediately; the submitting CR lands as its own later write
  // (same paste-vs-Enter split as send()).
  assert.deepEqual(backend.last().writes, ['/exit']);
  await tick(20);
  assert.deepEqual(backend.last().writes, ['/exit', '\r']);
});

test('exitOnDone: a process that obeys /exit is not killed', async () => {
  const backend = new FakePtyBackend();
  const s = session(backend, { exitOnDone: true, exitGraceMs: 30 });
  let failed = false;
  s.on('failed', () => (failed = true));
  s.start();
  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  await tick(15);
  backend.last().emitExit(0); // REPL exits in response to /exit
  await tick(40); // past the grace period
  assert.equal(backend.last().killed, false);
  assert.equal(s.status, 'done');
  assert.equal(failed, false, 'the teardown exit must not be reclassified as a failure');
});

test('exitOnDone: a process that ignores /exit is killed after the grace period', async () => {
  const backend = new FakePtyBackend();
  const s = session(backend, { exitOnDone: true, exitGraceMs: 20 });
  let failed = false;
  let exitCode: number | null = null;
  s.on('failed', () => (failed = true));
  s.on('exit', (code: number) => (exitCode = code));
  s.start();
  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  assert.equal(backend.last().killed, false, 'grace period should come first');
  await tick(50);
  assert.equal(backend.last().killed, true);
  assert.equal(exitCode, 143);
  assert.equal(s.status, 'done', 'the backstop kill must not reclassify a done session');
  assert.equal(failed, false);
});

test('exitOnDone off (raw/mock sessions): done writes nothing and kills nothing', async () => {
  const backend = new FakePtyBackend();
  const s = session(backend);
  s.start();
  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  await tick(40);
  assert.deepEqual(backend.last().writes, []);
  assert.equal(backend.last().killed, false);
});

test('exitOnDone: a done that came from the process exiting itself needs no teardown', async () => {
  const backend = new FakePtyBackend();
  const s = session(backend, { exitOnDone: true, exitGraceMs: 20 });
  s.start();
  backend.last().emit('output with no sentinel\r\n');
  backend.last().emitExit(0);
  await tick(40);
  assert.equal(s.status, 'done');
  assert.deepEqual(backend.last().writes, []);
  assert.equal(backend.last().killed, false);
});
