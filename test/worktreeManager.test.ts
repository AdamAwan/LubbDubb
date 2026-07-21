import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

test('creates a new worktree on a new branch and reuses it', async () => {
  const repo = initRepo();
  const wt = new WorktreeManager(repo, join(repo, '.wt'));

  const path1 = await wt.ensure('feature/x');
  assert.ok(path1.includes('feature-x'));

  // Reused, not recreated.
  const path2 = await wt.ensure('feature/x');
  assert.equal(path1, path2);

  const existing = await wt.findExisting('feature/x');
  assert.equal(existing, path1);
});

test('checks out an existing branch into a worktree', async () => {
  const repo = initRepo();
  execFileSync('git', ['branch', 'existing'], { cwd: repo });
  const wt = new WorktreeManager(repo, join(repo, '.wt'));
  const path = await wt.ensure('existing');
  assert.ok(path.includes('existing'));
});
