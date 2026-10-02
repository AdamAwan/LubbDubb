import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentSink } from './support/commentSink.js';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/validation/remote/desk.js';
import { RemoteRunDesk } from '../src/validation/remote/run.js';
import { StateQueryDesk } from '../src/validation/remote/stateQueries.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import { watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { resolveTenant, type OperatorTenants } from '../src/validation/remote/tenants.js';
import { loadConfig, loadConfigFromText, projectConfigLayer } from '../src/config/config.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { StateQueryInput } from '../src/types.js';

// → docs/spec/36-remote-validation.md#an-operators-own-tenant

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';
const NO_CAPTURES = join(tmpdir(), 'lubbdubb-no-captures');

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

const HALLWAY: EnvironmentConfig = {
  name: 'hallway',
  at: './scripts/deployed-sha.sh hallway',
  validate: { permits: ['state'], tenantEnv: 'LUBBDUBB_VALIDATION_TENANT', state: { run: './scripts/query.sh' } },
};

test('an operator’s own tenant answers a tenantEnv environment the variable left unset', () => {
  const resolved = resolveTenant({
    environment: HALLWAY,
    stamped: [],
    now: NOW,
    env: {},
    operatorTenants: { hallway: 'adam' },
  });
  assert.equal(resolved.value, 'adam');
  assert.equal(resolved.standing.tenant, 'adam', 'a name from config is a name, and surfaces draw it');
  assert.equal(resolved.standing.blockedReason, null);
});

test('the variable, where set, still wins — env over the config file, as everywhere else', () => {
  const resolved = resolveTenant({
    environment: HALLWAY,
    stamped: [],
    now: NOW,
    env: { LUBBDUBB_VALIDATION_TENANT: 'from-the-shell' },
    operatorTenants: { hallway: 'adam' },
  });
  assert.equal(resolved.value, 'from-the-shell');
  assert.equal(resolved.standing.tenant, '$LUBBDUBB_VALIDATION_TENANT');
});

test('neither set blocks, naming the key and the variable, and inventing nothing', () => {
  const resolved = resolveTenant({ environment: HALLWAY, stamped: [], now: NOW, env: {}, operatorTenants: {} });
  const reason = resolved.standing.blockedReason ?? '';
  assert.equal(resolved.value, null);
  assert.match(reason, /"remoteValidation\.tenants": \{ "hallway"/);
  assert.match(reason, /LUBBDUBB_VALIDATION_TENANT/);
  assert.match(reason, /never invents a tenant name/);
  assert.doesNotMatch(reason, /secret|password|token|credential/i);
});

test('an operator tenant never answers a shape other than tenantEnv', () => {
  const literal: EnvironmentConfig = {
    ...HALLWAY,
    validate: { permits: ['state'], tenant: 'shared-customer', state: { run: './scripts/query.sh' } },
  };
  const resolved = resolveTenant({
    environment: literal,
    stamped: [],
    now: NOW,
    env: {},
    operatorTenants: { hallway: 'adam' },
  });
  assert.equal(resolved.value, 'shared-customer');
});

function bench(operatorTenants: OperatorTenants): { store: Store; runs: RemoteRunDesk } {
  const environments = [HALLWAY];
  const store = new Store(':memory:');
  const reader = new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
  const runs = new RemoteRunDesk({
    store,
    environments,
    desk: new RemoteValidationDesk({
      sink: commentSink(),
      validationRoot: NO_CAPTURES,
      store,
      environments,
      queries: new StateQueryDesk({ store, environments, reader }),
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: 60_000,
      now: () => NOW,
      env: {},
      operatorTenants,
    }),
    prober: new FakeEnvironmentProber({ hallway: [DEPLOYED] }),
    git: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
    tenants: new FakeTenantKeeper({}),
    now: () => NOW,
    env: {},
    operatorTenants,
  });
  store.remoteValidation.saveStateQueries('issue:12', [QUERY], 'agent');
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.remoteValidation.approveStateQuery({
    digest: queryDigest(QUERY.query, QUERY.presence),
    environment: 'hallway',
    originRef: 'issue:12',
    queryId: QUERY.id,
    rows: 0,
    detail: null,
  });
  store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'hallway' });
  store.remoteValidation.saveRemoteSheetRows('issue:12', 'hallway', [
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
      idleReason: null,
    },
  ]);
  return { store, runs };
}

test('a press runs against the operator’s own tenant, and locks on it', async () => {
  const b = bench({ hallway: 'adam' });
  try {
    const pressed = await b.runs.press('issue:12', 'hallway');
    assert.equal(pressed.ok, true, !pressed.ok ? pressed.error : '');
    assert.equal(b.store.remoteValidation.listRemoteRuns()[0]?.tenant, 'adam');
  } finally {
    b.store.close();
  }
});

test('with no operator tenant the same press is refused and opens no run', async () => {
  const b = bench({});
  try {
    const pressed = await b.runs.press('issue:12', 'hallway');
    assert.equal(pressed.ok, false);
    assert.match(!pressed.ok ? pressed.error : '', /remoteValidation\.tenants/);
    assert.deepEqual(b.store.remoteValidation.listRemoteRuns(), []);
  } finally {
    b.store.close();
  }
});

test('the operator names a tenant and still inherits every environment from the project file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-operator-tenant-'));
  writeFileSync(join(dir, 'lubbdubb.project.json'), JSON.stringify({ environments: [HALLWAY] }));
  const config = loadConfigFromText(
    JSON.stringify({ repoRoot: dir, dbPath: ':memory:', remoteValidation: { tenants: { hallway: 'adam' } } }),
    join(dir, 'lubbdubb.config.json'),
  );
  assert.deepEqual(config.environments, [HALLWAY]);
  assert.deepEqual(config.remoteValidation.tenants, { hallway: 'adam' });
});

test('the project file refuses remoteValidation.tenants — a tenant here is one person’s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-operator-tenant-'));
  const file = join(dir, 'lubbdubb.project.json');
  writeFileSync(file, JSON.stringify({ environments: [HALLWAY], remoteValidation: { tenants: { hallway: 'adam' } } }));
  assert.throws(() => projectConfigLayer(file), /remoteValidation\.tenants.*lubbdubb\.config\.json/s);
});

test('an entry nothing would read is refused at load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-operator-tenant-'));
  const load =
    (tenants: unknown, environments: EnvironmentConfig[] = [HALLWAY]) =>
    () =>
      loadConfig({ repoRoot: dir, dbPath: ':memory:', environments, remoteValidation: { tenants } } as never);
  assert.throws(load({ corridor: 'adam' }), /no environment is named "corridor"/);
  assert.throws(load({ hallway: '  ' }), /non-empty tenant name/);
  assert.throws(load(['adam']), /must be an object/);
  const literal = { ...HALLWAY, validate: { permits: ['state'], tenant: 'shared', state: { run: './q.sh' } } };
  assert.throws(load({ hallway: 'adam' }, [literal as EnvironmentConfig]), /does not take a per-operator tenant/);
  assert.doesNotThrow(load({ hallway: 'adam' }));
});
