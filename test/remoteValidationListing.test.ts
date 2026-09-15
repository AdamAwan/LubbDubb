import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { REMOTE_VALIDATION_COLUMNS } from '../src/store/remoteValidation.js';
import { RemoteListingDesk } from '../src/remoteValidation/listing.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { MCP_TOOL_NAMES, TOOL_NAMING, toolsForRule } from '../src/mcp/names.js';
import { buildTools } from '../src/mcp/tools.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Agent, RemoteSheetRow, ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * The run's own selector listing: taken by the run agent in its pinned checkout, handed back as a
 * **path**, and the one thing that writes `matched`.
 * → docs/spec/36-remote-validation.md#the-report-is-the-only-source-of-row-outcomes
 *
 * Two things are pinned here above all others. The tool has **no field naming a selector and no
 * count**, so a denominator can never come off what an agent said — a path says where a file is and
 * not what is in it, which is the whole of why this may come through an agent at all. And every arm
 * the listing blocks writes a **`blocked` reading**, never the row's `blockedReason`: a reason on
 * the row is a cause no press can overcome, so an amendable mismatch written there would leave the
 * row permanently unpressable, with an operator who reworded the area and still cannot press it.
 *
 * Every system here injects `FakeStateReader`, `FakeTenantKeeper`, `FakeEnvironmentProber` and
 * `FakeWorktreeManager`: the defaults are the command implementations and the real worktree manager,
 * so a test that configures a `validate` block and injects none of them queries somebody's environment
 * out of a lease cut in your own checkout — and passes while doing it. There is no browser fake to
 * inject: the harness spawns none of the three browser commands, the run agent invokes all of them. The listing's own `read` seam is injected for the
 * same reason one step in: no test lays a listing file on disk.
 */

const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const AREA = 'checkout with a saved card';
const OTHER_AREA = 'the order history';
const NOW = '2026-09-09T09:00:00.000Z';

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
const EXPECTED_SPEC = 'checkout/gift-cards.spec.ts';

interface Bench {
  sys: System;
  dir: string;
  file: string;
  close(): void;
}

/** File-backed, because a check's area is written onto the column the way whatever declares it will. */
function bench(): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remote-listing-'));
  const file = join(dir, 'harness.db');
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
      environments: [ACCEPTANCE],
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
  return { sys, dir, file, close: () => sys.store.close() };
}

/**
 * An area and the spec names it is expected to run, where both of them live: one `suite` step of the
 * check's own test plan. Neither is a column any longer — the row still holds the two it was given
 * before this and nothing reads them — so a test writing those columns would set up a check that
 * declares no area at all and pass on the silence.
 */
function setArea(file: string, checkId: string, area: string, expects: string[] | null = null): void {
  const db = new Database(file);
  const step: ValidationStep = {
    kind: 'suite',
    do: `Run the ${area} area of the project’s own suite.`,
    area,
    expects,
    when: 'inline',
    script: null,
    scriptSweptAt: null,
    actor: 'fleet',
    why: null,
  };
  try {
    db.prepare(`UPDATE validation_checks SET steps=? WHERE origin_ref=? AND id=?`).run(
      JSON.stringify([step]),
      'issue:12',
      checkId,
    );
  } finally {
    db.close();
  }
}

/**
 * A delivered, landed and sheeted goal with one confirmed `check` row and an open run. `matched` is
 * null on the row, which now means **the listing has not been taken for this row yet** — the state
 * every run starts in rather than a theoretical one.
 */
function seed(b: Bench, checks: { check: ValidationCheckInput; area: string; expects?: string[] }[]): string {
  const { store } = b.sys;
  store.validation.ingestValidation('issue:12', {
    checks: checks.map((c) => c.check),
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
  store.remoteValidation.saveRemoteSheetRows(
    'issue:12',
    'acceptance',
    checks.map((c, at) => ({
      rowId: `check:${c.check.id}`,
      kind: 'check' as const,
      seq: at + 1,
      title: c.check.title,
      sourceId: c.check.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
      idleReason: null,
    })),
  );
  for (const c of checks) setArea(b.file, c.check.id, c.area, c.expects ?? null);
  const { run } = store.remoteValidation.beginRemoteRun({
    goalRef: 'issue:12',
    environment: 'acceptance',
    tenant: 'validation-customer-1',
    startedSha: DEPLOYED,
  });
  assert.ok(run, 'the press opened a run');
  return run.id;
}

/** The desk with its `read` seam injected, so the listing never reaches a file on disk. */
function listings(b: Bench, text: string | Error): RemoteListingDesk {
  return new RemoteListingDesk({
    store: b.sys.store,
    read: async () => {
      if (text instanceof Error) throw text;
      return text;
    },
  });
}

/** A listing in the shape a runner that counts prints it: an area, and how many tests it holds. */
function offers(entries: { selector: string; tests: number }[]): string {
  return JSON.stringify(entries);
}

function row(b: Bench, checkId: string): RemoteSheetRow {
  const found = b.sys.store.remoteValidation.listRemoteSheetRows().find((r) => r.rowId === `check:${checkId}`);
  assert.ok(found, `the sheet holds a row for ${checkId}`);
  return found;
}

function report(b: Bench, tests: { selector: string; status: string }[], name = 'results.json'): string {
  const path = join(b.dir, name);
  writeFileSync(path, JSON.stringify(tests), 'utf8');
  return path;
}

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function agentOn(sys: System, originRef: string, branch: string): Agent {
  const task = sys.store.tasks.createTask({
    kind: 'code',
    title: 'Run the sheet',
    prompt: 'run it',
    branch,
    originRef,
    originTitle: 'Ship the channel',
  });
  return sys.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

/* ── the origin fence ────────────────────────────────────────────────────────────────────────── */

test('every other caller is refused the listing by name, and none of them writes a denominator', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);

    for (const [origin, branch] of [
      ['issue:12', 'issue/12'],
      ['issue:12:part:schema', 'issue/12/schema'],
      ['issue:12:plan', 'issue/12/plan'],
      ['issue:12:validate:an-order-places', 'validate/issue/12/an-order-places'],
      ['issue:12:validate-failure:an-order-places', 'validate-failure/issue/12/an-order-places'],
      ['issue:12:validate-local:abc', 'validate-local/issue/12/abc'],
    ] as const) {
      const other = agentOn(b.sys, origin, branch);
      const refused = (await b.sys.mcp
        .session(other.id)!
        .call('remote_validation_listing', { listingPath: '/tmp/listing.txt' })) as ToolResultText;
      assert.equal(refused.isError, true, `${origin} is refused`);
      assert.match(
        refused.content[0]?.text ?? '',
        /issue:<n>:validate-remote:<runId>/,
        'which run a listing belongs to is settled before the listing, never by it',
      );
    }

    assert.equal(row(b, CHECK.id).matched, null, 'no denominator came off an agent that was not sent on this run');
    assert.equal(b.sys.store.remoteValidation.getRemoteRun(runId)?.listingPath, null);
    assert.deepEqual(b.sys.store.remoteValidation.listRemoteReadings(), [], 'and nothing was read against one');
  } finally {
    b.close();
  }
});

/* ── the schema states nothing about selectors ───────────────────────────────────────────────── */

test('the advertised schema has no field naming a selector and none holding a count', () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    const agent = agentOn(b.sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
    const task = b.sys.store.tasks.getTask(agent.taskId)!;
    const tool = buildTools({ store: b.sys.store, agents: b.sys.agents }, { agent, task }).find(
      (t) => t.name === 'remote_validation_listing',
    );
    assert.ok(tool, 'the tool is built, so the name and the module agree');
    const schema = tool.inputSchema as Record<string, unknown>;

    assert.deepEqual(
      Object.keys((schema['properties'] ?? {}) as Record<string, unknown>).sort(),
      ['blocked', 'listingPath'],
      'where the runner’s own output landed, or why there is none — and nothing else. A field naming a ' +
        'selector or holding a count is a denominator an agent stated',
    );
    assert.equal(schema['additionalProperties'], false, 'and an extra key is rejected rather than ignored');
    assert.equal(MCP_TOOL_NAMES.includes('remote_validation_listing'), true);
    assert.equal(TOOL_NAMING['remote_validation_listing'], 'point-of-use');
    assert.equal(
      toolsForRule('remote-validation').has('remote_validation_listing'),
      true,
      'an unplaced tool is granted, built and callable but in no agent’s tools/list',
    );
  } finally {
    b.close();
  }
});

for (const [what, extra] of [
  ['a selector name', { selectors: [AREA] }],
  ['a count', { matched: 7 }],
  ['a summary of what it held', { offers: `${AREA} (7 tests)` }],
] as const) {
  test(`a call carrying ${what} beside the path is refused, so no denominator can come off the call`, async () => {
    const b = bench();
    try {
      const runId = seed(b, [{ check: CHECK, area: AREA }]);
      const agent = agentOn(b.sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
      const refused = (await b.sys.mcp.session(agent.id)!.call('remote_validation_listing', {
        listingPath: `/srv/validation/issue-12/remote/${runId}/listing/selectors.txt`,
        ...extra,
      })) as ToolResultText;

      assert.equal(refused.isError, true, `${what} is not the agent’s to state`);
      assert.equal(row(b, CHECK.id).matched, null, 'and the refusal wrote nothing — not even the path it did carry');
      assert.equal(b.sys.store.remoteValidation.getRemoteRun(runId)?.listingPath, null);
    } finally {
      b.close();
    }
  });
}

/* ── what a listing writes ───────────────────────────────────────────────────────────────────── */

test('a listing that offers the area writes matched and answers with that selector and no other', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    const path = `/srv/validation/issue-12/remote/${runId}/listing/selectors.json`;
    const taken = await listings(
      b,
      offers([
        { selector: AREA, tests: 3 },
        { selector: OTHER_AREA, tests: 9 },
      ]),
    ).take(runId, path);

    assert.equal(taken.ok, true, taken.ok ? '' : taken.error);
    assert.ok(taken.ok);
    assert.deepEqual(
      taken.selectors,
      [AREA],
      'the agent invokes the runner with the selectors that survived and with nothing else — an area ' +
        'this sheet names no row against is not one of them',
    );
    assert.equal(taken.blocked, 0);
    assert.equal(
      row(b, CHECK.id).matched,
      3,
      'the denominator is parsed out of the runner’s own output, which is what the path buys',
    );
    assert.equal(row(b, CHECK.id).blockedReason, null);
    assert.deepEqual(b.sys.store.remoteValidation.listRemoteReadings(), [], 'a listing that answered reads nothing');
    assert.equal(b.sys.store.remoteValidation.getRemoteRun(runId)?.listingPath, path, 'and the path is on the run');
    assert.equal(
      b.sys.store.remoteValidation.getRemoteRun(runId)?.status,
      'pending',
      'the listing does not end the run — remote_validation_report still settles it',
    );
  } finally {
    b.close();
  }
});

test('a listing that does not offer the area writes a blocked reading and never a blockedReason', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    const taken = await listings(b, offers([{ selector: OTHER_AREA, tests: 9 }])).take(runId, '/srv/listing.json');

    assert.ok(taken.ok);
    assert.equal(taken.blocked, 1);
    assert.deepEqual(taken.selectors, [], 'there is nothing left for the agent to invoke the runner with');

    const readings = b.sys.store.remoteValidation.listRemoteReadings();
    assert.equal(readings.length, 1, 'the reason reaches the operator as a reading against this run');
    assert.equal(readings[0]?.outcome, 'blocked');
    assert.equal(readings[0]?.rowId, `check:${CHECK.id}`);
    assert.equal(readings[0]?.runId, runId);
    assert.match(readings[0]?.detail ?? '', new RegExp(`offers no selector \`${AREA}\``));

    assert.equal(
      row(b, CHECK.id).blockedReason,
      null,
      'a blockedReason is a cause no press can overcome, and a renamed area is amendable — written ' +
        'there, an operator who rewords the area could never press the row again',
    );
    assert.equal(row(b, CHECK.id).selected, true, 'so the row is still confirmed and still pressable');
    assert.equal(row(b, CHECK.id).matched, 0, 'and what the listing did attribute to it is on the row');
  } finally {
    b.close();
  }
});

test('a listing nobody could take reads as unlistable, and leaves every row pressable', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    const taken = listings(b, '').blocked(runId, 'the install failed and the runner never started');

    assert.ok(taken.ok);
    assert.equal(taken.blocked, 1);
    const readings = b.sys.store.remoteValidation.listRemoteReadings();
    assert.equal(readings[0]?.outcome, 'blocked');
    assert.match(readings[0]?.detail ?? '', /could not say which selectors it offers/, 'the unlistable arm');
    assert.match(readings[0]?.detail ?? '', /the install failed/, 'carrying the agent’s own reason to the operator');
    assert.equal(
      readings[0]?.rows,
      null,
      'an unanswered listing counts nothing, rather than reading as a runner that offers nothing',
    );

    assert.equal(row(b, CHECK.id).matched, null, 'null is still "the listing has not been taken for this row"');
    assert.equal(
      row(b, CHECK.id).blockedReason,
      null,
      'and an install that failed is the most amendable cause there is',
    );
    assert.equal(
      b.sys.store.remoteValidation.getRemoteRun(runId)?.listingPath,
      null,
      'there is no file to point at, and a run may still owe a script or a screen',
    );
    assert.equal(b.sys.store.remoteValidation.getRemoteRun(runId)?.status, 'pending', 'so the run is left open');
  } finally {
    b.close();
  }
});

test('a listing file that cannot be opened records nothing at all, and says how to answer instead', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    const taken = await listings(b, new Error('ENOENT: no such file or directory')).take(runId, '/srv/listing.json');

    assert.equal(taken.ok, false);
    assert.ok(!taken.ok);
    assert.match(taken.error, /could not be opened/);
    assert.match(taken.error, /"blocked"/, 'the refusal names the other answer, rather than leaving a dead end');

    assert.deepEqual(b.sys.store.remoteValidation.listRemoteReadings(), [], 'nothing was recorded');
    assert.equal(row(b, CHECK.id).matched, null, 'and every row is exactly as it was');
    assert.equal(row(b, CHECK.id).blockedReason, null, 'so a second call with a path that opens still takes it');
    assert.equal(b.sys.store.remoteValidation.getRemoteRun(runId)?.listingPath, null);
  } finally {
    b.close();
  }
});

test('an unanswerable listing reaches the tool’s own blocked arm, and the run stays open for what else it owes', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    const agent = agentOn(b.sys, `issue:12:validate-remote:${runId}`, `validate-remote/issue/12/${runId}`);
    const answered = (await b.sys.mcp.session(agent.id)!.call('remote_validation_listing', {
      blocked: 'the acceptance environment refused every login, so the runner could not be asked',
    })) as ToolResultText;

    assert.equal(answered.isError, undefined, answered.content[0]?.text ?? '');
    const readings = b.sys.store.remoteValidation.listRemoteReadings();
    assert.equal(readings[0]?.outcome, 'blocked');
    assert.match(readings[0]?.detail ?? '', /refused every login/);
    assert.equal(row(b, CHECK.id).blockedReason, null, 'a login that failed is not a cause no press can overcome');
    assert.equal(
      b.sys.store.remoteValidation.getRemoteRun(runId)?.status,
      'pending',
      'a listing never ends a run: one may still owe a one-off script or a screen, and the report settles it',
    );
  } finally {
    b.close();
  }
});

/* ── matched null, now that it is reachable ──────────────────────────────────────────────────── */

test('a report arriving with no listing taken blocks every spec row, naming the step that was never taken', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA }]);
    assert.equal(row(b, CHECK.id).matched, null, 'nothing took the listing for this run');

    const settled = await b.sys.remoteReadings.settle(runId, {
      reportPath: report(b, [
        { selector: AREA, status: 'passed' },
        { selector: AREA, status: 'passed' },
      ]),
      artefacts: null,
    });
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error);
    assert.ok(settled.ok);
    assert.equal(settled.blocked, 1);
    assert.equal(settled.read, 0);

    const reading = b.sys.store.remoteValidation.listRemoteReadings().at(-1);
    assert.equal(reading?.outcome, 'blocked', 'a row with no denominator is never read as a clean pass');
    assert.match(reading?.detail ?? '', /no listing attributes a test to/);
    assert.match(
      reading?.detail ?? '',
      /listing step was never taken/,
      'and the reason names the missing step, which is the thing an operator acts on',
    );
    assert.equal(
      b.sys.store.validation.listValidationChecks('issue:12')[0]?.state,
      'unrun',
      'a blocked row writes nothing on the check',
    );
  } finally {
    b.close();
  }
});

/* ── the no-overwrite guard ──────────────────────────────────────────────────────────────────── */

test('a row the listing blocked is never folded green by a later report that names tests under its area', async () => {
  const b = bench();
  try {
    const runId = seed(b, [{ check: CHECK, area: AREA, expects: [EXPECTED_SPEC] }]);
    // The area is offered and holds three tests; the spec this check wrote down is not offered. That
    // is the one arm where a later report of three passes under the same area would fold to `passed`
    // on `area` alone — which is the agent's own choice of selectors reaching a verdict.
    const taken = await listings(b, offers([{ selector: AREA, tests: 3 }])).take(runId, '/srv/listing.json');
    assert.ok(taken.ok);
    assert.equal(taken.blocked, 1);
    assert.equal(row(b, CHECK.id).matched, 3, 'so the counts alone would never have said so');

    const settled = await b.sys.remoteReadings.settle(runId, {
      reportPath: report(b, [
        { selector: AREA, status: 'passed' },
        { selector: AREA, status: 'passed' },
        { selector: AREA, status: 'passed' },
      ]),
      artefacts: null,
    });
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error);
    assert.ok(settled.ok);
    assert.equal(settled.read, 0, 'the report answered for no row this listing had already blocked');
    assert.equal(settled.blocked, 1);
    assert.equal(settled.wrote, 0);

    const readings = b.sys.store.remoteValidation.listRemoteReadings();
    assert.equal(readings.length, 1, 'the block the listing wrote is the row’s only reading');
    assert.equal(readings[0]?.outcome, 'blocked');
    assert.match(readings[0]?.detail ?? '', /`checkout\/gift-cards\.spec\.ts`/, 'and it still names the missing spec');
    assert.equal(
      b.sys.store.validation.listValidationChecks('issue:12')[0]?.state,
      'unrun',
      'nothing is written on the check — a pass on what remains is a pass for coverage that is gone',
    );
    assert.equal(b.sys.store.remoteValidation.getRemoteRun(runId)?.status, 'ended', 'and the run still settles');
  } finally {
    b.close();
  }
});

/* ── the column ──────────────────────────────────────────────────────────────────────────────── */

/** A database written before `listing_path` existed: the schema as it ships, with one run row in it. */
function beforeTheColumn(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-listing-path-')), 'old.db');
  const db = new Database(path);
  db.exec(SCHEMA);
  const columns = (db.prepare(`PRAGMA table_info(remote_runs)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(
    !columns.includes('listing_path'),
    'the fixture really is a database from before the column — CREATE TABLE IF NOT EXISTS never alters one',
  );
  db.prepare(
    `INSERT INTO remote_runs (id, goal_ref, environment, tenant, status, started_sha, started_at, task_id,
       report_path, artefacts)
     VALUES ('run-9f2c', 'issue:12', 'acceptance', 'validation-customer-1', 'ended', ?, ?, 't1',
       '/srv/report/results.json', 'https://reports.example.com/run/9f2c')`,
  ).run(DEPLOYED, NOW);
  db.close();
  return path;
}

test('remote_runs.listing_path is declared in REMOTE_VALIDATION_COLUMNS, so a database from before it gains it on boot', () => {
  assert.equal(
    REMOTE_VALIDATION_COLUMNS.remote_runs?.listing_path,
    'TEXT',
    'a column without an entry here is invisible on every database written before it existed',
  );

  const path = beforeTheColumn();
  const store = new Store(path);
  const run = store.remoteValidation.getRemoteRun('run-9f2c');
  assert.equal(run?.listingPath, null, 'null means no listing was reported on this run, which is true of every one');
  assert.equal(run?.reportPath, '/srv/report/results.json', 'and nothing else on the row moved');
  assert.equal(run?.artefacts, 'https://reports.example.com/run/9f2c');
  assert.equal(run?.status, 'ended');
  assert.equal(run?.taskId, 't1');
  store.close();

  const inspect = new Database(path);
  const names = (inspect.prepare(`PRAGMA table_info(remote_runs)`).all() as { name: string }[]).map((c) => c.name);
  inspect.close();
  assert.ok(names.includes('listing_path'), 'the additive ALTER TABLE ran');
});

test('no backfill runs over listing_path, and no runOnce id came back with it', () => {
  const path = beforeTheColumn();
  new Store(path).close();

  const inspect = new Database(path);
  const stored = inspect.prepare(`SELECT id, listing_path, started_at, report_path FROM remote_runs`).all() as {
    id: string;
    listing_path: string | null;
    started_at: string;
    report_path: string | null;
  }[];
  inspect.close();
  assert.deepEqual(
    stored,
    [{ id: 'run-9f2c', listing_path: null, started_at: NOW, report_path: '/srv/report/results.json' }],
    'no row was rewritten — there is nothing to compute a listing path from and nothing right to invent',
  );

  const source = readFileSync('src/store/store.ts', 'utf8');
  assert.ok(!/listing_path/.test(source), 'nothing in the boot sequence is gated on the column having been added');
  assert.ok(!/runOnce/.test(source), 'and no one-shot id came back with it');
});
