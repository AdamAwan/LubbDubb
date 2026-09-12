import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { sheetFoldLine } from '../src/remoteValidation/sheet.js';
import { buildGoalPage } from '../web/src/view/goalPage.js';
import type { AppState, RemoteSheetView } from '../web/src/types.js';
import type { GoalReachView } from '../src/wire.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { ValidationCheckInput } from '../src/types.js';

/*
 * What the sheet card and the Environments card draw once a run has said something.
 * → docs/spec/36-remote-validation.md#the-cockpit
 *
 * Everything a surface here draws is folded on the **server**, off the rows the sheet card draws. A
 * cockpit that worked an outcome out for itself would be a second opinion drawn beside the reading
 * it describes, which is the disagreement this fold exists to prevent.
 */

const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const AREA = 'checkout with a saved card';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: {
    permits: ['check'],
    tenant: 'validation-customer-1',
    browser: {
      runner: 'npm run e2e -- --project=validation',
      listSelectors: 'npm run e2e -- --project=validation --list',
      profile: 'acc-uk',
      publishArtefacts: './scripts/publish-report.sh',
    },
  },
};

const CHECK: ValidationCheckInput = {
  id: 'an-order-places',
  seq: 1,
  title: 'An order still places end to end',
  do: 'Place one',
  expect: 'It places',
  uses: [],
  covers: [],
  fleetCandidate: false,
  candidateWhy: null,
};

function system(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remote-cockpit-'));
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
      environments: [ACCEPTANCE],
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      remoteRunner: new FakeRemoteRunner(),
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
}

/** One sheet of three rows: one read, one that learned nothing, and one nobody has run. */
function seed(sys: System): void {
  const { store } = sys;
  store.validation.ingestValidation('issue:12', {
    checks: [CHECK],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
  store.remoteValidation.saveRemoteSheetRows('issue:12', 'acceptance', [
    {
      rowId: `check:${CHECK.id}`,
      kind: 'check',
      seq: 1,
      title: CHECK.title,
      sourceId: CHECK.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: 4,
    },
    {
      rowId: 'check:history-loads',
      kind: 'check',
      seq: 2,
      title: 'The order history still loads',
      sourceId: 'history-loads',
      selected: true,
      blockedReason: 'the runner on acceptance offers no selector `the order history`.',
      awaitingApproval: false,
      matched: 0,
    },
    {
      rowId: 'check:refunds-work',
      kind: 'check',
      seq: 3,
      title: 'Refunds still work',
      sourceId: 'refunds-work',
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
    },
  ]);
  const { run } = store.remoteValidation.beginRemoteRun({
    goalRef: 'issue:12',
    environment: 'acceptance',
    tenant: 'validation-customer-1',
    startedSha: DEPLOYED,
  });
  store.remoteValidation.recordRemoteReading({
    goalRef: 'issue:12',
    environment: 'acceptance',
    rowId: `check:${CHECK.id}`,
    runId: run?.id ?? null,
    outcome: 'passed',
    rows: 4,
    value: null,
    detail: `acceptance ran 4 tests under \`${AREA}\` and every one passed, after 1 retry.`,
    startedSha: DEPLOYED,
    endedSha: DEPLOYED,
    executed: 4,
    retries: 1,
    durationMs: 41_000,
    artefacts: 'https://reports.example.com/run/9f2c',
  });
}

function snapshot(sys: System): Record<string, unknown> {
  return buildStateSnapshot(sys) as unknown as Record<string, unknown>;
}

test('a reading reaches the sheet card on the wire, with what it cost and where its report is', () => {
  const sys = system();
  try {
    seed(sys);
    const sheets = snapshot(sys)['remoteSheets'] as RemoteSheetView[];
    const row = sheets[0]?.rows.find((r) => r.rowId === `check:${CHECK.id}`);

    assert.equal(row?.matched, 4, 'the matched count is the pre-flight’s own, on the row');
    assert.equal(row?.reading?.executed, 4, 'and what ran is the report’s, on the reading');
    assert.equal(row?.reading?.retries, 1);
    assert.equal(row?.reading?.durationMs, 41_000);
    assert.equal(row?.reading?.artefacts, 'https://reports.example.com/run/9f2c');
    assert.equal(row?.reading?.outcome, 'passed');
    assert.equal(row?.reading?.startedSha, DEPLOYED, 'attributed to the commits the run straddled');
    assert.equal(row?.reading?.endedSha, DEPLOYED);
  } finally {
    sys.store.close();
  }
});

test('a blocked row and an unread one say why in words, never in a clean reading’s vocabulary', () => {
  const sys = system();
  try {
    seed(sys);
    const sheets = snapshot(sys)['remoteSheets'] as RemoteSheetView[];
    const blocked = sheets[0]?.rows.find((r) => r.rowId === 'check:history-loads');
    const unread = sheets[0]?.rows.find((r) => r.rowId === 'check:refunds-work');

    assert.match(blocked?.blockedReason ?? '', /offers no selector/, 'why, in words');
    assert.equal(blocked?.reading, null, 'and no reading, because nothing was learned');
    assert.equal(unread?.blockedReason, null);
    assert.equal(unread?.reading, null, 'a row nothing has run is neither passed nor failed');
  } finally {
    sys.store.close();
  }
});

test('the Environments card’s folded line is folded on the server, off the same rows', () => {
  const sys = system();
  try {
    seed(sys);
    const state = snapshot(sys);
    const reach = (state['environmentReach'] as GoalReachView[]).find((r) => r.goalRef === 'issue:12');
    const row = reach?.environments.find((e) => e.environment === 'acceptance');

    assert.equal(row?.sheet, 'sheet · 3 rows · 1 blocked', 'the line the card draws is already a string on the wire');

    // The same fold, off the same rows, so a change to one is a change to both.
    const sheets = state['remoteSheets'] as RemoteSheetView[];
    assert.equal(
      sheetFoldLine(
        sheets[0]!.rows.map((r) => ({ blockedReason: r.blockedReason, outcome: r.reading?.outcome ?? null })),
      ),
      row?.sheet,
    );
  } finally {
    sys.store.close();
  }
});

test('a failed row and a blocked one are both folded into the line, and a goal with no sheet has none', () => {
  assert.equal(
    sheetFoldLine([
      { blockedReason: null, outcome: 'passed' },
      { blockedReason: null, outcome: 'failed' },
      { blockedReason: 'no tenant', outcome: null },
      { blockedReason: null, outcome: 'blocked' },
    ]),
    'sheet · 4 rows · 1 failed · 2 blocked',
    'a row nothing was learned from is blocked whichever road it took there',
  );
  assert.equal(sheetFoldLine([]), null, 'and a goal with no sheet gets no line rather than an empty one');
});

test('the goal page draws the card the sheet earns, and the reading on it', () => {
  const sys = system();
  try {
    seed(sys);
    const state = snapshot(sys);
    const world = state['world'] as { issues: unknown[] };
    const withGoal = { ...state, world: { ...world, issues: [...world.issues, { number: 12, title: 'A goal' }] } };
    const page = buildGoalPage(withGoal as unknown as AppState, 'issue:12', []);

    assert.ok(page);
    assert.equal(page.remoteSheets.length, 1);
    assert.equal(page.remoteSheets[0]?.rows.length, 3);
    assert.equal(page.remoteSheets[0]?.rows[0]?.reading?.artefacts, 'https://reports.example.com/run/9f2c');
  } finally {
    sys.store.close();
  }
});
