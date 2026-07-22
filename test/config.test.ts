import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig returns sane defaults with no overrides', () => {
  const cfg = loadConfig();
  assert.equal(cfg.dispatcher, 'rule');
  assert.equal(cfg.maxConcurrentAgents, 3);
  assert.equal(cfg.autoSend.enabled, false);
  assert.equal(cfg.autoSend.confidenceThreshold, 0.85);
  assert.deepEqual(cfg.autoSend.allowedActions, ['reply_on_pr']);
});

test('issue pickup defaults: no gate, label-encoded priority scheme, medium fallback', () => {
  const cfg = loadConfig();
  assert.equal(cfg.issuePickupLabel, undefined, 'no pickup gate by default (opt-in)');
  assert.deepEqual(cfg.issuePriorityLabels, { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 });
  assert.equal(cfg.issueDefaultPriority, 2);
});

test('issuePickupLabel and priority scheme are overridable', () => {
  const cfg = loadConfig({ issuePickupLabel: 'lubbdubb', issuePriorityLabels: { p0: 5 }, issueDefaultPriority: 1 });
  assert.equal(cfg.issuePickupLabel, 'lubbdubb');
  assert.deepEqual(cfg.issuePriorityLabels, { p0: 5 }, 'the scheme is replaced wholesale, not merged');
  assert.equal(cfg.issueDefaultPriority, 1);
});

test('explicit overrides win over defaults', () => {
  const cfg = loadConfig({ dispatcher: 'claude', maxConcurrentAgents: 7 });
  assert.equal(cfg.dispatcher, 'claude');
  assert.equal(cfg.maxConcurrentAgents, 7);
});

test('autoSend is deep-merged: a partial override keeps the other defaults', () => {
  const cfg = loadConfig({ autoSend: { enabled: true } as never });
  assert.equal(cfg.autoSend.enabled, true, 'the overridden field applies');
  assert.equal(cfg.autoSend.confidenceThreshold, 0.85, 'untouched fields keep their defaults');
  assert.deepEqual(cfg.autoSend.allowedActions, ['reply_on_pr']);
});

test('PORT and LUBBDUBB_DB env vars are honored', () => {
  const prevPort = process.env.PORT;
  const prevDb = process.env.LUBBDUBB_DB;
  try {
    process.env.PORT = '9999';
    process.env.LUBBDUBB_DB = '/tmp/some.sqlite';
    const cfg = loadConfig();
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.dbPath, '/tmp/some.sqlite');
  } finally {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevDb === undefined) delete process.env.LUBBDUBB_DB;
    else process.env.LUBBDUBB_DB = prevDb;
  }
});

test('an explicit override beats an env var for the same key', () => {
  const prev = process.env.PORT;
  try {
    process.env.PORT = '9999';
    const cfg = loadConfig({ port: 1234 });
    assert.equal(cfg.port, 1234);
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
});

test('repoRoot defaults to the launch directory (cwd)', () => {
  const cfg = loadConfig();
  assert.equal(cfg.repoRoot, process.cwd());
});

test('LUBBDUBB_REPO_ROOT env var overrides repoRoot', () => {
  const prev = process.env.LUBBDUBB_REPO_ROOT;
  try {
    process.env.LUBBDUBB_REPO_ROOT = '/srv/some-repo';
    const cfg = loadConfig();
    assert.equal(cfg.repoRoot, '/srv/some-repo');
  } finally {
    if (prev === undefined) delete process.env.LUBBDUBB_REPO_ROOT;
    else process.env.LUBBDUBB_REPO_ROOT = prev;
  }
});

test('a relative repoRoot override is resolved to an absolute path', () => {
  const cfg = loadConfig({ repoRoot: 'some/nested/repo' });
  assert.ok(cfg.repoRoot.startsWith('/'), 'a relative repoRoot is made absolute');
  assert.equal(cfg.repoRoot, resolve(process.cwd(), 'some/nested/repo'));
});

test('an explicit repoRoot override beats the env var', () => {
  const prev = process.env.LUBBDUBB_REPO_ROOT;
  try {
    process.env.LUBBDUBB_REPO_ROOT = '/srv/from-env';
    const cfg = loadConfig({ repoRoot: '/srv/from-override' });
    assert.equal(cfg.repoRoot, '/srv/from-override');
  } finally {
    if (prev === undefined) delete process.env.LUBBDUBB_REPO_ROOT;
    else process.env.LUBBDUBB_REPO_ROOT = prev;
  }
});

test('worktreeRoot and deskRoot default under repoRoot, not the launch dir', () => {
  const cfg = loadConfig({ repoRoot: '/srv/target-repo' });
  assert.equal(cfg.worktreeRoot, resolve('/srv/target-repo', '.lubbdubb/worktrees'));
  assert.equal(cfg.deskRoot, resolve('/srv/target-repo', '.lubbdubb/desk'));
});

test('a relative worktreeRoot/deskRoot override resolves against repoRoot', () => {
  const cfg = loadConfig({ repoRoot: '/srv/target-repo', worktreeRoot: 'wt', deskRoot: 'desk' });
  assert.equal(cfg.worktreeRoot, '/srv/target-repo/wt');
  assert.equal(cfg.deskRoot, '/srv/target-repo/desk');
});

test('an absolute worktreeRoot/deskRoot override is honoured as-is', () => {
  const cfg = loadConfig({ repoRoot: '/srv/target-repo', worktreeRoot: '/var/wt', deskRoot: '/var/desk' });
  assert.equal(cfg.worktreeRoot, '/var/wt');
  assert.equal(cfg.deskRoot, '/var/desk');
});

test('a relative claudeArg that points at a real file is resolved to an absolute path', () => {
  const cfg = loadConfig({ claudeArgs: ['scripts/mock-agent.sh', '--flag'] });
  assert.ok(cfg.claudeArgs[0]!.startsWith('/'), 'existing script path is made absolute');
  assert.ok(cfg.claudeArgs[0]!.endsWith('scripts/mock-agent.sh'));
  assert.equal(cfg.claudeArgs[1], '--flag', 'a non-file arg is left untouched');
});
