import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Issue, IssueDelivery, RemoteReading, ValidationCheckInput } from '../src/types.js';

/*
 * Folding the report into readings, and saying so.
 * → docs/spec/36-remote-validation.md#the-report-is-the-only-source-of-row-outcomes
 *
 * Every system here injects `FakeRemoteRunner`, `FakeStateReader`, `FakeTenantKeeper`,
 * `FakeEnvironmentProber` and `FakeWorktreeManager`. The defaults are the command implementations
 * and the real worktree manager, so a test that configures a `validate.browser` block and injects
 * none of them drives a browser against somebody's acceptance environment out of a lease cut in
 * your own checkout — and passes while doing it.
 */

const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';
const MOVED = 'ccccccc3333333333333333333333333333333cc';
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const AREA = 'checkout with a saved card';
const OTHER_AREA = 'the order history';

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

function check(id: string, title: string): ValidationCheckInput {
  return {
    id,
    seq: 1,
    title,
    do: 'Place one',
    expect: 'It places',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
  };
}

const CHECK = check('an-order-places', 'An order still places end to end');
const SECOND = check('history-loads', 'The order history still loads');

function issue(): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship the channel',
    body: 'orders should carry a channel',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'PR #40 landed it',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T12:00:00.000Z',
  };
}

interface Bench {
  sys: System;
  dir: string;
  file: string;
  heads: Record<string, string[]>;
  runner: FakeRemoteRunner;
  close(): void;
}

function bench(environments: EnvironmentConfig[] = [ACCEPTANCE]): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remote-readings-'));
  const file = join(dir, 'harness.db');
  const heads: Record<string, string[]> = { acceptance: [DEPLOYED] };
  const runner = new FakeRemoteRunner({
    acceptance: { run: { said: null, detail: 'the runner exited 1' }, artefacts: { said: null, detail: null } },
  });
  const sys = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: file,
      agentMode: 'raw',
      repoRoot: dir,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      environments,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      remoteRunner: runner,
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      environmentProber: new FakeEnvironmentProber(heads),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
  return { sys, dir, file, heads, runner, close: () => sys.store.close() };
}

/**
 * How an author *declares* an area is not built — the column is. A test writes one the way whatever
 * declares it later will: onto the column, on a check that exists.
 */
function setArea(file: string, checkId: string, area: string): void {
  const db = new Database(file);
  try {
    db.prepare(`UPDATE validation_checks SET area=? WHERE origin_ref=? AND id=?`).run(area, 'issue:12', checkId);
  } finally {
    db.close();
  }
}

/** A delivered, landed and sheeted goal, with one confirmed `check` row the pre-flight matched. */
function seed(b: Bench, rows: { check: ValidationCheckInput; area: string; matched: number | null }[]): string {
  const { store } = b.sys;
  store.ingestValidation('issue:12', {
    checks: rows.map((r) => r.check),
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
  store.saveRemoteSheetRows(
    'issue:12',
    'acceptance',
    rows.map((r, at) => ({
      rowId: `check:${r.check.id}`,
      kind: 'check' as const,
      seq: at + 1,
      title: r.check.title,
      sourceId: r.check.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: r.matched,
    })),
  );
  for (const r of rows) setArea(b.file, r.check.id, r.area);
  const { run } = store.beginRemoteRun({
    goalRef: 'issue:12',
    environment: 'acceptance',
    tenant: 'validation-customer-1',
    startedSha: DEPLOYED,
  });
  assert.ok(run, 'the press opened a run');
  return run.id;
}

interface TestLine {
  selector: string;
  status: string;
  retries?: number;
  durationMs?: number;
  note?: string;
}

function report(b: Bench, tests: TestLine[], name = 'results.json'): string {
  const path = join(b.dir, name);
  writeFileSync(path, JSON.stringify(tests), 'utf8');
  return path;
}

function reading(b: Bench, checkId: string): RemoteReading {
  const found = b.sys.store
    .listRemoteReadings()
    .filter((r) => r.rowId === `check:${checkId}`)
    .at(-1);
  assert.ok(found, `a reading landed on ${checkId}`);
  return found;
}

async function settle(b: Bench, runId: string, path: string, artefacts: string | null = null): Promise<void> {
  const settled = await b.sys.remoteReadings.settle(runId, { reportPath: path, artefacts });
  assert.equal(settled.ok, true, settled.ok ? '' : settled.error);
}

/* ── the report is the only source of row outcomes ───────────────────────────────────────────── */

test('a non-zero exit over a report full of passes yields passes', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 2 }]);
    // The runner said it failed. One invocation carries many rows and one code, so nothing here may
    // read it — and the fake's own record is what proves the code was available and left unread.
    const outcome = await b.runner.run({
      environment: 'acceptance',
      command: ACCEPTANCE.validate!.browser!.runner!,
      profile: 'acc-uk',
      tenant: 'validation-customer-1',
      selectors: [AREA],
      reportDir: b.dir,
    });
    assert.equal(outcome.detail, 'the runner exited 1', 'the invocation did not come back clean');

    await settle(
      b,
      runId,
      report(b, [
        { selector: AREA, status: 'passed' },
        { selector: AREA, status: 'passed' },
      ]),
    );

    assert.equal(reading(b, CHECK.id).outcome, 'passed');
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.state, 'passed');
  } finally {
    b.close();
  }
});

test('a zero exit over a report full of failures yields failures', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 2 }]);
    const clean = await b.runner.publishArtefacts({
      environment: 'acceptance',
      command: './scripts/publish-report.sh',
      profile: null,
      tenant: null,
      selectors: [],
      reportDir: b.dir,
    });
    assert.equal(clean.detail, null, 'the invocation came back clean');

    await settle(
      b,
      runId,
      report(b, [
        { selector: AREA, status: 'failed' },
        { selector: AREA, status: 'passed' },
      ]),
    );

    assert.equal(reading(b, CHECK.id).outcome, 'failed', 'and a clean exit decides nothing either');
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.state, 'failed');
  } finally {
    b.close();
  }
});

test('the matched count is the pre-flight’s listing, never the report’s own arithmetic', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 4 }]);
    // Two passes in the report, four matched by the listing. Counted off the report this reads as a
    // clean pass; counted off the listing it is the narrowing case, which is what it is.
    await settle(
      b,
      runId,
      report(b, [
        { selector: AREA, status: 'passed' },
        { selector: AREA, status: 'passed' },
      ]),
    );

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'blocked');
    assert.equal(read.rows, 4, 'the matched count on the reading is the row’s, which the pre-flight wrote');
    assert.equal(read.executed, 2, 'and executed is the report’s');
    assert.match(read.detail ?? '', /matched 4 tests .* and only 2 ran/);
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.state, 'unrun', 'a blocked row writes nothing');
  } finally {
    b.close();
  }
});

test('a selector the report names no test under is blocked, never passed', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 2 }]);
    await settle(b, runId, report(b, [{ selector: OTHER_AREA, status: 'passed' }]));

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'blocked');
    assert.match(read.detail ?? '', /names no test under/);
    assert.match(read.detail ?? '', /never a pass/);
  } finally {
    b.close();
  }
});

test('a row whose matched count is zero is blocked rather than quietly clean', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 0 }]);
    await settle(b, runId, report(b, [{ selector: AREA, status: 'passed' }]));

    assert.equal(reading(b, CHECK.id).outcome, 'blocked');
    assert.match(reading(b, CHECK.id).detail ?? '', /attributed no tests/);
  } finally {
    b.close();
  }
});

test('tests skipped because a dependency failed are blocked, never failed', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 3 }]);
    await settle(
      b,
      runId,
      report(b, [
        { selector: AREA, status: 'skipped', note: 'the auth-setup project failed' },
        { selector: AREA, status: 'skipped', note: 'the auth-setup project failed' },
        { selector: AREA, status: 'skipped', note: 'the auth-setup project failed' },
      ]),
    );

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'blocked', 'that is what a failed auth-setup project looks like');
    assert.equal(read.executed, 0);
    assert.match(read.detail ?? '', /auth-setup project failed/, 'and the report is what distinguishes it');
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.state, 'unrun');
  } finally {
    b.close();
  }
});

test('a report that omits the tests a failed dependency held names that failure, not a renamed area', async () => {
  // A runner mapping its own report one-to-one drops the projects it never reached rather than
  // reporting them skipped, so this arrives at the zero-match arm rather than the narrowing one.
  // The harness cannot know the suite's dependency graph; a failure under another selector is the
  // only evidence of one it has, and naming it beats reporting a deleted spec.
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    await settle(b, runId, report(b, [{ selector: OTHER_AREA, status: 'failed' }]));

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'blocked');
    assert.match(read.detail ?? '', /names no test under/);
    assert.match(read.detail ?? '', new RegExp(`\`${OTHER_AREA}\` did`), 'the failure elsewhere is named');
    assert.match(read.detail ?? '', /failed dependency/);
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.state, 'unrun');
  } finally {
    b.close();
  }
});

test('a retried pass is a pass, and the row records that it was retried', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 2 }]);
    await settle(
      b,
      runId,
      report(b, [
        { selector: AREA, status: 'passed', retries: 2, durationMs: 41_000 },
        { selector: AREA, status: 'passed', retries: 0, durationMs: 9_000 },
      ]),
      'https://reports.example.com/run/9f2c',
    );

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'passed', 'retry policy belongs to the project’s runner config');
    assert.equal(read.retries, 2, 'and repeated retries on one area are a signal about the spec');
    assert.equal(read.durationMs, 50_000);
    assert.equal(read.executed, 2);
    assert.equal(read.artefacts, 'https://reports.example.com/run/9f2c');
    assert.match(read.detail ?? '', /after 2 retries/);
  } finally {
    b.close();
  }
});

/* ── the environment-moved asymmetry ─────────────────────────────────────────────────────────── */

test('an environment that moved under the run blocks a failure', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    b.heads['acceptance'] = [MOVED];
    await settle(b, runId, report(b, [{ selector: AREA, status: 'failed' }]));

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'blocked', 'the thing under test changed underneath the run');
    assert.equal(read.startedSha, DEPLOYED);
    assert.equal(read.endedSha, MOVED, 'and the row records which commits it straddled');
    assert.match(read.detail ?? '', /moved under this run/);
    assert.equal(
      b.sys.store.listValidationChecks('issue:12')[0]?.state,
      'unrun',
      'a blocked row writes nothing on the check',
    );
  } finally {
    b.close();
  }
});

test('an environment that moved under the run leaves a pass a pass', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    b.heads['acceptance'] = [MOVED];
    await settle(b, runId, report(b, [{ selector: AREA, status: 'passed' }]));

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'passed', 'a journey that completed completed');
    assert.equal(read.startedSha, DEPLOYED);
    assert.equal(read.endedSha, MOVED, 'and it records the same two commits');
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.state, 'passed');
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.resultBy, 'spec');
  } finally {
    b.close();
  }
});

test('a later run supersedes rather than deletes, and every reading carries the run’s commits', async () => {
  const b = bench();
  try {
    const first = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    await settle(b, first, report(b, [{ selector: AREA, status: 'failed' }], 'first.json'));
    const { run: second } = b.sys.store.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    assert.ok(second);
    await settle(b, second.id, report(b, [{ selector: AREA, status: 'passed' }], 'second.json'));

    const readings = b.sys.store.listRemoteReadings();
    assert.deepEqual(
      readings.map((r) => r.outcome),
      ['failed', 'passed'],
      'the first reading is still there — append-only, superseded rather than deleted',
    );
    for (const read of readings) {
      assert.equal(read.startedSha, DEPLOYED);
      assert.equal(read.endedSha, DEPLOYED, 'a reading with no commit beside it is of a product nobody can name');
    }
    assert.equal(b.sys.store.getRemoteRun(first)?.reportPath?.endsWith('first.json'), true);
    assert.equal(b.sys.store.getRemoteRun(second.id)?.status, 'ended');
  } finally {
    b.close();
  }
});

/* ── what a spec reading may write on ────────────────────────────────────────────────────────── */

test('a run writes on an unrun check, and again on one whose last reading was its own', async () => {
  const b = bench();
  try {
    const first = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    await settle(b, first, report(b, [{ selector: AREA, status: 'passed' }], 'first.json'));
    assert.equal(b.sys.store.listValidationChecks('issue:12')[0]?.resultBy, 'spec');

    const { run: second } = b.sys.store.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    assert.ok(second);
    await settle(b, second.id, report(b, [{ selector: AREA, status: 'failed' }], 'second.json'));

    const settled = b.sys.store.listValidationChecks('issue:12')[0];
    assert.equal(settled?.state, 'failed', 'a spec reading may replace a spec reading');
    assert.equal(settled?.resultBy, 'spec');
  } finally {
    b.close();
  }
});

for (const by of ['operator', 'agent', 'desktop'] as const) {
  test(`a run does not overwrite a reading ${by} took, and the sheet says whose it is not replacing`, async () => {
    const b = bench();
    try {
      const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
      b.sys.store.recordValidationResult('issue:12', CHECK.id, {
        state: 'passed',
        note: 'I placed one and it placed',
        by,
      });

      await settle(b, runId, report(b, [{ selector: AREA, status: 'failed' }]));

      const kept = b.sys.store.listValidationChecks('issue:12')[0];
      assert.equal(kept?.state, 'passed', 'a reading somebody took is theirs');
      assert.equal(kept?.resultBy, by);
      assert.equal(kept?.resultNote, 'I placed one and it placed');

      const read = reading(b, CHECK.id);
      assert.equal(read.outcome, 'failed', 'the row still ran and the reading still landed on the sheet');
      assert.match(read.detail ?? '', /not written onto the goal's own check/);
      assert.match(read.detail ?? '', /The sheet keeps this one instead/);
    } finally {
      b.close();
    }
  });
}

test('a blocked row writes nothing at all on the check', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    await settle(b, runId, join(b.dir, 'a-report-that-is-not-there.json'));

    const read = reading(b, CHECK.id);
    assert.equal(read.outcome, 'blocked');
    assert.match(read.detail ?? '', /could not be opened/);
    const check = b.sys.store.listValidationChecks('issue:12')[0];
    assert.equal(check?.state, 'unrun');
    assert.equal(check?.resultBy, null, 'no reading was taken, so nothing is attributed to anybody');
  } finally {
    b.close();
  }
});

test('a check that names no area is a person’s, and a run writes nothing on it', async () => {
  const b = bench();
  try {
    const { store } = b.sys;
    store.ingestValidation('issue:12', { checks: [CHECK], resources: [], supersededReason: '', amendNote: '' });
    store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
    store.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
    store.saveRemoteSheetRows('issue:12', 'acceptance', [
      {
        rowId: `check:${CHECK.id}`,
        kind: 'check',
        seq: 1,
        title: CHECK.title,
        sourceId: CHECK.id,
        selected: true,
        blockedReason: null,
        awaitingApproval: false,
        matched: null,
      },
    ]);
    const { run } = store.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    assert.ok(run);
    await settle(b, run.id, report(b, [{ selector: AREA, status: 'failed' }]));

    assert.deepEqual(
      store.listRemoteReadings(),
      [],
      'the pre-flight asks a runner about areas, and this declares none',
    );
    assert.equal(store.listValidationChecks('issue:12')[0]?.state, 'unrun');
    assert.equal(store.getRemoteRun(run.id)?.status, 'ended', 'and the run is still settled');
  } finally {
    b.close();
  }
});

/* ── what a finding does, and what it must never do ──────────────────────────────────────────── */

test('a failed row reaches rule validation-failed through the ordinary failed reading', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    await settle(b, runId, report(b, [{ selector: AREA, status: 'failed' }]));

    const ctx: DispatchContext = {
      world: { takenAt: '2026-09-08T12:00:00.000Z', pullRequests: [], issues: [issue()] },
      tasks: [],
      agents: [],
      openEscalations: [],
      queuedJobs: [],
      recentDecisions: [],
      agentHeadroom: 3,
      deliveries: [delivered()],
      validationChecks: b.sys.store.listValidationChecks('issue:12'),
    };
    const { actions } = await new RuleDispatcher({}, {}, undefined, 'main').decide(ctx);
    assert.equal(
      actions.some((a) => a.rule === 'validation-failed' && a.type === 'dispatch_code_agent'),
      true,
      'nothing new routes it — it is the ordinary failed reading',
    );
  } finally {
    b.close();
  }
});

test('a failed row is never a shortfall, never an issue verdict, never a WorldEvent', async () => {
  const b = bench();
  try {
    const { store } = b.sys;
    const runId = seed(b, [{ check: CHECK, area: AREA, matched: 1 }]);
    await b.sys.harness.runCycle('manual');
    const events = store.listWorldEvents(50).length;

    await settle(b, runId, report(b, [{ selector: AREA, status: 'failed' }]));
    await b.sys.harness.runCycle('manual');

    assert.equal(store.listWorldEvents(50).length, events, 'a reading written as one un-parks the goal it reported on');
    assert.deepEqual(store.listWatchReadings(), [], 'and a window’s evidence is on the window’s clock');
    assert.equal(store.getShortfall('issue:12'), null, 'a shortfall would clear the delivery row that parks the goal');
    assert.notEqual(store.getDelivery('issue:12'), null, 'so the goal stays delivered, and parked');
    assert.equal(
      store.getIssueConclusion('issue:12'),
      null,
      'the four verdict kinds are conclusion, delivery, shortfall and appraisal',
    );
    assert.equal(store.getAppraisal('issue:12'), null);

    const validate = store.listHumanTasksOfKind('validate').find((t) => t.originRef === 'issue:12');
    assert.ok(validate, 'the validate bench row is the one surface a reading moves');
    assert.notEqual(validate.status, 'declined', 'and it is not declined by a reading taken for it');
    const closeOut = store.listHumanTasksOfKind('close_out').find((t) => t.originRef === 'issue:12');
    assert.equal(closeOut?.status ?? 'open', 'open', 'the close-out obligation stays open');
  } finally {
    b.close();
  }
});

/* ── the reading vocabulary on the check ─────────────────────────────────────────────────────── */

test('rowToCheck narrows an unrecognised result_by to attributed to nobody, rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remote-resultby-'));
  const file = join(dir, 'harness.db');
  const store = new Store(file);
  try {
    store.ingestValidation('issue:12', { checks: [CHECK], resources: [], supersededReason: '', amendNote: '' });
    store.recordValidationResult('issue:12', CHECK.id, { state: 'passed', note: 'by hand', by: 'operator' });
  } finally {
    store.close();
  }

  const db = new Database(file);
  try {
    // `resultBy` gains `spec` with no migration: the column exists and only gains a value it may
    // hold. What that costs is a build meeting a word it does not know, which must read as
    // attributed to nobody rather than throw.
    db.prepare(`UPDATE validation_checks SET result_by='oracle' WHERE origin_ref=? AND id=?`).run('issue:12', CHECK.id);
  } finally {
    db.close();
  }

  const reopened = new Store(file);
  try {
    const check = reopened.listValidationChecks('issue:12')[0];
    assert.equal(check?.state, 'passed', 'the reading itself still reads');
    assert.equal(check?.resultBy, null, 'and nobody is credited with it');
  } finally {
    reopened.close();
  }
});

test('settling a run spawns nothing — the agent already invoked the project’s own command', () => {
  const b = bench();
  try {
    seed(b, [
      { check: CHECK, area: AREA, matched: 1 },
      { check: SECOND, area: OTHER_AREA, matched: 1 },
    ]);
    assert.deepEqual(b.runner.asked, [], 'asserted on the fake’s own record of what it was asked for');
  } finally {
    b.close();
  }
});

test('all confirmed rows in one invocation are folded row by row out of the one report', async () => {
  const b = bench();
  try {
    const runId = seed(b, [
      { check: CHECK, area: AREA, matched: 1 },
      { check: SECOND, area: OTHER_AREA, matched: 1 },
    ]);
    await settle(
      b,
      runId,
      report(b, [
        { selector: AREA, status: 'passed' },
        { selector: OTHER_AREA, status: 'failed' },
      ]),
    );

    assert.equal(reading(b, CHECK.id).outcome, 'passed');
    assert.equal(reading(b, SECOND.id).outcome, 'failed', 'one code could never have said both');
    const checks = b.sys.store.listValidationChecks('issue:12');
    assert.equal(checks.find((c) => c.id === CHECK.id)?.state, 'passed');
    assert.equal(checks.find((c) => c.id === SECOND.id)?.state, 'failed');
    for (const c of checks) assert.equal(c.resultBy, 'spec');
  } finally {
    b.close();
  }
});
