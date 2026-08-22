import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { configField, envOverride } from '../src/configFields.js';
import type { SetupProbes } from '../src/setup/probes.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { buildSetupReading, type SetupCheck } from '../src/setup/reading.js';
import { resolveFromRepo } from '../src/setup/resolve.js';
import { buildSystem } from '../src/system.js';

/**
 * The contract between what Setup offers to write and what the config route will
 * accept — and the one nothing stated, which is how it came to be broken.
 *
 * `resolveFromRepo` used to emit nested objects (`integrations`, `github`) while
 * `POST /api/config` validates every key against `CONFIG_FIELDS`, a registry of
 * **leaf** paths. So the first key refused the whole save, at the *preview*, with
 * the operator's entire answer one field name away from working — and it refused
 * for every real repository, which is to say Setup had never once completed
 * against one. Both sides typecheck: the writes are a `Record<string, unknown>`
 * and the validator takes strings.
 *
 * So this asserts the join rather than a literal. A key here that is not a
 * configurable leaf, is `fileOnly`, or is beaten by an environment variable is a
 * key the route will refuse, and the failure is silent at every layer above it.
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

function config(over: Parameters<typeof loadConfig>[0] = {}) {
  return loadConfig({ dbPath: ':memory:', ...over });
}

/** What `prepare()` in `src/server/routes/state.ts` walks, for one key. */
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

/**
 * The same join, for the fixes a check offers. These are written by one click from
 * the rail rather than after a preview, so a refusal here is one an operator meets
 * with no file in front of them to read it against.
 */
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

/**
 * A check that is not `ok` must give the operator something to do about it.
 *
 * The failure this catches is the one the whole redesign started from: a reading
 * that counted two outstanding things and offered no way to correct either. A
 * remedy is the floor; a `fix` is the offer.
 */
test('every outstanding check says what to do about it', async () => {
  const reading = await buildSetupReading({
    config: config({ integrations: { sourceControl: 'github', issues: 'github' }, github: { owner: 'a', repo: 'b' } }),
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

/**
 * A value the harness could not corroborate never reaches a one-click button.
 *
 * `userId` is the sharp one: with it set, pickup reads *who added* each watch tag,
 * so a wrong login is a fleet that picks nothing up and reports nothing wrong. The
 * local part of an email is a plausible GitHub login and is right often enough to
 * be dangerous — so a GitHub deployment with no credential to ask proposes nothing
 * at all, and an Azure one, where the address genuinely *is* the identity, proposes
 * it as `assumed` so the cockpit puts it in a field before it puts it in the file.
 */
test('an identity nothing could confirm is never offered as a one-click fix', async () => {
  const github = await buildSetupReading({
    config: config({ integrations: { sourceControl: 'github', issues: 'github' }, github: { owner: 'a', repo: 'b' } }),
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
    config: config({ integrations: { sourceControl: 'github', issues: 'github' }, github: { owner: 'a', repo: 'b' } }),
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

/**
 * Which repository a reading is talking about.
 *
 * `repoRoot` is the project the fleet works on; LubbDubb's own checkout is resolved
 * from the running module and is not configurable. They coincide only when the
 * harness is dogfooding — and since `repoRoot` defaults to `process.cwd()`, that is
 * exactly what a default start proposes. Stated rather than refused, because
 * dogfooding is how this repo is developed; what it costs is the confidence to put
 * that directory on a button.
 */
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
