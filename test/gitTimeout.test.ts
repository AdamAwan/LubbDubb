import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

// A promisor clone turns a read-only question into a `git fetch` grandchild, which inherits the
// stdio pipes: killing the direct child leaves the fetch running and the promise unsettled.
// → docs/spec/09-execution.md#a-git-that-never-exits
test(
  'the deadline reaps the whole subtree, not just the git it started',
  { skip: process.platform === 'win32' },
  async () => {
    const root = gitRepo();
    const marker = join(root, 'grandchild-lived');
    const failure = await runGit(root, ['-c', `alias.spawn=!sh -c "sleep 3 && touch ${marker}" &`, 'spawn'], {
      timeoutMs: 250,
    }).then(
      () => null,
      (err: Error) => err,
    );

    assert.ok(failure, 'the call rejects at its deadline even though git itself exited at once');
    assert.match(failure.message, /did not exit within 250ms/);

    await delay(4000);
    assert.equal(existsSync(marker), false, 'the grandchild holding the pipes was reaped with it');
  },
);

test('a read-only call runs with lazy fetching off', async () => {
  const root = gitRepo();
  const { stdout } = await runGit(root, ['-c', 'alias.saw=!printf %s "$GIT_NO_LAZY_FETCH"', 'saw'], {
    noLazyFetch: true,
  });
  assert.equal(stdout.trim(), '1');

  const plain = await runGit(root, ['-c', 'alias.saw=!printf %s "$GIT_NO_LAZY_FETCH"', 'saw']);
  assert.equal(plain.stdout.trim(), '', 'a call that may legitimately fetch is left alone');
});
