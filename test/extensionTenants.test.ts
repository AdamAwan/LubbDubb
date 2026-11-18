import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { loadExtensions } from '../src/extensions/load.js';
import { EXTENSION_SLOTS } from '../src/extensions/slots.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { gitRepo } from './support/gitRepo.js';
import { desktopDeps } from './support/desktop.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';

// → docs/spec/36-remote-validation.md#a-tenant-from-the-projects-extension

const FROM_EXTENSION: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh',
  validate: { permits: ['state'], tenantExtension: true, state: { run: './scripts/query.sh' } },
};

const BY_COMMAND: EnvironmentConfig = {
  name: 'staging',
  at: './scripts/deployed-sha.sh',
  validate: { permits: ['state'], ensureTenant: './scripts/ensure.sh', state: { run: './scripts/query.sh' } },
};

const RECORDING = `
const asked = (globalThis.__tenantAsked ??= []);
export default { apiVersion: 1, name: 'acme', slots: {
  ensureTenant: async (input) => { asked.push(['ensure', input]); return { tenant: 'acme-validation-7' }; },
  reseedTenant: async (input) => { asked.push(['reseed', input]); },
} };`;

interface Bench {
  system: System;
  commands: FakeTenantKeeper;
  logged: string[];
}

async function bench(source: string | null, environments: EnvironmentConfig[] = [FROM_EXTENSION]): Promise<Bench> {
  const repoRoot = gitRepo();
  if (source !== null) writeFileSync(join(repoRoot, 'ext.mjs'), source);
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    agentMode: 'raw',
    repoRoot,
    deskRoot: join(repoRoot, 'desk'),
    worktreeRoot: join(repoRoot, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
    extensions: source === null ? [] : ['ext.mjs'],
  });
  const commands = new FakeTenantKeeper({ 'ensure:staging': { tenant: 'staging-tenant', detail: null } });
  const logged: string[] = [];
  const system = buildSystem(config, {
    extensions: await loadExtensions({ paths: config.extensions, book: EXTENSION_SLOTS }),
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    stateReader: new FakeStateReader(),
    tenants: commands,
    environmentProber: new FakeEnvironmentProber({ acceptance: ['b'.repeat(40)], staging: ['b'.repeat(40)] }),
    environmentObserver: new FakeEnvironmentObserver(),
    projectConfigFile: join(repoRoot, 'absent.json'),
    errorMirror: (entry) => logged.push(entry.message),
  });
  return { system, commands, logged };
}

function asked(): [string, unknown][] {
  const g = globalThis as { __tenantAsked?: [string, unknown][] };
  const all = g.__tenantAsked ?? [];
  g.__tenantAsked = [];
  return all;
}

test('the extension provisions and reseeds the tenant, and the name it gave is what is stamped', async () => {
  asked();
  const { system, commands } = await bench(RECORDING);
  const prepared = await system.remoteRuns.prepareTenant('acceptance');

  assert.equal(prepared.ok, true, prepared.detail);
  assert.equal(prepared.standing.tenant, 'acme-validation-7');
  assert.deepEqual(asked(), [
    ['ensure', { environment: 'acceptance', tenant: null }],
    ['reseed', { environment: 'acceptance', tenant: 'acme-validation-7' }],
  ]);
  assert.deepEqual(commands.asked, [], 'no command runs for an environment the extension answers');
  const stamped = system.store.remoteValidation.listRemoteTenants()[0];
  assert.equal(stamped?.tenant, 'acme-validation-7');
  assert.notEqual(stamped?.reseededAt, null);
});

test('an environment that declares commands keeps them while an extension answers another', async () => {
  asked();
  const { system, commands } = await bench(RECORDING, [FROM_EXTENSION, BY_COMMAND]);
  const prepared = await system.remoteRuns.prepareTenant('staging');

  assert.equal(prepared.ok, true, prepared.detail);
  assert.equal(prepared.standing.tenant, 'staging-tenant');
  assert.deepEqual(
    commands.asked.map((a) => `${a.call}:${a.command}`),
    ['ensure:./scripts/ensure.sh'],
  );
  assert.deepEqual(asked(), [], 'and the extension is not asked about it');
});

test('before anything is provisioned the gate is blocked, naming the extension', async () => {
  const { system } = await bench(RECORDING);
  assert.match(system.remoteRuns.waitReason('acceptance') ?? '', /extension, through its "ensureTenant" slot/);
});

test('an extension that fails is the preparation failing, recorded, with nothing stamped', async () => {
  const { system, logged } = await bench(`export default { apiVersion: 1, name: 'acme', slots: {
    ensureTenant: () => { throw new Error('the tenant API said 503'); },
  } };`);
  const prepared = await system.remoteRuns.prepareTenant('acceptance');

  assert.equal(prepared.ok, false);
  assert.match(prepared.detail, /extension "acme" failed the "ensureTenant" slot: the tenant API said 503/);
  assert.deepEqual(system.store.remoteValidation.listRemoteTenants(), []);
  assert.ok(logged.some((m) => /the tenant API said 503/.test(m)));
});

test('an answer that names no tenant is refused — the harness never invents one', async () => {
  const { system } = await bench(`export default { apiVersion: 1, name: 'acme', slots: {
    ensureTenant: () => ({ tenant: '  ' }),
  } };`);
  const prepared = await system.remoteRuns.prepareTenant('acceptance');
  assert.equal(prepared.ok, false);
  assert.match(prepared.detail, /wrong shape/);
});

test('without a reseedTenant slot the extension only provisions, and the cockpit shows what answers', async () => {
  asked();
  const { system } = await bench(`
const asked = (globalThis.__tenantAsked ??= []);
export default { apiVersion: 1, name: 'acme', slots: {
  ensureTenant: (input) => { asked.push(['ensure', input]); return { tenant: 'acme-validation-7' }; },
} };`);
  const prepared = await system.remoteRuns.prepareTenant('acceptance');
  assert.equal(prepared.ok, true, prepared.detail);
  assert.deepEqual(
    asked().map(([call]) => call),
    ['ensure'],
  );
  assert.deepEqual(
    buildStateSnapshot(system).tenantCommands.map(({ environment, ensureTenant, reseed }) => ({
      environment,
      ensureTenant,
      reseed,
    })),
    [{ environment: 'acceptance', ensureTenant: 'the "ensureTenant" slot of extension "acme"', reseed: null }],
  );
});

test('the output of the latest preparation reads back from the extension keeper', async () => {
  const { system } = await bench(RECORDING);
  let settled = false;
  system.remoteRuns.beginPrepareTenant('acceptance', () => {
    settled = true;
  });
  while (!settled) await new Promise((r) => setImmediate(r));
  const lines = system.remoteRuns.tenantOutput('acceptance').lines;
  assert.match(lines.join('\n'), /reseedTenant/);
});

test('after a restart, a preparation the extension was answering is closed as not knowable', async () => {
  const { system } = await bench(RECORDING);
  system.store.remoteValidation.beginTenantPrepare('acceptance');
  system.store.remoteValidation.recordTenantLaunch('acceptance', 'ensure', {
    id: 'extension-old',
    pid: null,
    startedAt: new Date(0).toISOString(),
  });
  let settled = false;
  system.remoteRuns.resumeTenantPrepares(() => {
    settled = true;
  });
  while (!settled) await new Promise((r) => setImmediate(r));

  const closed = system.store.remoteValidation.listTenantPrepares()[0]!;
  assert.equal(closed.ok, null, 'an in-process call does not survive a restart');
  assert.match(closed.detail ?? '', /not known from here/);
});

test('an environment that takes its tenant from an extension refuses to build without one', async () => {
  await assert.rejects(bench(null), /set "validate.tenantExtension" and no extension fills the "ensureTenant" slot/);
});

test('an extension environment may not also declare a reseed command or another tenant shape', () => {
  const load = (validate: object) => () =>
    loadConfig({
      dbPath: ':memory:',
      repoRoot: gitRepo(),
      environments: [
        {
          name: 'acceptance',
          at: 'x',
          validate: { permits: ['state'], tenantExtension: true, state: { run: './q.sh' }, ...validate },
        },
      ],
    } as never);
  assert.throws(load({ reseed: './reseed.sh' }), /both reseed this tenant/);
  assert.throws(load({ ensureTenant: './ensure.sh' }), /two answers to one question/);
  assert.throws(load({ tenantExtension: 'yes' }), /must be true/);
});

test('with no extension configured, every tenant command path is unchanged', async () => {
  const { system, commands } = await bench(null, [BY_COMMAND]);
  const prepared = await system.remoteRuns.prepareTenant('staging');
  assert.equal(prepared.ok, true, prepared.detail);
  assert.equal(commands.asked.length, 1);
});

test('the gate’s reseed control follows what the extension fills: provisioning alone is not destructive', async () => {
  const sheetTenant = async (source: string) => {
    const { system } = await bench(source);
    system.store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
    return buildStateSnapshot(system).remoteSheets[0]!.tenant;
  };
  const ensureOnly = await sheetTenant(`export default { apiVersion: 1, name: 'acme', slots: {
    ensureTenant: () => ({ tenant: 'acme-validation-7' }),
  } };`);
  assert.equal(ensureOnly.reseedable, true);
  assert.equal(ensureOnly.destructive, false);

  const both = await sheetTenant(RECORDING);
  assert.equal(both.reseedable, true);
  assert.equal(both.destructive, true, 'a reseedTenant slot wipes the tenant, and the gate must say so');
});

test('the desktop channel prepares an extension tenant, confirming first only where it reseeds', async () => {
  const prepareThrough = async (source: string, confirmTenant?: string) => {
    const { system } = await bench(source);
    system.store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
    const tools = buildDesktopTools(
      { ...desktopDeps(system), runCycle: async () => {}, now: () => new Date().toISOString() },
      { label: 'adam', held: null },
    );
    const tool = tools.find((t) => t.name === 'remote_validation_run')!;
    const result = await tool.handler({
      issue: 12,
      environment: 'acceptance',
      action: 'prepare_tenant',
      confirmTenant,
    });
    const settled = () => system.store.remoteValidation.listTenantPrepares().every((p) => p.finishedAt !== null);
    while (!settled()) await new Promise((r) => setImmediate(r));
    const prepared = system.store.remoteValidation.listTenantPrepares()[0];
    return { isError: result.isError === true, text: result.content[0]?.text ?? '', ok: prepared?.ok ?? null };
  };

  const provisioned = await prepareThrough(`export default { apiVersion: 1, name: 'acme', slots: {
    ensureTenant: () => ({ tenant: 'acme-validation-7' }),
  } };`);
  assert.equal(provisioned.isError, false, provisioned.text);
  assert.equal(provisioned.ok, true);

  const unconfirmed = await prepareThrough(RECORDING);
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.text, /confirmTenant/);

  const confirmed = await prepareThrough(RECORDING, 'acceptance');
  assert.equal(confirmed.isError, false, confirmed.text);
  assert.equal(confirmed.ok, true, 'with no tenant yet, the environment name is the confirmation, as for commands');
});

test('a slot’s progress lines show in the tenant output while it runs, with when it last spoke', async () => {
  const { system } = await bench(`
let release;
globalThis.__tenantRelease = () => release?.();
export default { apiVersion: 1, name: 'acme', slots: {
  ensureTenant: () => ({ tenant: 'acme-validation-7' }),
  reseedTenant: async (_, { progress }) => {
    progress('seeding orders\\nsign in at https://login.example.invalid');
    await new Promise((r) => { release = r; });
    progress('seeded');
  },
} };`);
  const g = globalThis as { __tenantRelease?: () => void };
  let settled = false;
  system.remoteRuns.beginPrepareTenant('acceptance', () => {
    settled = true;
  });
  let output = system.remoteRuns.tenantOutput('acceptance');
  while (!output.lines.includes('seeding orders')) {
    await new Promise((r) => setImmediate(r));
    output = system.remoteRuns.tenantOutput('acceptance');
  }
  assert.deepEqual(output.lines.slice(-2), ['seeding orders', 'sign in at https://login.example.invalid']);
  assert.notEqual(output.lastOutputAt, null);

  g.__tenantRelease?.();
  while (!settled) await new Promise((r) => setImmediate(r));
  delete g.__tenantRelease;
  assert.deepEqual(system.remoteRuns.tenantOutput('acceptance').lines.slice(-2), [
    'seeded',
    'it answered `acme-validation-7`',
  ]);
});
