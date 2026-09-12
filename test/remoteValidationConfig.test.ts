import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { CONFIG_FIELDS } from '../src/config/configFields.js';
import { groupedTopLevelKeys } from '../src/server/runningConfig.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { stateExecutor, stateExecutors } from '../src/remoteValidation/enabled.js';

// → docs/spec/36-remote-validation.md

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'lubbdubb-rv-config-'));
}

function acceptance(validate: Record<string, unknown>): EnvironmentConfig {
  return { name: 'acceptance', at: './scripts/deployed-sha.sh acceptance', validate } as unknown as EnvironmentConfig;
}

function refusal(validate: Record<string, unknown>): string {
  try {
    validateEnvironments([acceptance(validate)]);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

test('the whole validate block parses, and environments stays fileOnly', () => {
  const dir = temp();
  const config = loadConfig({
    dbPath: ':memory:',
    repoRoot: dir,
    environments: [
      acceptance({
        permits: ['check', 'state', 'signal', 'measure'],
        tenant: 'validation-customer-1',
        reseed: './scripts/reseed.sh',
        tenantFreshnessMs: 604_800_000,
        browser: {
          runner: 'npm run e2e -- --project=validation',
          listSelectors: 'npm run e2e -- --project=validation --list',
          profile: 'acc-uk',
          publishArtefacts: './scripts/publish-report.sh',
        },
        state: { run: './scripts/validation-query.sh' },
      }),
    ],
  } as never);

  const validate = config.environments[0]!.validate!;
  assert.deepEqual(validate.permits, ['check', 'state', 'signal', 'measure']);
  assert.equal(validate.tenant, 'validation-customer-1');
  assert.equal(validate.tenantFreshnessMs, 604_800_000);
  assert.equal(validate.browser!.profile, 'acc-uk');
  assert.equal(validate.state!.run, './scripts/validation-query.sh');

  const field = CONFIG_FIELDS.find((f) => f.path === 'environments');
  assert.equal(field?.access, 'fileOnly', 'every field in the block is a shell command the harness runs');
});

test('remoteValidation.runTimeoutMs defaults to thirty minutes and the Features group claims it', () => {
  const dir = temp();
  const config = loadConfig({
    dbPath: ':memory:',
    repoRoot: dir,
    projectConfigFile: join(dir, 'absent.json'),
  } as never);
  assert.equal(config.remoteValidation.runTimeoutMs, 30 * 60 * 1000);
  assert.ok(groupedTopLevelKeys().has('remoteValidation'), 'an unclaimed key validates, applies, and is drawn nowhere');
  assert.ok(CONFIG_FIELDS.some((f) => f.path === 'remoteValidation.runTimeoutMs'));

  // The tenant commands are not the runner, and neither of them is a thirty-second job: this
  // document's own account of ensureTenant is "possibly very slow", so the ordinary kill would end
  // both on every invocation.
  assert.equal(config.remoteValidation.tenantTimeoutMs, 60 * 60 * 1000);
  assert.ok(CONFIG_FIELDS.some((f) => f.path === 'remoteValidation.tenantTimeoutMs'));
});

test('an empty permits list is refused — it reads as a configuration and permits nothing', () => {
  assert.match(refusal({ permits: [] }), /permits" is empty/);
});

test('check permitted with no browser block is refused', () => {
  assert.match(refusal({ permits: ['check'] }), /names "check" and there is no "validate\.browser"/);
});

test('state permitted with no state.run is refused', () => {
  assert.match(refusal({ permits: ['state'] }), /names "state" and there is no "validate\.state\.run"/);
});

test('a browser with a runner and no listSelectors is refused', () => {
  assert.match(
    refusal({ permits: ['check'], browser: { runner: 'npm run e2e' } }),
    /declares a runner and no "listSelectors"/,
  );
});

test('two tenant shapes are two answers to one question, and are refused', () => {
  assert.match(
    refusal({ permits: ['state'], state: { run: './q.sh' }, tenant: 'one', tenantEnv: 'VALIDATION_TENANT' }),
    /two answers to one question/,
  );
});

test('a reseed or a freshness window with no tenant of any shape is refused', () => {
  assert.match(refusal({ permits: ['state'], state: { run: './q.sh' }, reseed: './r.sh' }), /reseeds a tenant/);
  assert.match(
    refusal({ permits: ['state'], state: { run: './q.sh' }, tenantFreshnessMs: 1000 }),
    /freshness about nothing/,
  );
});

test('an empty command anywhere in the block is refused', () => {
  assert.match(refusal({ permits: ['state'], state: { run: '  ' } }), /"validate\.state\.run" must be a non-empty/);
  assert.match(
    refusal({ permits: ['state'], state: { run: './q.sh' }, ensureTenant: '' }),
    /"validate\.ensureTenant" must be a non-empty/,
  );
});

test('no secret is a config key — tenantEnv names a variable and never carries its value', () => {
  const dir = temp();
  process.env['VALIDATION_TENANT'] = 'tenant-42-the-actual-value';
  try {
    const config = loadConfig({
      dbPath: ':memory:',
      repoRoot: dir,
      environments: [acceptance({ permits: ['state'], state: { run: './q.sh' }, tenantEnv: 'VALIDATION_TENANT' })],
    } as never);
    const serialised = JSON.stringify(config.environments);
    assert.match(serialised, /VALIDATION_TENANT/, 'config names the variable');
    assert.ok(
      !serialised.includes('tenant-42-the-actual-value'),
      'and never its value — a config key resolved from the environment is a secret in a file that gets read',
    );
  } finally {
    delete process.env['VALIDATION_TENANT'];
  }
  assert.ok(
    !CONFIG_FIELDS.some((f) => f.path.startsWith('environments.')),
    'the whole block is one fileOnly key: nothing inside it is separately settable from the cockpit',
  );
});

test('a block with no state.run is not an executor, and a named one resolves by name', () => {
  const withState = acceptance({ permits: ['state'], state: { run: './q.sh' } });
  const production = { name: 'production', at: 'echo x', validate: { permits: ['state'], state: { run: './p.sh' } } };
  const bare = { name: 'bare', at: 'echo x' };
  assert.deepEqual(stateExecutors([bare] as EnvironmentConfig[]), []);
  assert.equal(stateExecutor([bare] as EnvironmentConfig[]), null);
  assert.equal(stateExecutor([bare, withState, production] as EnvironmentConfig[])!.name, 'acceptance');
  assert.equal(stateExecutor([bare, withState, production] as EnvironmentConfig[], 'production')!.name, 'production');
  assert.equal(stateExecutor([bare, withState] as EnvironmentConfig[], 'production'), null);
});
