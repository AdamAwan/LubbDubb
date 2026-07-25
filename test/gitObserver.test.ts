import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCliObserver, type GitObserver } from '../src/git/gitObserver.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-observer-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  git(dir, ['checkout', '-q', '-B', 'trunk']);
  return dir;
}

/** Commit a file on `branch`, creating it from wherever HEAD is. */
function commitOn(dir: string, branch: string, file: string): void {
  git(dir, ['checkout', '-q', '-B', branch]);
  writeFileSync(join(dir, file), file);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `add ${file}`]);
}

test('reports a branch present locally, on the remote, or nowhere', async () => {
  const repo = initRepo();
  commitOn(repo, 'local-only', 'a.txt');
  git(repo, ['update-ref', 'refs/remotes/origin/remote-only', git(repo, ['rev-parse', 'trunk'])]);
  git(repo, ['update-ref', 'refs/remotes/origin/local-only', git(repo, ['rev-parse', 'local-only'])]);
  const observer: GitObserver = new GitCliObserver(repo);

  assert.deepEqual(await observer.presence('local-only'), { local: true, remote: true });
  assert.deepEqual(await observer.presence('remote-only'), { local: false, remote: true });
  assert.deepEqual(await observer.presence('nowhere'), { local: false, remote: false });
});

test('counts how far a branch is ahead of and behind its base', async () => {
  const repo = initRepo();
  commitOn(repo, 'part', 'part.txt');
  commitOn(repo, 'part', 'part2.txt');
  git(repo, ['checkout', '-q', 'trunk']);
  commitOn(repo, 'trunk', 'trunk.txt');
  const observer = new GitCliObserver(repo);

  assert.deepEqual(await observer.divergence('part', 'trunk'), { ahead: 2, behind: 1 });
  assert.deepEqual(await observer.divergence('trunk', 'part'), { ahead: 1, behind: 2 });
});

test('divergence is null when either side names nothing', async () => {
  const repo = initRepo();
  const observer = new GitCliObserver(repo);

  assert.equal(await observer.divergence('nowhere', 'trunk'), null);
  assert.equal(await observer.divergence('trunk', 'nowhere'), null);
});

test('a branch has commits beyond its base only once it carries work', async () => {
  const repo = initRepo();
  // A branch cut from the base but not committed on is exactly what a dispatched
  // part looks like before it pushes — existing, but nothing to stack on.
  git(repo, ['branch', 'empty', 'trunk']);
  commitOn(repo, 'pushed', 'work.txt');
  const observer = new GitCliObserver(repo);

  assert.equal(await observer.hasCommitsBeyond('empty', 'trunk'), false);
  assert.equal(await observer.hasCommitsBeyond('pushed', 'trunk'), true);
  assert.equal(await observer.hasCommitsBeyond('nowhere', 'trunk'), false);
});

test('a branch name resolves through origin/<name> ahead of the local ref', async () => {
  const repo = initRepo();
  commitOn(repo, 'part', 'one.txt');
  const staleLocal = git(repo, ['rev-parse', 'part']);
  commitOn(repo, 'part', 'two.txt');
  git(repo, ['update-ref', 'refs/remotes/origin/part', git(repo, ['rev-parse', 'part'])]);
  // Roll the local ref back so the two disagree, then check which one is counted.
  git(repo, ['checkout', '-q', 'trunk']);
  git(repo, ['update-ref', 'refs/heads/part', staleLocal]);
  const observer = new GitCliObserver(repo);

  assert.deepEqual(await observer.divergence('part', 'trunk'), { ahead: 2, behind: 0 });
});

test('the fake answers what it was scripted with, and records the questions', async () => {
  const observer: GitObserver = new FakeGitObserver()
    .setPresence('issue/12/schema', { remote: true })
    .setDivergence('issue/12/schema', 'main', { ahead: 3, behind: 1 });

  assert.deepEqual(await observer.presence('issue/12/schema'), { local: false, remote: true });
  assert.deepEqual(await observer.divergence('issue/12/schema', 'main'), { ahead: 3, behind: 1 });
  assert.equal(await observer.hasCommitsBeyond('issue/12/schema', 'main'), true);

  // Undeclared branches read as "nowhere", so a test states only what it cares about.
  assert.deepEqual(await observer.presence('issue/12/dispatcher'), { local: false, remote: false });
  assert.equal(await observer.divergence('issue/12/dispatcher', 'main'), null);
  assert.equal(await observer.hasCommitsBeyond('issue/12/dispatcher', 'main'), false);

  assert.deepEqual((observer as FakeGitObserver).calls, [
    'presence:issue/12/schema',
    'divergence:issue/12/schema...main',
    'divergence:issue/12/schema...main',
    'presence:issue/12/dispatcher',
    'divergence:issue/12/dispatcher...main',
    'divergence:issue/12/dispatcher...main',
  ]);
});

test('the fake distinguishes an existing branch from one with commits', async () => {
  const observer = new FakeGitObserver()
    .setPresence('issue/12/schema', { local: true, remote: true })
    .setDivergence('issue/12/schema', 'main', { ahead: 0, behind: 0 });

  assert.equal((await observer.presence('issue/12/schema')).remote, true);
  assert.equal(await observer.hasCommitsBeyond('issue/12/schema', 'main'), false);
});
