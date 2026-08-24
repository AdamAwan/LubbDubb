import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { diffConfig } from '../src/configApply.js';
import type { SetupProbes } from '../src/setup/probes.js';
import {
  defaultPromptTemplates,
  loadPromptTemplates,
  type PromptTemplates,
} from '../src/dispatcher/promptTemplates.js';
import { RETIRED_TOOL_NAMES } from '../src/mcp/names.js';
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
    // Signed out by default: the fake must never assert a route the test did not
    // ask for, or an azure test would pass on a credential nobody set.
    azSignedIn: () => Promise.resolve(false),
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
  assert.equal(resolved.credential.source, null);
  assert.equal(resolved.credential.variable, 'GITHUB_TOKEN');
});

test('the setup sheet reports which route authenticates, not that a variable is present', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lubbdubb-setup-'));
  const resolved = await resolveFromRepo(
    { email: 'adam@contoso.com', repoRoot },
    {
      probes: probes({
        originUrl: () => Promise.resolve('https://dev.azure.com/contoso/Platform/_git/api'),
        env: () => undefined,
        azSignedIn: () => Promise.resolve(true),
      }),
      config: config(),
    },
  );
  assert.equal(resolved.credential.variable, 'AZURE_DEVOPS_PAT');
  assert.equal(resolved.credential.present, true, 'the harness can authenticate, which is what the row is about');
  assert.equal(resolved.credential.source, 'az-cli');
});

test('a key the team’s project file already sets is not copied into the operator’s own', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lubbdubb-setup-'));
  writeFileSync(
    join(repoRoot, 'lubbdubb.project.json'),
    JSON.stringify({
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      labelPrefix: 'acme-bot',
    }),
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
    prompts: defaultPromptTemplates(),
  });
  assert.equal(onMock.checks.find((c) => c.id === 'pointed')?.verdict, 'bad');
  // The fake provider needs no credential, so that check must not go red for it.
  assert.equal(onMock.checks.find((c) => c.id === 'credential')?.verdict, 'ok');
});

test('a credential the environment does not hold is bad, and the fleet’s own key is bad for a different reason', async () => {
  const reading = await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'a', repo: 'b' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-ant-x' : undefined) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  assert.equal(reading.checks.find((c) => c.id === 'credential')?.verdict, 'bad');
  // Agents inherit the harness's environment and the CLI prefers a key with no
  // prompt, so a stray export moves the whole fleet onto API billing silently.
  assert.equal(reading.checks.find((c) => c.id === 'billing')?.verdict, 'bad');
});

/**
 * The bug the second route exists for: `resolveAzureAuth` prefers a PAT and falls
 * back to the logged-in `az` CLI, so an operator who has run `az login` and set no
 * variable reads the whole world — and was told, in a `bad` row, that the provider
 * could not be read at all. A check that asks one of a provider's two routes states
 * something the operator can check and find false.
 */
test('a signed-in az CLI is a credential, and the row says so without naming a variable nobody set', async () => {
  const azure = {
    integrations: { sourceControl: 'azure' as const, issues: 'azure' as const, pool: 'fake' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
  };
  const reading = await buildSetupReading({
    config: config(azure),
    store: buildSystem(config()).store,
    probes: probes({ env: () => undefined, azSignedIn: () => Promise.resolve(true) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  const check = reading.checks.find((c) => c.id === 'credential');
  assert.equal(check?.verdict, 'ok');
  assert.match(check?.detail ?? '', /az CLI is signed in/);
  assert.doesNotMatch(check?.detail ?? '', /present/, 'a variable nobody set is never reported as present');
});

test('azure with neither route names both, and offers the one that needs no restart', async () => {
  const reading = await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'azure', issues: 'azure', pool: 'fake' },
      azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ env: () => undefined, azSignedIn: () => Promise.resolve(false) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  const check = reading.checks.find((c) => c.id === 'credential');
  assert.equal(check?.verdict, 'bad');
  assert.match(check?.detail ?? '', /AZURE_DEVOPS_PAT is not set and the az CLI is not signed in/);
  assert.match(check?.remedy ?? '', /az login/);
  assert.match(check?.remedy ?? '', /AZURE_DEVOPS_PAT/);
  assert.equal(check?.fix?.kind, 'shell');
  assert.equal(check?.fix?.kind === 'shell' ? check.fix.command : null, 'az login');
});

/**
 * The `az` probe costs a subprocess, and `GET /api/setup` runs on every cockpit
 * mount. A PAT wins in `resolveAzureAuth` anyway, so asking the CLI first would
 * spend that spawn on every deployment that never uses it.
 */
test('the az CLI is not asked when the PAT is set, and never asked for github at all', async () => {
  let asked = 0;
  const counting = () => {
    asked += 1;
    return Promise.resolve(true);
  };
  const withPat = await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'azure', issues: 'azure', pool: 'fake' },
      azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ env: (name) => (name === 'AZURE_DEVOPS_PAT' ? 'pat_x' : undefined), azSignedIn: counting }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  assert.equal(withPat.checks.find((c) => c.id === 'credential')?.verdict, 'ok');
  assert.equal(asked, 0);

  await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'a', repo: 'b' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ env: () => undefined, azSignedIn: counting }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  assert.equal(asked, 0, 'github has one route in, and it is not the az CLI');
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
    prompts: defaultPromptTemplates(),
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
    prompts: defaultPromptTemplates(),
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
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'AdamAwan', repo: 'LubbDubb' },
      userId: 'AdamAwan',
    }),
    prompts: defaultPromptTemplates(),
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
  const running = config({
    integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
    userId: 'AdamAwan',
  });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes({ env: () => 'ghp_x' }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      userId: 'AdamAwan',
      heartbeatIntervalMs: 5000,
    }),
    prompts: defaultPromptTemplates(),
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
  const running = config({
    integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
    userId: 'AdamAwan',
  });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes({ env: () => 'ghp_x' }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      userId: 'someone-else',
    }),
    prompts: defaultPromptTemplates(),
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
    prompts: defaultPromptTemplates(),
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
    integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
    github: { owner: 'a', repo: 'b' },
  });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes({ env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-ant-x' : undefined) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'a', repo: 'b' },
      heartbeatIntervalMs: 5000,
    }),
    prompts: defaultPromptTemplates(),
  });
  for (const id of ['credential', 'billing']) {
    const check = reading.checks.find((c) => c.id === id);
    assert.equal(check?.verdict, 'bad');
    assert.doesNotMatch(check?.remedy ?? '', /[Rr]estart to take it up/);
  }
});

/**
 * The shim `raise` left behind is doing nothing until somebody can see whether it
 * is still needed. `report_finding` and the three `knowledge_*` tools are
 * registered, granted and named nowhere, kept only because an operator's override
 * written before the intake may still name one — and a withdrawn tool name fails
 * silently, the call coming back refused with nothing in the logs. This is the
 * reading that makes the later withdrawal safe.
 */
function withOverride(id: string, body: string): PromptTemplates {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-prompts-'));
  writeFileSync(join(dir, `${id}.md`), body);
  return loadPromptTemplates(dir);
}

async function reading(prompts: PromptTemplates) {
  return buildSetupReading({
    config: config(),
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts,
  });
}

test('an override that still names a retired tool says which, and what to say instead', async () => {
  const found = await reading(
    withOverride('pr-ci-fix', 'Fix the failing check. If you notice anything else, call report_finding.\n'),
  );
  const check = found.checks.find((c) => c.id === 'prompt-tools');
  // `bad` since the withdrawal. While the four were still registered this was a
  // `warn` — nothing was broken and the deployment was one withdrawal away from
  // breaking. The withdrawal has happened, so this prompt now sends every agent it
  // dispatches at a name that answers only with a refusal.
  assert.equal(check?.verdict, 'bad');
  // Named rather than counted: the whole remedy is which file to open and which
  // word to change in it, so a count would be a row nobody can act on.
  assert.match(check?.detail ?? '', /pr-ci-fix\.md names report_finding/);
  assert.match(check?.remedy ?? '', /raise/);
  // The Prompts tab, not the values page — a fix that opens the wrong screen is
  // worse than no fix.
  assert.deepEqual(check?.fix, { kind: 'goto', label: 'Open Prompts', to: 'prompts' });
});

test('a deployment with no overrides draws no such check at all', async () => {
  // Not an `ok` row about a thing it does not do. The built-ins name none of these
  // by construction, so scanning them would be scanning the harness's own text for
  // the harness's own mistake.
  const none = await reading(defaultPromptTemplates());
  assert.equal(
    none.checks.find((c) => c.id === 'prompt-tools'),
    undefined,
  );

  // An override that names none of them is the reading having been taken, which is
  // the shape `credential` has when the variable is present — and it draws no row.
  const clean = await reading(withOverride('pr-ci-fix', 'Fix the failing check. Raise anything you learn.\n'));
  assert.equal(clean.checks.find((c) => c.id === 'prompt-tools')?.verdict, 'ok');
});

test('every retired name is scanned for, not just the one that is remembered', async () => {
  // The list is `src/mcp/names.ts`', which is also where the grants come from: two
  // lists that merely agreed today would let a withdrawal reach the grants without
  // reaching this row.
  for (const tool of RETIRED_TOOL_NAMES) {
    const found = await reading(withOverride('pr-ci-fix', `Fix the check, then call ${tool}.\n`));
    assert.match(found.checks.find((c) => c.id === 'prompt-tools')?.detail ?? '', new RegExp(tool));
  }
});
