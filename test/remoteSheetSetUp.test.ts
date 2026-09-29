import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';

// → docs/spec/36-remote-validation.md#setting-one-up-by-hand

const HALLWAY: EnvironmentConfig = {
  name: 'hallway',
  at: 'echo',
  validate: {
    permits: ['check'],
    tenant: 'validation-customer-1',
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list', profile: 'uk' },
  },
};

function system(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sheet-setup-'));
  return buildSystem(
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
      environments: [HALLWAY, { name: 'prod', at: 'echo' }],
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
}

function accept(sys: System): void {
  sys.store.validation.ingestValidation('issue:12', {
    checks: [
      {
        id: 'a-check',
        seq: 1,
        title: 'A check',
        do: 'Do it',
        expect: 'It works',
        proof: null,
        uses: [],
        covers: [],
        fleetCandidate: false,
        candidateWhy: null,
      },
    ],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
}

const sheets = (sys: System) => sys.store.remoteValidation.listRemoteSheets().filter((s) => s.goalRef === 'issue:12');

test('an arrival the pulse stamped without a sheet can be set up by hand', async () => {
  const sys = system();
  try {
    accept(sys);
    sys.store.environments.recordGoalArrival({
      goalRef: 'issue:12',
      environment: 'hallway',
      arrivedAt: '2020-01-01T00:00:00.000Z',
    });
    sys.store.environments.markArrivalSheeted('issue:12', 'hallway');

    assert.equal(await sys.remoteValidation.setUpSheet('issue:12', 'hallway'), null);
    assert.deepEqual(
      sheets(sys).map((s) => s.environment),
      ['hallway'],
    );
    assert.match((await sys.remoteValidation.setUpSheet('issue:12', 'hallway')) ?? '', /already set up/);
  } finally {
    sys.store.close();
  }
});

test('setting one up by hand is refused, in words, wherever the pulse would still refuse it', async () => {
  const sys = system();
  try {
    assert.match((await sys.remoteValidation.setUpSheet('issue:12', 'prod')) ?? '', /declares no `validate` block/);
    assert.match(
      (await sys.remoteValidation.setUpSheet('issue:12', 'hallway')) ?? '',
      /not recorded as having reached/,
    );
    sys.store.environments.recordGoalArrival({
      goalRef: 'issue:12',
      environment: 'hallway',
      arrivedAt: '2020-01-01T00:00:00.000Z',
    });
    assert.match((await sys.remoteValidation.setUpSheet('issue:12', 'hallway')) ?? '', /not accepted yet/);
    assert.deepEqual(sheets(sys), []);
  } finally {
    sys.store.close();
  }
});
