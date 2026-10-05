import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { desktopDeps } from './support/desktop.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { StateQueryInput } from '../src/types.js';

/*
 * Remote validation from the operator's own Claude Code: the plugin asks the harness to run a
 * tenant's checks, and never runs them itself. → docs/spec/11-mcp-tools.md#remote-validation-from-the-desktop
 *
 * Every fake a `validate` block reaches is injected — the defaults spawn the project's own scripts.
 */

const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: {
    permits: ['state'],
    tenant: 'validation-customer-1',
    reseed: './scripts/reseed.sh',
    tenantFreshnessMs: 7 * 86_400_000,
    state: { run: './scripts/query.sh acceptance' },
  },
};

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

interface Bench {
  system: System;
  tenants: FakeTenantKeeper;
  cycles: () => number;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: Record<string, unknown> }>;
}

function bench(): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-desktop-remote-'));
  const tenants = new FakeTenantKeeper();
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot: dir,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      environments: [ACCEPTANCE],
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      stateReader: new FakeStateReader({
        [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
        [`${QUERY.id}:state`]: JSON.stringify([]),
      }),
      tenants,
      environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
  let cycles = 0;
  const tools = buildDesktopTools(
    {
      ...desktopDeps(system),
      runCycle: async () => {
        cycles += 1;
      },
      now: () => new Date().toISOString(),
    },
    { label: 'adam', held: null },
  );
  return {
    system,
    tenants,
    cycles: () => cycles,
    call: async (name, args) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is on the desktop channel`);
      const result = await tool.handler(args);
      const text = result.content[0]?.text ?? '';
      return { isError: result.isError === true, json: result.isError === true ? { error: text } : JSON.parse(text) };
    },
  };
}

function seed({ store, remoteValidation }: System): void {
  store.validation.ingestValidation('issue:12', {
    checks: [],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  store.remoteValidation.saveStateQueries('issue:12', [QUERY], 'agent');
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.remoteValidation.approveStateQuery({
    digest: queryDigest(QUERY.query, QUERY.presence),
    environment: ACCEPTANCE.name,
    originRef: 'issue:12',
    queryId: QUERY.id,
    rows: 0,
    detail: null,
  });
  store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: ACCEPTANCE.name });
  store.remoteValidation.saveRemoteSheetRows(
    'issue:12',
    ACCEPTANCE.name,
    remoteValidation.fold(ACCEPTANCE, 'issue:12').map(({ run: _run, ...row }) => row),
  );
}

test('the remote validation tools are the desktop channel’s and not the fleet’s', () => {
  for (const name of ['remote_validation_read', 'remote_validation_run'] as const) {
    assert.ok(DESKTOP_TOOL_NAMES.includes(name));
    assert.ok(!MCP_TOOL_NAMES.includes(name as never));
  }
});

test('the read carries the sheet the cockpit draws, with its tenant by name', async () => {
  const b = bench();
  try {
    seed(b.system);
    const read = await b.call('remote_validation_read', { issue: 12 });
    assert.equal(read.isError, false, String(read.json.error));
    const sheets = read.json.sheets as { environment: string; tenant: { name: string }; rows: { rowId: string }[] }[];
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0]!.environment, 'acceptance');
    assert.equal(sheets[0]!.tenant.name, 'validation-customer-1');
    assert.equal(sheets[0]!.rows.length, 1);
    assert.deepEqual(read.json.noSheet, []);
  } finally {
    b.system.store.close();
  }
});

test('a press from the desktop is the harness’s press: it opens the run, reads the rows and runs a cycle', async () => {
  const b = bench();
  try {
    seed(b.system);
    const pressed = await b.call('remote_validation_run', { issue: 12, environment: 'acceptance', action: 'press' });
    assert.equal(pressed.isError, false, String(pressed.json.error));
    assert.equal(pressed.json.read, 1);
    assert.equal(b.cycles(), 1);
    const runs = b.system.store.remoteValidation.listRemoteRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.tenant, 'validation-customer-1');
    assert.equal(b.system.store.remoteValidation.listRemoteReadings().length, 1);
  } finally {
    b.system.store.close();
  }
});

test('the OK from the desktop writes the intent the pulse presses', async () => {
  const b = bench();
  try {
    seed(b.system);
    const given = await b.call('remote_validation_run', { issue: 12, environment: 'acceptance', action: 'ok' });
    assert.equal(given.isError, false, String(given.json.error));
    assert.equal(given.json.given, 'given');
    assert.equal(b.cycles(), 1);
    assert.equal(b.system.store.remoteIntents.getIntent('issue:12', 'acceptance')?.state, 'given');
  } finally {
    b.system.store.close();
  }
});

test('a reseed is refused until the tenant it destroys is typed back, then the harness runs it', async () => {
  const b = bench();
  try {
    seed(b.system);
    const unconfirmed = await b.call('remote_validation_run', {
      issue: 12,
      environment: 'acceptance',
      action: 'prepare_tenant',
    });
    assert.equal(unconfirmed.isError, true);
    assert.match(String(unconfirmed.json.error), /validation-customer-1/);
    assert.equal(b.tenants.asked.length, 0, 'nothing ran');

    const confirmed = await b.call('remote_validation_run', {
      issue: 12,
      environment: 'acceptance',
      action: 'prepare_tenant',
      confirmTenant: 'validation-customer-1',
    });
    assert.equal(confirmed.isError, false, String(confirmed.json.error));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      b.tenants.asked.map((a) => a.call),
      ['reseed'],
    );
  } finally {
    b.system.store.close();
  }
});

test('an unknown environment is refused in words, not thrown', async () => {
  const b = bench();
  try {
    seed(b.system);
    const refused = await b.call('remote_validation_run', { issue: 12, environment: 'nowhere', action: 'press' });
    assert.equal(refused.isError, true);
    assert.match(String(refused.json.error), /nowhere/);
  } finally {
    b.system.store.close();
  }
});
