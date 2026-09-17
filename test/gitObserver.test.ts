import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCliObserver, type GitObserver } from '../src/git/gitObserver.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';

function recorder(): { record: (input: ErrorLogInput) => ErrorLogEntry; entries: ErrorLogInput[] } {
  const entries: ErrorLogInput[] = [];
  return {
    entries,
    record: (input) => {
      entries.push(input);
      return { id: 'e1', detail: null, createdAt: '', ...input };
    },
  };
}

function gitVersionAtLeast(major: number, minor: number): boolean {
  const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  if (!m) return false;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

// A promisor clone answers a question about an object it does not hold by fetching it — from
// inside a read-only reachability probe. → docs/spec/24-environments.md#the-three-verdicts
function promisorClone(): { clone: string; unfetched: string } | null {
  if (!gitVersionAtLeast(2, 36)) return null;
  const origin = mkdtempSync(join(tmpdir(), 'lubbdubb-promisor-origin-'));
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'uploadpack.allowFilter', 'true']);
  git(origin, ['config', 'user.email', 't@t.com']);
  git(origin, ['config', 'user.name', 'Test']);
  writeFileSync(join(origin, 'a.txt'), 'a');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'one']);

  const clone = join(mkdtempSync(join(tmpdir(), 'lubbdubb-promisor-')), 'clone');
  git(origin, ['clone', '-q', '--filter=blob:none', `file://${origin}`, clone]);

  writeFileSync(join(origin, 'b.txt'), 'b');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'two']);
  return { clone, unfetched: git(origin, ['rev-parse', 'HEAD']) };
}

function packCount(clone: string): number {
  const dir = join(clone, '.git', 'objects', 'pack');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.pack')).length : 0;
}

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

test('a commit this checkout does not hold is unknown, and asking never fetches it', async () => {
  const made = promisorClone();
  if (made === null) return;
  const before = packCount(made.clone);
  const observer = new GitCliObserver(made.clone);

  const answer = await observer.contains([made.unfetched], ['main']);

  assert.equal(answer.get(made.unfetched), null, 'a missing object is unknown, never absent');
  assert.equal(packCount(made.clone), before, 'the probe opened no socket and wrote no pack');
});

test('a clone that could not answer records the failure rather than swallowing it', async () => {
  const errors = recorder();
  const observer = new GitCliObserver(join(tmpdir(), 'lubbdubb-no-such-checkout'), errors);

  const answer = await observer.contains(['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], ['main']);

  assert.equal(answer.get('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), null);
  assert.equal(errors.entries.length, 1, 'unknown everywhere is visible rather than mute');
  assert.match(errors.entries[0]!.message, /could not answer/);
});
