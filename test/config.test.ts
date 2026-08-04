import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

test('loadConfig returns sane defaults with no overrides', () => {
  const cfg = loadConfig();
  assert.equal(cfg.maxConcurrentAgents, 3);
  assert.equal(cfg.autoSend.enabled, false);
  assert.equal(cfg.autoSend.confidenceThreshold, 0.85);
  assert.deepEqual(cfg.autoSend.allowedActions, ['reply_on_pr']);
});

test('issue pickup defaults: lubbdubb label prefix, label-encoded priority scheme, medium fallback', () => {
  const cfg = loadConfig();
  assert.equal(cfg.labelPrefix, 'lubbdubb', 'watch/ignore tags derive from the lubbdubb prefix by default');
  assert.equal(cfg.issuePickupRequireOwnLabel, false, 'ownership gate off by default (any tagger counts)');
  assert.deepEqual(cfg.issuePriorityLabels, { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 });
  assert.equal(cfg.issueDefaultPriority, 2);
});

test('labelPrefix and priority scheme are overridable', () => {
  const cfg = loadConfig({
    labelPrefix: 'team',
    issuePickupRequireOwnLabel: true,
    issuePriorityLabels: { p0: 5 },
    issueDefaultPriority: 1,
  });
  assert.equal(cfg.labelPrefix, 'team');
  assert.equal(cfg.issuePickupRequireOwnLabel, true);
  assert.deepEqual(cfg.issuePriorityLabels, { p0: 5 }, 'the scheme is replaced wholesale, not merged');
  assert.equal(cfg.issueDefaultPriority, 1);
});

test('explicit overrides win over defaults', () => {
  const cfg = loadConfig({ startPaused: true, maxConcurrentAgents: 7 });
  assert.equal(cfg.startPaused, true);
  assert.equal(cfg.maxConcurrentAgents, 7);
});

test('autoSend is deep-merged: a partial override keeps the other defaults', () => {
  const cfg = loadConfig({ autoSend: { enabled: true } as never });
  assert.equal(cfg.autoSend.enabled, true, 'the overridden field applies');
  assert.equal(cfg.autoSend.confidenceThreshold, 0.85, 'untouched fields keep their defaults');
  assert.deepEqual(cfg.autoSend.allowedActions, ['reply_on_pr']);
});

test('the funnel, the assessor, the assay and the retrospective are on by default', () => {
  const cfg = loadConfig();
  assert.equal(cfg.planning.enabled, true);
  assert.equal(cfg.assessment.enabled, true);
  assert.equal(cfg.assay.enabled, true);
  assert.equal(cfg.retrospective.enabled, true);
  // Unchanged, and deliberately: the three above spend an agent, while this one
  // sends things out into the world with no human in the loop. Different class of
  // switch, different default.
  assert.equal(cfg.autoSend.enabled, false);
});

test('the planning funnel is deep-merged when overridden', () => {
  assert.deepEqual(loadConfig().planning, {
    enabled: true,
    maxConcurrentPartsPerIssue: 2,
    // On by default (issue #109 phase 3): a deployment that never turns the
    // funnel on sees no difference, since `enabled` gates the whole thing —
    // but the moment it is turned on, a decomposition is put to a human first.
    requireApproval: true,
    gitFetchIntervalMs: 60_000,
  });
  const cfg = loadConfig({ planning: { enabled: false } as never });
  assert.equal(cfg.planning.enabled, false);
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 2, 'untouched fields keep their defaults');
  // Turning the funnel on must not also change how a verdict lands: this default
  // is carried over unmerged, the same as the other untouched fields above.
  assert.equal(cfg.planning.requireApproval, true);
  assert.equal(cfg.planning.gitFetchIntervalMs, 60_000);
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

test('defaultBranch defaults to main and is overridable', () => {
  assert.equal(loadConfig().defaultBranch, 'main');
  assert.equal(loadConfig({ defaultBranch: 'trunk' }).defaultBranch, 'trunk');
});

test('a relative claudeArg that points at a real file is resolved to an absolute path', () => {
  const cfg = loadConfig({ claudeArgs: ['scripts/mock-agent.sh', '--flag'] });
  assert.ok(cfg.claudeArgs[0]!.startsWith('/'), 'existing script path is made absolute');
  assert.ok(cfg.claudeArgs[0]!.endsWith('scripts/mock-agent.sh'));
  assert.equal(cfg.claudeArgs[1], '--flag', 'a non-file arg is left untouched');
});

/**
 * A removed key merges into nothing and takes the default, so the harness would
 * do the opposite of what the file says while the file went on saying it — the
 * silent-ignore failure `validatePolicyCheckModes` exists to prevent, one level
 * up. Driven through a real file in a temp cwd because the removed-key check
 * reads the *file's own* JSON: the keys are gone from `Config`, so an override
 * object cannot carry one.
 */
test('a config file naming a removed key is refused, with the key named', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [key, value] of [
    ['dispatcher', 'claude'],
    ['steeringPriorities', ['ship the release']],
  ] as const) {
    writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ [key]: value }), 'utf8');
    assert.throws(
      () => loadConfig(),
      (err: Error) => err.message.includes(key) && err.message.includes('no longer exists'),
      `${key} must be refused by name`,
    );
  }

  // The check is per key, not a blanket refusal of an unfamiliar file.
  writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ maxConcurrentAgents: 9 }), 'utf8');
  assert.equal(loadConfig().maxConcurrentAgents, 9);
});
