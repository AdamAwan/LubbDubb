import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { configField, envOverride } from '../src/config/configFields.js';
import type { SetupProbes } from '../src/setup/probes.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { buildSetupReading, type SetupCheck } from '../src/setup/reading.js';
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

function refuseReason(path: string): string | null {
  const field = configField(path);
  if (!field) return `${path} is not a configurable field`;
  if (field.access === 'fileOnly') return `${path} is edited in the file, not here`;
  const env = envOverride(field);
  return env ? `${path} is set by ${env}, which beats the file` : null;
}

test('every key Setup would write is a key the config route accepts', async (t) => {
  for (const remote of ['git@github.com:acme/app.git', 'https://dev.azure.com/acme/platform/_git/app']) {
    const resolved = await resolveFromRepo(
      { email: 'adam@acme.com', repoRoot: mkdtempSync(join(tmpdir(), 'lubbdubb-writes-')) },
      { probes: probes({ originUrl: () => Promise.resolve(remote), env: () => 'token' }), config: config() },
    );
    assert.ok(Object.keys(resolved.writes).length > 0, `${remote} derived nothing to write`);
    for (const path of Object.keys(resolved.writes)) {
      assert.equal(refuseReason(path), null, `${remote} would write ${path}`);
    }
    t.diagnostic(`${remote} → ${Object.keys(resolved.writes).join(', ')}`);
  }
});

test('every config fix a check offers is a key the config route accepts', async () => {
  const readings = await Promise.all([
    buildSetupReading({
      config: config(),
      store: buildSystem(config()).store,
      probes: probes(),
      configFile: '/nowhere/lubbdubb.config.json',
      pending: [],
      prompts: defaultPromptTemplates(),
    }),
    buildSetupReading({
      config: config({ agentMode: 'raw', labelPrefix: '' }),
      store: buildSystem(config()).store,
      probes: probes({ env: (name) => (name === 'ANTHROPIC_API_KEY' ? 'sk-ant-x' : undefined) }),
      configFile: '/nowhere/lubbdubb.config.json',
      pending: [],
      prompts: defaultPromptTemplates(),
    }),
  ]);
  const fixes = readings.flatMap((reading) => reading.checks.map((check: SetupCheck) => check.fix));
  const configFixes = fixes.filter((fix) => fix?.kind === 'config');
  assert.ok(configFixes.length > 0, 'no config fix was offered at all, so this asserts nothing');
  for (const fix of configFixes) {
    for (const path of Object.keys(fix.set)) {
      assert.equal(refuseReason(path), null, `a fix would write ${path}`);
    }
  }
});

test('every outstanding check says what to do about it', async () => {
  const reading = await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'a', repo: 'b' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ agentVersion: () => Promise.resolve(null), env: () => undefined }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  const outstanding = reading.checks.filter((check) => check.verdict === 'bad' || check.verdict === 'warn');
  assert.ok(outstanding.length > 0);
  for (const check of outstanding) {
    assert.ok(check.remedy !== undefined || check.fix !== undefined, `${check.id} is a dead end`);
  }
});

test('an identity nothing could confirm is never offered as a one-click fix', async () => {
  const github = await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'a', repo: 'b' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ env: () => undefined }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  const identity = github.checks.find((check) => check.id === 'identity');
  assert.equal(identity?.verdict, 'bad');
  assert.notEqual(identity?.fix?.kind, 'config', 'a guessed login must not reach a button');

  const confirmed = await buildSetupReading({
    config: config({
      integrations: { sourceControl: 'github', issues: 'github', pool: 'fake' },
      github: { owner: 'a', repo: 'b' },
    }),
    store: buildSystem(config()).store,
    probes: probes({ env: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_x' : undefined) }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  const asked = confirmed.checks.find((check) => check.id === 'identity');
  assert.equal(asked?.fix?.kind, 'config');
  assert.equal(asked?.fix?.kind === 'config' ? asked.fix.confidence : null, 'confirmed');
  assert.equal(asked?.fix?.kind === 'config' ? asked.fix.set.userId : null, 'adamawan');
});

test('a repoRoot that is the harness’s own checkout is reported as such', async () => {
  const own = mkdtempSync(join(tmpdir(), 'lubbdubb-self-'));
  const reading = await buildSetupReading({
    config: config({ repoRoot: own }),
    store: buildSystem(config()).store,
    probes: probes({ installRoot: () => own }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  assert.equal(reading.prefill.repoRootIsSelf, true);

  const elsewhere = await buildSetupReading({
    config: config({ repoRoot: own }),
    store: buildSystem(config()).store,
    probes: probes({ installRoot: () => '/srv/lubbdubb' }),
    configFile: '/nowhere/lubbdubb.config.json',
    pending: [],
    prompts: defaultPromptTemplates(),
  });
  assert.equal(elsewhere.prefill.repoRootIsSelf, false);
});
