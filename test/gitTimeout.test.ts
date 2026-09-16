import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGit } from '../src/git/gitCli.js';
import { gitRepo } from './support/gitRepo.js';

// A git that never exits used to be a promise that never settled: the pulse pass awaiting it never
// returned, `cycleInFlight` stayed true, and every later cycle coalesced.
// → docs/spec/09-execution.md#a-git-that-never-exits

test('a git subprocess that never exits is killed and rejects rather than hanging', async () => {
  const root = gitRepo();
  // `cat-file --batch` reads requests off stdin until it is closed, and execFile never closes it.
  const failure = await runGit(root, ['cat-file', '--batch'], { timeoutMs: 250 }).then(
    () => null,
    (err: Error) => err,
  );
  assert.ok(failure, 'the call rejects rather than sitting there');
  assert.match(failure.message, /did not exit within 250ms/);
  assert.match(failure.message, /cat-file --batch/, 'the message names the command, so the log says what wedged');
});

test('an ordinary git call is unaffected by the timeout', async () => {
  const root = gitRepo();
  const { stdout } = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(stdout.trim(), 'main');
});

test("a failing git still rejects with git's own error, not the timeout's", async () => {
  const root = gitRepo();
  const failure = await runGit(root, ['rev-parse', '--verify', 'refs/heads/nope']).then(
    () => null,
    (err: Error) => err,
  );
  assert.ok(failure);
  assert.doesNotMatch(failure.message, /did not exit within/);
});

test('an aborted call reports the abort rather than reading as a timeout', async () => {
  const root = gitRepo();
  const controller = new AbortController();
  const pending = runGit(root, ['cat-file', '--batch'], { signal: controller.signal }).then(
    () => null,
    (err: Error) => err,
  );
  controller.abort();
  const failure = await pending;
  assert.ok(failure);
  assert.doesNotMatch(failure.message, /did not exit within/);
});
