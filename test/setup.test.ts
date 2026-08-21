import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { diffConfig } from '../src/configApply.js';
import type { SetupProbes } from '../src/setup/probes.js';
import { buildSetupReading } from '../src/setup/reading.js';
import { parseRemote, credentialVar } from '../src/setup/remote.js';
import { resolveFromRepo } from '../src/setup/resolve.js';
import { buildSystem } from '../src/system.js';

/**
 * A scripted stand-in for the shell-outs. Every field is overridable so a test
 * states only the fact it is about — the same shape the provider fakes use, for
 * the same reason: a probe that reached a real git or a real PATH would answer
 * differently on every developer's machine and in CI.
 */
function probes(over: Partial<SetupProbes> = {}): SetupProbes {
  return {
    originUrl: () => Promise.resolve('git@github.com:acme/app.git'),
    isRepo: () => Promise.resolve(true),
    gitEmail: () => Promise.resolve('adam@acme.com'),
    commitFor: () => Promise.resolve('4f2a91c'),
    remoteHead: () => Promise.resolve('main'),
    agentVersion: () => Promise.resolve('2.1.4'),
    viewerLogin: () => Promise.resolve('adamawan'),
    installRoot: () => '/srv/lubbdubb',
    env: () => undefined,
    ...over,
  };
}

// `loadConfig`, never `loadDeploymentConfig`: the suite runs in a working copy of
// this repo, so the deployment loader would fold in whatever config the developer
// runs the app with and the test would pass or fail by machine.
function config(over: Parameters<typeof loadConfig>[0] = {}) {
  return loadConfig({ dbPath: ':memory:', ...over });
}

test('an SSH remote and an HTTPS remote read as the same target', () => {
  for (const url of [
    'git@github.com:acme/app.git',
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'ssh://git@github.com/acme/app.git',
  ]) {
    const target = parseRemote(url);
    assert.equal(target?.provider, 'github', url);
    assert.deepEqual([...(target?.parts ?? [])], ['acme', 'app'], url);
  }
});

test('both of Azure DevOps’ URL shapes resolve organization, project and repository', () => {
  const https = parseRemote('https://dev.azure.com/contoso/Platform/_git/api');
  assert.equal(https?.provider, 'azure');
  assert.deepEqual([...(https?.parts ?? [])], ['contoso', 'Platform', 'api']);

  const ssh = parseRemote('git@ssh.dev.azure.com:v3/contoso/Platform/api');
  assert.equal(ssh?.provider, 'azure');
  assert.deepEqual([...(ssh?.parts ?? [])], ['contoso', 'Platform', 'api']);
});

test('a remote naming no provider this harness speaks reads as null, never as the fake one', () => {
  // The whole point of the third answer: `fake` invents a world, so an
  // unreadable remote resolved to it would show the operator a backlog that
  // does not exist and call it theirs.
  assert.equal(parseRemote('git@gitlab.example.com:acme/app.git'), null);
  assert.equal(parseRemote('/srv/git/bare.git'), null);
  assert.equal(parseRemote(''), null);
  assert.equal(credentialVar('fake'), null);
});

test('the two answers derive the provider, the target and the branch without being told any of them', async () => {
  const resolved = await resolveFromRepo(
    { email: 'adam@acme.com', repoRoot: mkdtempSync(join(tmpdir(), 'lubbdubb-setup-')) },
    { probes: probes({ env: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_x' : undefined) }), config: config() },
  );
  assert.equal(resolved.target?.provider, 'github');
  assert.deepEqual([...(resolved.target?.parts ?? [])], ['acme', 'app']);
  assert.equal(resolved.defaultBranch?.name, 'main');
  assert.equal(resolved.identity.userId, 'adamawan');
  assert.equal(resolved.identity.confidence, 'confirmed');
  // Leaf paths, never nested objects. `POST /api/config` validates every key
  // against `CONFIG_FIELDS`, which holds leaves only, so an `integrations` here is
  // refused at the preview with the operator's whole answer one field away from
  // being written — see `test/setupWrites.test.ts`, which holds this against the
  // registry rather than against a literal.
  assert.equal(resolved.writes['integrations.sourceControl'], 'github');
  assert.equal(resolved.writes['integrations.issues'], 'github');
  assert.equal(resolved.writes['github.owner'], 'acme');
  assert.equal(resolved.writes['github.repo'], 'app');
  // Setup's starting posture, not the fleet's default of three.
  assert.equal(resolved.writes.maxConcurrentAgents, 1);
  assert.equal(resolved.writes.agentMode, 'stream');
});

test('a login nothing could confirm is never written as one', async () => {
  // The sharp edge this exists for: with `userId` set, pickup reads *who added*
  // each label. A guessed login there is a fleet that picks nothing up and
  // reports nothing wrong, so a guess must not reach the file at all.
  const resolved = await resolveFromRepo(
    { email: 'adam@acme.com', repoRoot: mkdtempSync(join(tmpdir(), 'lubbdubb-setup-')) },
    { probes: probes({ env: () => undefined }), config: config() },
  );
  assert.equal(resolved.identity.confidence, 'unknown');
  assert.equal(resolved.identity.userId, null);
  assert.ok(!Object.hasOwn(resolved.writes, 'userId'));
  assert.equal(resolved.credential.present, false);
  assert.equal(resolved.credential.variable, 'GITHUB_TOKEN');
});

test('a key the team’s project file already sets is not copied into the operator’s own', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lubbdubb-setup-'));
  writeFileSync(
    join(repoRoot, 'lubbdubb.project.json'),
    JSON.stringify({ integrations: { sourceControl: 'github', issues: 'github' }, labelPrefix: 'acme-bot' }),
  );
  const resolved = await resolveFromRepo(
    { email: 'adam@acme.com', repoRoot },
    { probes: probes({ env: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_x' : undefined) }), config: config() },
  );
  // Copying it would freeze the team's value at today's, and the next commit
  // that changed it would never reach this operator. The absence is the feature.
  assert.ok(!Object.hasOwn(resolved.writes, 'integrations'));
  assert.deepEqual([...resolved.project.keys], ['integrations', 'labelPrefix']);
  assert.equal(resolved.watch.label, 'acme-bot-watch');
  assert.equal(resolved.watch.fromProject, true);
});

test('the reading says the harness is on the mock, and stops saying so once it is pointed', async () => {
  const onMock = await buildSetupReading({
    config: config(),
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: join(mkdtempSync(join(tmpdir(), 'lubbdubb-setup-')), 'lubbdubb.config.json'),
    pending: [],
  });
  assert.equal(onMock.checks.find((c) => c.id === 'pointed')?.verdict, 'bad');
  // The fake provider needs no credential, so that check must not go red for it.
  assert.equal(onMock.checks.find((c) => c.id === 'credential')?.verdict, 'ok');
});

test('a credential the environment does not hold is bad, and the fleet’s own key is bad for a different reason', async () => {
  const reading = await buildSetupReading({
    config: config({ integrations: { sourceControl: 'github', issues: 'github' }, github: { owner: 'a', repo: 'b' } }),
    store: buildSystem(config()).store,
    probes: probes({ env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-ant-x' : undefined) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
  });
  assert.equal(reading.checks.find((c) => c.id === 'credential')?.verdict, 'bad');
  // Agents inherit the harness's environment and the CLI prefers a key with no
  // prompt, so a stray export moves the whole fleet onto API billing silently.
  assert.equal(reading.checks.find((c) => c.id === 'billing')?.verdict, 'bad');
});

test('a world nothing has been read into yet is unknown, never “nothing is watched”', async () => {
  // Three-valued on purpose: a repository where nobody has tagged anything and a
  // harness that has not looked yet are different news, and only the first is
  // about the operator's configuration.
  const reading = await buildSetupReading({
    config: config(),
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
  });
  assert.equal(reading.checks.find((c) => c.id === 'watch')?.verdict, 'unknown');
});

test('the reading prefills both answers, so nothing the machine already knows is typed', async () => {
  const reading = await buildSetupReading({
    config: config({ repoRoot: '/srv/acme-app' }),
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
  });
  assert.equal(reading.prefill.email, 'adam@acme.com');
  assert.equal(reading.prefill.repoRoot, '/srv/acme-app');
});

/**
 * Pending as the harness itself computes it — what a candidate file says against
 * what the process is running, minus whatever an arm applied on the way.
 *
 * Built through `diffConfig` rather than hand-written `ConfigChange` literals, so
 * these tests exercise the real join: a path in `SETTLED_BY` that is not a
 * declared config field can never appear in `pending`, and a test that invented
 * one would assert a restatement the running harness could never produce.
 */
function pendingFor(running: Config, file: Partial<Config>) {
  return diffConfig(running, config(file)).filter((change) => !change.applied);
}

/**
 * The failure this whole argument exists to end.
 *
 * `integrations` and `userId` have no arm in `configApply.ts`, so an operator who
 * writes them watches the file say one thing while the process runs another — and
 * the reading, built from the running config, went on telling them to point the
 * harness at a project they had already pointed it at. Both surfaces were honest
 * and the operator had no way to see it: only the config page's pending card said
 * a restart was owed, and that is a page you have to already suspect something to
 * open.
 */
test('a fault the file already answers says restart, instead of asking for the work again', async () => {
  const running = config();
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github' },
      github: { owner: 'AdamAwan', repo: 'LubbDubb' },
      userId: 'AdamAwan',
    }),
  });

  const pointed = reading.checks.find((c) => c.id === 'pointed');
  const identity = reading.checks.find((c) => c.id === 'identity');
  // Still bad, and deliberately: the fleet is on the fake provider until the
  // process comes back, inventing a backlog that reads exactly like a real one.
  // Softening the verdict for a fix that has not taken effect would understate it.
  assert.equal(pointed?.verdict, 'bad');
  assert.equal(identity?.verdict, 'bad');
  assert.match(pointed?.detail ?? '', /integrations\.issues = "github"/);
  assert.match(identity?.detail ?? '', /userId = "AdamAwan"/);
  for (const check of [pointed, identity]) {
    assert.match(check?.remedy ?? '', /[Rr]estart/);
    // The offer moves to the page that holds the pending card and its restart
    // button. A `config` fix here would write a value the file is already holding,
    // and the sheet would re-ask the question the file has answered.
    assert.equal(check?.fix?.kind, 'goto');
  }
});

/**
 * The keys no check speaks for, which is most of them: a heartbeat, a cap, a
 * branch name. Nothing about them is a fault — the harness works — so this is the
 * one row here that names a discrepancy with no fault behind it.
 */
test('a pending change no check names gets a row of its own', async () => {
  const running = config({ integrations: { sourceControl: 'github', issues: 'github' }, userId: 'AdamAwan' });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes({ env: () => 'ghp_x' }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github' },
      userId: 'AdamAwan',
      heartbeatIntervalMs: 5000,
    }),
  });
  const restart = reading.checks.find((c) => c.id === 'restart');
  assert.equal(restart?.verdict, 'warn');
  assert.match(restart?.detail ?? '', /heartbeatIntervalMs = 5000/);
});

/**
 * The case that falls between the two if the remainder is computed from
 * `SETTLED_BY` rather than from what was actually restated: `userId` is pending,
 * so `identity` claims it — but `identity` is `ok`, so it says nothing, and the
 * change would reach no surface at all.
 */
test('a pending change to a key whose check is already ok is still named', async () => {
  const running = config({ integrations: { sourceControl: 'github', issues: 'github' }, userId: 'AdamAwan' });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes({ env: () => 'ghp_x' }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github' },
      userId: 'someone-else',
    }),
  });
  assert.equal(reading.checks.find((c) => c.id === 'identity')?.verdict, 'ok');
  assert.match(reading.checks.find((c) => c.id === 'restart')?.detail ?? '', /userId = "someone-else"/);
});

/**
 * A file and a process that agree draw nothing. The row cannot settle into a nag
 * for the same reason `eligibility` cannot: it names a discrepancy, and
 * `LiveConfig.pending()` is recomputed against the running config on every apply,
 * so putting a key back to what the harness is running takes the row away by
 * itself.
 */
test('a harness running what its file says has no restart row', async () => {
  const reading = await buildSetupReading({
    config: config(),
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
  });
  assert.equal(
    reading.checks.find((c) => c.id === 'restart'),
    undefined,
  );
});

/**
 * The one thing a restatement must never do. `credential` and `billing` read the
 * environment, and no edit to the config file puts a variable into a process that
 * is already running — so a pending change must leave both saying exactly what
 * they said. Telling an operator that a restart will fix an expired token sends
 * them to bounce the fleet for nothing, and leaves the fault in place afterwards.
 */
test('a pending change never restates a check the environment owns', async () => {
  const running = config({
    integrations: { sourceControl: 'github', issues: 'github' },
    github: { owner: 'a', repo: 'b' },
  });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes({ env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-ant-x' : undefined) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github' },
      github: { owner: 'a', repo: 'b' },
      heartbeatIntervalMs: 5000,
    }),
  });
  for (const id of ['credential', 'billing']) {
    const check = reading.checks.find((c) => c.id === id);
    assert.equal(check?.verdict, 'bad');
    assert.doesNotMatch(check?.remedy ?? '', /[Rr]estart to take it up/);
  }
});
