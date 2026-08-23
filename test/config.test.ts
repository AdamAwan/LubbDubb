import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DEEP_MERGED_BLOCKS, loadConfig, loadDeploymentConfig } from '../src/config.js';
import { CONFIG_FIELDS } from '../src/configFields.js';
import { ticketAssignee } from '../src/ticketAssignment.js';

test('loadConfig returns sane defaults with no overrides', () => {
  const cfg = loadConfig();
  assert.equal(cfg.maxConcurrentAgents, 3);
  assert.equal(cfg.userId, undefined, 'no identity is assumed — the three "me" gates are off until one is set');
});

test('issue pickup defaults: lubbdubb label prefix, label-encoded priority scheme, medium fallback', () => {
  const cfg = loadConfig();
  assert.equal(cfg.labelPrefix, 'lubbdubb', 'watch/ignore tags derive from the lubbdubb prefix by default');
  assert.deepEqual(cfg.issuePriorityLabels, { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 });
  assert.equal(cfg.issueDefaultPriority, 2);
});

test('labelPrefix and priority scheme are overridable', () => {
  const cfg = loadConfig({
    labelPrefix: 'team',
    issuePriorityLabels: { p0: 5 },
    issueDefaultPriority: 1,
  });
  assert.equal(cfg.labelPrefix, 'team');
  assert.deepEqual(cfg.issuePriorityLabels, { p0: 5 }, 'the scheme is replaced wholesale, not merged');
  assert.equal(cfg.issueDefaultPriority, 1);
});

test('explicit overrides win over defaults', () => {
  const cfg = loadConfig({ startPaused: true, maxConcurrentAgents: 7 });
  assert.equal(cfg.startPaused, true);
  assert.equal(cfg.maxConcurrentAgents, 7);
});

test('one userId answers ownership, assignment and PR authorship together', () => {
  // The six keys this replaced were one fact spelled per provider and per use, and
  // could disagree with each other. Now there is one string and nothing to skew.
  const cfg = loadConfig({
    userId: 'adam',
    github: { owner: 'acme', repo: 'app' },
    integrations: { sourceControl: 'github', issues: 'github' },
  });
  assert.equal(cfg.userId, 'adam');
  assert.equal(ticketAssignee(cfg), 'adam', 'filed tickets go to them');
});

test('an unset userId leaves every identity gate off rather than guessing one', () => {
  const cfg = loadConfig({
    github: { owner: 'acme', repo: 'app' },
    integrations: { sourceControl: 'github', issues: 'github' },
  });
  assert.equal(ticketAssignee(cfg), null, 'nothing to assign to, so tickets file unassigned');
});

test('the planning funnel is deep-merged when overridden', () => {
  assert.deepEqual(loadConfig().planning, {
    maxConcurrentPartsPerIssue: 2,
    gitFetchIntervalMs: 60_000,
  });
  const cfg = loadConfig({ planning: { maxConcurrentPartsPerIssue: 4 } as never });
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 4);
  // Setting one field must not blank the others: this default is carried over
  // unmerged, which is the whole of what deep-merging the key buys.
  assert.equal(cfg.planning.gitFetchIntervalMs, 60_000);
});

test('PORT and LUBBDUBB_DB env vars are honored', () => {
  const prevPort = process.env.PORT;
  const prevDb = process.env.LUBBDUBB_DB;
  try {
    process.env.PORT = '9999';
    process.env.LUBBDUBB_DB = '/tmp/some.sqlite';
    const cfg = loadDeploymentConfig();
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.dbPath, '/tmp/some.sqlite');
    assert.equal(loadConfig().port, 4300, 'loadConfig reads no env var');
    assert.equal(loadConfig().dbPath, '.lubbdubb/lubbdubb.sqlite');
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
    const cfg = loadDeploymentConfig({ port: 1234 });
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
    const cfg = loadDeploymentConfig();
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
    const cfg = loadDeploymentConfig({ repoRoot: '/srv/from-override' });
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
    // A file asking the harness to act on a pull request without being asked is
    // asking for the one thing it will now never do, so this is a refusal rather
    // than a drop: honouring it is impossible and ignoring it would have the
    // harness do the opposite of what the file goes on saying.
    ['autoSend', { enabled: true, allowedActions: ['merge_pr'] }],
  ] as const) {
    writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ [key]: value }), 'utf8');
    assert.throws(
      () => loadDeploymentConfig(),
      (err: Error) => err.message.includes(key) && err.message.includes('no longer exists'),
      `${key} must be refused by name`,
    );
  }

  // The check is per key, not a blanket refusal of an unfamiliar file.
  writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ maxConcurrentAgents: 9 }), 'utf8');
  assert.equal(loadDeploymentConfig().maxConcurrentAgents, 9);
});

/**
 * Somebody has a file with `"planning": {"enabled": false}` in it. That key named
 * a switch that no longer exists, so it can neither be honoured nor refused: the
 * behaviour it asked for is gone, and refusing would take their harness down at
 * boot over one stale line. It warns, drops the key, and boots.
 */
test('a config file setting a retired switch warns and boots rather than refusing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string): void => void warnings.push(msg);
  t.after(() => {
    console.warn = realWarn;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({
      planning: { enabled: false, maxConcurrentPartsPerIssue: 4 },
      validation: { enabled: false, desktopClaimMinutes: 30 },
    }),
    'utf8',
  );

  const cfg = loadDeploymentConfig();
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 4, 'the rest of the block is still honoured');
  assert.equal(cfg.validation.desktopClaimMinutes, 30);
  // Dropped rather than merged into nothing: a value left on the policy object
  // is one something later can read.
  assert.ok(!Object.hasOwn(cfg.planning, 'enabled'));
  assert.ok(!Object.hasOwn(cfg.validation, 'enabled'));
  assert.equal(warnings.length, 2, 'and the operator hears about both, by name');
  assert.ok(warnings.some((w) => w.includes('planning.enabled')));
  assert.ok(warnings.some((w) => w.includes('validation.enabled')));
});

/**
 * The two switches this cleanup retired, together because they fail the same way
 * and in opposite directions. A file turning plan approval off is getting the gate
 * back — N branches and N agents now wait for a click that deployment was not
 * expecting to have to give. A file pinning the worktree pool below its cap is
 * getting a *bigger* pool: more checkouts on a disk somebody sized deliberately.
 * Neither is visible from the fleet's behaviour in time to be understood, so both
 * are named on the boot log.
 */
test('the retired approval gate and pool bound are dropped by name, and the harness boots', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string): void => void warnings.push(msg);
  t.after(() => {
    console.warn = realWarn;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({
      planning: { requireApproval: false, maxConcurrentPartsPerIssue: 4 },
      worktreePoolSize: 1,
      maxConcurrentAgents: 9,
    }),
    'utf8',
  );

  const cfg = loadDeploymentConfig();
  assert.equal(cfg.maxConcurrentAgents, 9, 'the rest of the file is still honoured');
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 4, 'and the rest of the block');
  // Dropped rather than merged into nothing: a value left on the policy object is
  // one something later can read, and both of these read as a decision.
  assert.ok(!Object.hasOwn(cfg.planning, 'requireApproval'));
  assert.ok(!Object.hasOwn(cfg, 'worktreePoolSize'));
  assert.ok(warnings.some((w) => w.includes('planning.requireApproval')));
  assert.ok(warnings.some((w) => w.includes('worktreePoolSize')));
});

/**
 * The desktop channel's own retirement, kept separate because its shape is the
 * one the list is for: the deployment on the other end of this warning switched
 * the channel *off*, and is getting it back — a socket bound, a credential and a
 * skill written into a home directory that never asked for either. That has to
 * come from the boot log rather than from finding the files.
 */
test('a config file switching the desktop channel off loads, drops the key and says so', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string): void => void warnings.push(msg);
  t.after(() => {
    console.warn = realWarn;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({ validation: { desktop: false, desktopSkillPath: '/tmp/skill.md' } }),
    'utf8',
  );

  const cfg = loadDeploymentConfig();
  assert.equal(cfg.validation.desktopSkillPath, '/tmp/skill.md', 'the paths are still real choices');
  assert.ok(!Object.hasOwn(cfg.validation, 'desktop'), 'and nothing later can read the value back off the policy');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes('validation.desktop'));
});

/**
 * The same mechanism over a **top-level** key and a whole block. Both forms are in
 * the list because a block whose every field went unconditional is removed whole,
 * while an operator's file names the block rather than the field inside it — so
 * dropping only `mcp.enabled` would leave `mcp: {}` merging into a config that no
 * longer has the key.
 */
test('a retired top-level key and a retired whole block are both dropped, not merged into nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string): void => void warnings.push(msg);
  t.after(() => {
    console.warn = realWarn;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({
      reapMergedBranches: false,
      issuePickupRequireOwnLabel: true,
      mcp: { enabled: false, permissionEscalation: false },
      assay: { enabled: false },
      github: { owner: 'acme', repo: 'app', defaultAssignee: 'someone-else' },
      maxConcurrentAgents: 9,
    }),
    'utf8',
  );

  const cfg = loadDeploymentConfig();
  assert.equal(cfg.maxConcurrentAgents, 9, 'the rest of the file is still honoured');
  assert.deepEqual(cfg.github, { owner: 'acme', repo: 'app' }, 'the block survives, the retired field does not');
  for (const key of ['reapMergedBranches', 'issuePickupRequireOwnLabel', 'mcp', 'assay'] as const) {
    assert.ok(!Object.hasOwn(cfg, key), `${key} must not survive onto the config object`);
    assert.ok(
      warnings.some((w) => w.includes(key)),
      `${key} must be named on the boot log`,
    );
  }
  // The deployment that switched these off is getting them back, and has to hear
  // it from the harness rather than from the fleet's behaviour.
  assert.ok(warnings.every((w) => w.includes('no longer exists')));
});

/**
 * The isolation the split exists for. The suite runs in a working copy of this
 * repo, so an operator's own `lubbdubb.config.json` sitting beside it would
 * otherwise merge into every test that builds a config — silently, and
 * differently on each machine.
 */
test('loadConfig ignores a config file in the launch directory; loadDeploymentConfig reads it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({ maxConcurrentAgents: 42, planning: { maxConcurrentPartsPerIssue: 5 } }),
    'utf8',
  );

  const pure = loadConfig();
  assert.equal(pure.maxConcurrentAgents, 3, 'the file is not a layer loadConfig knows about');
  assert.equal(pure.planning.maxConcurrentPartsPerIssue, 2);

  const deployed = loadDeploymentConfig();
  assert.equal(deployed.maxConcurrentAgents, 42);
  assert.equal(deployed.planning.maxConcurrentPartsPerIssue, 5);
  assert.equal(deployed.planning.gitFetchIntervalMs, 60_000, 'a nested block from the file still deep-merges');
});

/**
 * Three layers fold into the one argument `loadConfig` takes, so the fold has to
 * preserve the deep merge: an explicit `{planning: {…}}` must not drop the
 * `planning` fields the operator's file set.
 */
test('an explicit nested override deep-merges over the config file, not replacing it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({ planning: { gitFetchIntervalMs: 5_000, maxConcurrentPartsPerIssue: 7 } }),
    'utf8',
  );

  const cfg = loadDeploymentConfig({ planning: { gitFetchIntervalMs: 0 } as never });
  assert.equal(cfg.planning.gitFetchIntervalMs, 0, 'the explicit layer wins the field it sets');
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 7, "the file's other fields survive");
});

/**
 * The layer a *team* shares: one file, committed in the repository the harness
 * works on, that every member's harness reads and any of them can override
 * locally. Driven through a real temp cwd and a real temp repo for the
 * removed-key test's reason — the layering is about two files on disk, and an
 * override object cannot stand in for either of them.
 */
test('a project config in repoRoot sits under the operator’s own file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const repo = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // What a team commits: the branch they integrate on, the CI routing, and the
  // environments their work travels through.
  writeFileSync(
    join(repo, 'lubbdubb.project.json'),
    JSON.stringify({
      defaultBranch: 'trunk',
      ci: { checks: [{ match: 'lint', onFailure: 'dispatch' }] },
      environments: [{ name: 'staging', at: 'echo abc123' }],
      userId: 'the-team-bot',
      planning: { maxConcurrentPartsPerIssue: 5 },
    }),
    'utf8',
  );
  // What one member keeps to themselves.
  writeFileSync(
    join(dir, 'lubbdubb.config.json'),
    JSON.stringify({ repoRoot: repo, userId: 'adam', planning: { gitFetchIntervalMs: 0 } }),
    'utf8',
  );

  const cfg = loadDeploymentConfig();
  assert.equal(cfg.defaultBranch, 'trunk', 'the team’s value is taken where the operator says nothing');
  assert.equal(cfg.ci.checks.length, 1);
  assert.deepEqual(
    cfg.environments.map((env) => env.name),
    ['staging'],
  );
  assert.equal(cfg.userId, 'adam', 'and beaten where they do');
  // The deep-merged blocks merge *between* the two files, which is the whole
  // point of sharing one: a team's planning policy and a member's are one block,
  // not whichever file was read last.
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 5);
  assert.equal(cfg.planning.gitFetchIntervalMs, 0);

  // An explicit override still has the last word over both.
  assert.equal(loadDeploymentConfig({ defaultBranch: 'release' }).defaultBranch, 'release');
});

test('an env override beats the project config, as it beats the operator’s own file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const repo = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const cwd = process.cwd();
  const prev = process.env.PORT;
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  writeFileSync(join(repo, 'lubbdubb.project.json'), JSON.stringify({ port: 5555 }), 'utf8');
  writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ repoRoot: repo }), 'utf8');
  assert.equal(loadDeploymentConfig().port, 5555, 'with nothing above it, the team’s value stands');

  process.env.PORT = '9999';
  assert.equal(loadDeploymentConfig().port, 9999);
});

/**
 * The one key a project config cannot set. The file was found *because*
 * `repoRoot` resolved, so a value in it could only describe the search that found
 * it — honouring it would mean reading the file from somewhere else, and dropping
 * it would leave the fleet pointed at a repository the file in front of the
 * operator disagrees with. Refused by name, like a removed key.
 */
test('a project config setting repoRoot is refused by name', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const repo = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  writeFileSync(join(repo, 'lubbdubb.project.json'), JSON.stringify({ repoRoot: '/srv/elsewhere' }), 'utf8');
  writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ repoRoot: repo }), 'utf8');
  assert.throws(
    () => loadDeploymentConfig(),
    (err: Error) => err.message.includes('repoRoot') && err.message.includes('lubbdubb.project.json'),
    'the refusal names the key and the file',
  );
});

/** A project config is held to the same standard as an operator's own file. */
test('a project config naming a removed key is refused, and a retired one warns', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const repo = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const cwd = process.cwd();
  const realWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string): void => void warnings.push(msg);
  process.chdir(dir);
  t.after(() => {
    console.warn = realWarn;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  writeFileSync(join(dir, 'lubbdubb.config.json'), JSON.stringify({ repoRoot: repo }), 'utf8');
  writeFileSync(join(repo, 'lubbdubb.project.json'), JSON.stringify({ dispatcher: 'claude' }), 'utf8');
  assert.throws(
    () => loadDeploymentConfig(),
    (err: Error) => err.message.includes('dispatcher') && err.message.includes('lubbdubb.project.json'),
  );

  writeFileSync(
    join(repo, 'lubbdubb.project.json'),
    JSON.stringify({ planning: { enabled: false, maxConcurrentPartsPerIssue: 4 } }),
    'utf8',
  );
  const cfg = loadDeploymentConfig();
  assert.equal(cfg.planning.maxConcurrentPartsPerIssue, 4);
  assert.ok(!Object.hasOwn(cfg.planning, 'enabled'));
  assert.ok(
    warnings.some((line) => line.includes('planning.enabled') && line.includes('lubbdubb.project.json')),
    'the warning names the file the stale key is in, which is not the one the operator edits',
  );
});

/**
 * `repoRoot` is settled from the operator's layers alone and *before* the project
 * file is looked for — a layer cannot be consulted about where to find itself.
 */
test('the project config is read from the repoRoot the operator’s layers resolve to', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-config-'));
  const repo = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const cwd = process.cwd();
  const prev = process.env.LUBBDUBB_REPO_ROOT;
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.LUBBDUBB_REPO_ROOT;
    else process.env.LUBBDUBB_REPO_ROOT = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  writeFileSync(join(repo, 'lubbdubb.project.json'), JSON.stringify({ defaultBranch: 'trunk' }), 'utf8');
  assert.equal(loadDeploymentConfig().defaultBranch, 'main', 'no project file at the default repoRoot');

  process.env.LUBBDUBB_REPO_ROOT = repo;
  assert.equal(loadDeploymentConfig().defaultBranch, 'trunk', 'the env layer moves repoRoot, and the file follows');

  delete process.env.LUBBDUBB_REPO_ROOT;
  assert.equal(loadDeploymentConfig({ repoRoot: repo }).defaultBranch, 'trunk', 'and so does an explicit override');
});

test('loadConfig refuses a localRunRoot that overlaps the worktree pool', () => {
  // The invariant lived only in prose — two specs, CLAUDE.md and a `why` string —
  // held up by nothing but the shipped defaults being siblings. An operator who
  // moves the local run "next to the worktrees" gets a config the loader accepts
  // and the pool then leases, wipes and switches onto an agent's branch.
  const repoRoot = resolve('/tmp/ld-overlap');
  const under = () =>
    loadConfig({ repoRoot, worktreeRoot: '.lubbdubb/worktrees', localRunRoot: '.lubbdubb/worktrees/local-run' });
  assert.throws(under, /localRunRoot/, 'the refusal names the key the operator set');
  assert.throws(under, /worktreeRoot/, 'and the one it collides with');

  assert.throws(
    () => loadConfig({ repoRoot, worktreeRoot: '.lubbdubb/pool', localRunRoot: '.lubbdubb/pool' }),
    /overlaps/,
    'the same path twice is the pair at its worst, and `relative()` reads it as neither under the other',
  );
  assert.throws(
    () => loadConfig({ repoRoot, worktreeRoot: '.lubbdubb/local-run/pool', localRunRoot: '.lubbdubb/local-run' }),
    /overlaps/,
    'and the containment is refused in both directions',
  );

  assert.doesNotThrow(() => loadConfig({ repoRoot }), 'the shipped defaults are siblings');
  assert.doesNotThrow(
    () => loadConfig({ repoRoot, worktreeRoot: '/tmp/ld-pool', localRunRoot: '/tmp/ld-preview' }),
    'and so is any pair that does not overlap',
  );
});

test('every block the config form edits per leaf is deep-merged', () => {
  // The structural half of the same defect, and the durable one: three blocks
  // (`ci`, `github`, `azureDevOps`) offered per-leaf edits while replacing
  // wholesale, so one saved leaf dropped everything the project layer set under
  // the same key. Hand-picking the three would leave the next block added free to
  // re-open it, so the rule is asserted over the whole field list instead.
  const deep = new Set<string>(DEEP_MERGED_BLOCKS);
  const perLeaf = new Set(
    CONFIG_FIELDS.map((field) => field.path)
      .filter((path) => path.includes('.'))
      .map((path) => path.split('.')[0] ?? ''),
  );
  const replacing = [...perLeaf].filter((key) => !deep.has(key)).sort();
  assert.deepEqual(
    replacing,
    [],
    'a block the form offers per-leaf edits over must be deep-merged, or a save of one leaf drops the rest',
  );
});
