import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { RemoteRunDesk } from '../src/remoteValidation/run.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { resolveTenant } from '../src/remoteValidation/tenants.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { loadConfig } from '../src/config.js';
import { stateDeclareNote, testPartNote, watchDeclareNote, watchNote } from '../src/plans/planning.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { StateQueryInput } from '../src/types.js';

/*
 * The tenant, in the three shapes a project may supply. The one rule everything here follows from:
 * **the harness never generates or infers a tenant identifier.** Environments commonly reap tenants
 * matching a name pattern past a short age, so an invented name survives about an hour and its
 * disappearance presents as mysterious mass failure.
 *
 * → docs/spec/36-remote-validation.md#tenants
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

function environment(validate: NonNullable<EnvironmentConfig['validate']>): EnvironmentConfig {
  return { name: 'acceptance', at: './scripts/deployed-sha.sh acceptance', validate };
}

const LITERAL = environment({
  permits: ['state'],
  tenant: 'validation-customer-1',
  reseed: './scripts/reseed.sh',
  tenantFreshnessMs: 7 * 86_400_000,
  state: { run: './scripts/query.sh' },
});

const FROM_ENV = environment({
  permits: ['state'],
  tenantEnv: 'VALIDATION_TENANT',
  state: { run: './scripts/query.sh' },
});

const PROVISIONED = environment({
  permits: ['state'],
  ensureTenant: './scripts/ensure-validation-tenant.sh',
  reseed: './scripts/reseed.sh',
  state: { run: './scripts/query.sh' },
});

interface Bench {
  store: Store;
  runs: RemoteRunDesk;
  tenants: FakeTenantKeeper;
  reader: FakeStateReader;
  close(): void;
}

function bench(env: EnvironmentConfig, opts: { env?: Record<string, string | undefined> } = {}): Bench {
  const environments = [env];
  const store = new Store(':memory:');
  const reader = new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
  const tenants = new FakeTenantKeeper({
    'ensure:acceptance': { tenant: 'reaper-safe-customer-9', detail: null },
  });
  const git = new FakeGitObserver().setContains(DEPLOYED, LANDED, true);
  const runs = new RemoteRunDesk({
    store,
    environments,
    desk: new RemoteValidationDesk({
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader }),
      runner: new FakeRemoteRunner(),
      probeIntervalMs: 60_000,
      now: () => NOW,
    }),
    prober: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
    git,
    tenants,
    now: () => NOW,
    env: opts.env ?? {},
  });
  return { store, runs, tenants, reader, close: () => store.close() };
}

function seed(store: Store): void {
  store.saveStateQueries('issue:12', [QUERY], 'agent');
  store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.approveStateQuery({
    digest: queryDigest(QUERY.query, QUERY.presence),
    environment: 'acceptance',
    originRef: 'issue:12',
    queryId: QUERY.id,
    rows: 0,
    detail: null,
  });
  store.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
  store.saveRemoteSheetRows('issue:12', 'acceptance', [
    {
      rowId: `state:${QUERY.id}`,
      kind: 'state',
      seq: 1,
      title: QUERY.title,
      sourceId: QUERY.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
    },
  ]);
}

test('a literal tenant is the shape to prefer: it locks on the name the project wrote down', () => {
  const resolved = resolveTenant({ environment: LITERAL, stamped: [], now: NOW });
  assert.equal(resolved.standing.tenant, 'validation-customer-1');
  assert.equal(resolved.value, 'validation-customer-1');
  assert.equal(resolved.standing.blockedReason, null);
});

test('a tenantEnv resolves its value, and the lock and every surface carry the variable’s name instead', () => {
  const resolved = resolveTenant({
    environment: FROM_ENV,
    stamped: [],
    now: NOW,
    env: { VALIDATION_TENANT: 'per-operator-tenant-77' },
  });
  assert.equal(resolved.value, 'per-operator-tenant-77', 'the value is what a command receives');
  assert.equal(resolved.standing.tenant, '$VALIDATION_TENANT', 'and never what a surface draws');
  assert.doesNotMatch(JSON.stringify(resolved.standing), /per-operator-tenant-77/);
});

test('a tenantEnv nobody set blocks the press, naming the variable rather than inventing a name', async () => {
  const b = bench(FROM_ENV, { env: {} });
  try {
    seed(b.store);
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, false);
    assert.match(!pressed.ok ? pressed.error : '', /VALIDATION_TENANT/);
    assert.match(!pressed.ok ? pressed.error : '', /never invents a tenant name/);
    assert.deepEqual(b.store.listRemoteRuns(), [], 'no run opened');
    assert.match(
      b.store.listRemoteSheetRows()[0]?.blockedReason ?? '',
      /VALIDATION_TENANT/,
      'and the sheet says so in its own words',
    );
    assert.deepEqual(b.reader.asked, [], 'nothing was put to the store');
  } finally {
    b.close();
  }
});

test('an ensureTenant nobody has run yet blocks, naming the command that would provide one', async () => {
  const b = bench(PROVISIONED);
  try {
    seed(b.store);
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, false);
    assert.match(!pressed.ok ? pressed.error : '', /ensure-validation-tenant\.sh/);
    assert.deepEqual(b.tenants.asked, [], 'and an arrival never runs it — it is an operator’s setup step');
  } finally {
    b.close();
  }
});

test('an operator invokes ensureTenant, and whatever it names is what is stamped and locked on', async () => {
  const b = bench(PROVISIONED);
  try {
    seed(b.store);
    const prepared = await b.runs.prepareTenant('acceptance');

    assert.equal(prepared.ok, true);
    assert.equal(prepared.standing.tenant, 'reaper-safe-customer-9', 'the command’s own name, never a made-up one');
    assert.deepEqual(
      b.tenants.asked.map((a) => `${a.call}:${a.command}`),
      ['ensure:./scripts/ensure-validation-tenant.sh', 'reseed:./scripts/reseed.sh'],
    );
    assert.equal(b.store.listRemoteTenants()[0]?.tenant, 'reaper-safe-customer-9');
    assert.notEqual(b.store.listRemoteTenants()[0]?.ensuredAt, null);
    assert.notEqual(b.store.listRemoteTenants()[0]?.reseededAt, null);

    const pressed = await b.runs.press('issue:12', 'acceptance');
    assert.equal(pressed.ok, true);
    assert.equal(b.store.listRemoteRuns()[0]?.tenant, 'reaper-safe-customer-9');
  } finally {
    b.close();
  }
});

test('a reseed stamps the tenant and clears its age; no process is spawned, on the fake’s own record', async () => {
  const b = bench(LITERAL);
  try {
    seed(b.store);
    assert.equal(
      resolveTenant({ environment: LITERAL, stamped: b.store.listRemoteTenants(), now: NOW }).standing.stale,
      true,
      'a tenant with a declared window and no reseed behind it is stale',
    );

    const prepared = await b.runs.prepareTenant('acceptance');
    assert.equal(prepared.ok, true);
    assert.deepEqual(
      b.tenants.asked.map((a) => `${a.call}:${a.tenant ?? ''}`),
      ['reseed:validation-customer-1'],
      'the command reached its fake and nothing was spawned',
    );
    assert.equal(b.store.listRemoteTenants()[0]?.tenant, 'validation-customer-1');
    assert.equal(
      resolveTenant({
        environment: LITERAL,
        stamped: b.store.listRemoteTenants(),
        now: Date.parse(b.store.listRemoteTenants()[0]!.reseededAt!),
      }).standing.stale,
      false,
      'and the age is cleared',
    );
  } finally {
    b.close();
  }
});

test('an environment declaring no tenant of any shape presses anyway, on no tenant at all', async () => {
  const none = environment({ permits: ['state'], state: { run: './scripts/query.sh' } });
  const b = bench(none);
  try {
    seed(b.store);
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, true);
    assert.equal(b.store.listRemoteRuns()[0]?.tenant, '', 'the absence, never a name the harness made up');
    assert.equal(b.store.listRemoteReadings().length, 1);
  } finally {
    b.close();
  }
});

/*
 * The negative that matters most: a `tenantEnv`'s value goes into the spawn env and nowhere else —
 * never into a prompt, never into the cockpit, never into a committed project layer.
 */
test('a tenantEnv’s value reaches neither a prompt, the cockpit, nor a committed project layer', async () => {
  const SECRET = 'per-operator-tenant-77';
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-tenant-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    repoRoot: dir,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments: [FROM_ENV],
  });
  const system: System = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    stateReader: new FakeStateReader(),
    tenants: new FakeTenantKeeper(),
    environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
    environmentObserver: new FakeEnvironmentObserver(),
    projectConfigFile: join(dir, 'absent.json'),
    errorMirror: () => {},
  });
  try {
    process.env['VALIDATION_TENANT'] = SECRET;
    seed(system.store);

    const snapshot = JSON.stringify(buildStateSnapshot(system));
    assert.doesNotMatch(snapshot, new RegExp(SECRET), 'the cockpit never ships the value');
    assert.match(snapshot, /\$VALIDATION_TENANT/, 'it ships the variable’s own name instead');

    // The notes are what this deployment's environments contribute to a rendered prompt, appended
    // rather than interpolated. None of them is a place a tenant's value may reach.
    const notes = [
      watchNote(config.environments),
      watchDeclareNote(config.environments),
      stateDeclareNote(config.environments),
      testPartNote(config.environments),
    ].join('\n');
    assert.doesNotMatch(notes, new RegExp(SECRET), 'and no prompt note carries it');
    assert.doesNotMatch(JSON.stringify(config.environments), new RegExp(SECRET), 'and no config layer holds it');
  } finally {
    delete process.env['VALIDATION_TENANT'];
    system.store.close();
  }
});
