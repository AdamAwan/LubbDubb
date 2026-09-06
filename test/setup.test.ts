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
    azSignedIn: () => Promise.resolve(false),
    env: () => undefined,
    ...over,
  };
}

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
  assert.equal(resolved.writes['integrations.sourceControl'], 'github');
  assert.equal(resolved.writes['integrations.issues'], 'github');
  assert.equal(resolved.writes['github.owner'], 'acme');
  assert.equal(resolved.writes['github.repo'], 'app');
  assert.equal(resolved.writes.maxConcurrentAgents, 1);
  assert.equal(resolved.writes.agentMode, 'stream');
});

test('a login nothing could confirm is never written as one', async () => {
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
  assert.equal(reading.checks.find((c) => c.id === 'billing')?.verdict, 'bad');
});

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

test('a pool selected with no fleetId is a row, and it offers the address rather than deriving one', async () => {
  const selected = {
    integrations: { sourceControl: 'fake' as const, issues: 'fake' as const, pool: 'git' as const },
    pool: { project: 'acme-api', remote: 'https://git.example/eng/wiki.git', branch: 'main' },
  };
  const reading = async (over: Parameters<typeof loadConfig>[0]) =>
    buildSetupReading({
      config: config({ ...selected, ...over }),
      store: buildSystem(config()).store,
      probes: probes(),
      configFile: '/nowhere/lubbdubb.config.json',
      pending: [],
      prompts: defaultPromptTemplates(),
    });

  const unknown = (await reading({})).checks.find((c) => c.id === 'fleet');
  assert.equal(unknown?.verdict, 'bad');
  assert.equal(unknown?.fix?.kind, 'goto');

  const offered = (await reading({ userId: 'alice' })).checks.find((c) => c.id === 'fleet');
  assert.equal(offered?.fix?.kind, 'config');
  assert.deepEqual(offered?.fix?.kind === 'config' && offered.fix.set, { fleetId: 'alice@acme-api' });
  assert.equal(offered?.fix?.kind === 'config' && offered.fix.confidence, 'assumed');

  const named = (await reading({ userId: 'alice', fleetId: 'alice@acme-api' })).checks.find((c) => c.id === 'fleet');
  assert.equal(named?.verdict, 'ok');

  const off = (await reading({ integrations: { sourceControl: 'fake', issues: 'fake', pool: 'fake' }, pool: {} }))
    .checks;
  assert.equal(
    off.find((c) => c.id === 'fleet'),
    undefined,
  );
});

test('a fleetId the file already holds says restart, not ask again', async () => {
  const running = config({
    integrations: { sourceControl: 'fake', issues: 'fake', pool: 'git' },
    pool: { project: 'acme-api', remote: 'https://git.example/eng/wiki.git', branch: 'main' },
  });
  const reading = await buildSetupReading({
    config: running,
    store: buildSystem(config()).store,
    probes: probes(),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: pendingFor(running, {
      integrations: { sourceControl: 'fake', issues: 'fake', pool: 'git' },
      pool: { project: 'acme-api', remote: 'https://git.example/eng/wiki.git', branch: 'main' },
      fleetId: 'alice@acme-api',
    }),
    prompts: defaultPromptTemplates(),
  });
  const fleet = reading.checks.find((c) => c.id === 'fleet');
  assert.equal(fleet?.verdict, 'bad');
  assert.match(fleet?.detail ?? '', /fleetId = "alice@acme-api"/);
  assert.equal(fleet?.fix?.kind, 'goto');
});

function pendingFor(running: Config, file: Partial<Config>) {
  return diffConfig(running, config(file)).filter((change) => !change.applied);
}

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
  assert.equal(pointed?.verdict, 'bad');
  assert.equal(identity?.verdict, 'bad');
  assert.match(pointed?.detail ?? '', /integrations\.issues = "github"/);
  assert.match(identity?.detail ?? '', /userId = "AdamAwan"/);
  for (const check of [pointed, identity]) {
    assert.match(check?.remedy ?? '', /[Rr]estart/);
    assert.equal(check?.fix?.kind, 'goto');
  }
});

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
  assert.equal(check?.verdict, 'bad');
  assert.match(check?.detail ?? '', /pr-ci-fix\.md names report_finding/);
  assert.match(check?.remedy ?? '', /raise/);
  assert.deepEqual(check?.fix, { kind: 'goto', label: 'Open Prompts', to: 'prompts' });
});

test('a deployment with no overrides draws no such check at all', async () => {
  const none = await reading(defaultPromptTemplates());
  assert.equal(
    none.checks.find((c) => c.id === 'prompt-tools'),
    undefined,
  );

  const clean = await reading(withOverride('pr-ci-fix', 'Fix the failing check. Raise anything you learn.\n'));
  assert.equal(clean.checks.find((c) => c.id === 'prompt-tools')?.verdict, 'ok');
});

test('every retired name is scanned for, not just the one that is remembered', async () => {
  for (const tool of RETIRED_TOOL_NAMES) {
    const found = await reading(withOverride('pr-ci-fix', `Fix the check, then call ${tool}.\n`));
    assert.match(found.checks.find((c) => c.id === 'prompt-tools')?.detail ?? '', new RegExp(tool));
  }
});
