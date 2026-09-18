import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { remoteValidationRunDir } from '../src/remoteValidation/origin.js';
import { captureComment, postableCaptures } from '../src/remoteValidation/capturePost.js';
import { commentSink } from './support/commentSink.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { IssueCommentInput } from '../src/sink/actionSink.js';
import type { RemoteReading, ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * Where a capture kept on the **sheet** is looked at, and how it reaches somebody who never opens the
 * cockpit. A run declines to overwrite a check somebody else settled — a reading somebody took is
 * theirs — and until the reading carried the file name itself that decline also hid the screen: the
 * only URL anything could build came off the check row.
 *
 * → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at
 * → docs/spec/36-remote-validation.md#posting-the-screen-to-the-ticket
 */

const GOAL = 'issue:12';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';
const ROW = 'check:confirmation-reads';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: {
    permits: ['check'],
    tenant: 'validation-customer-1',
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' },
  },
};

const SCREEN_STEP: ValidationStep = {
  kind: 'screenshot',
  do: 'Capture the confirmation screen',
  area: null,
  expects: null,
  when: 'inline',
  script: null,
  scriptSweptAt: null,
  actor: 'fleet',
  why: null,
};

const CHECK: ValidationCheckInput = {
  id: 'confirmation-reads',
  seq: 1,
  title: 'The confirmation screen reads legibly at 1280',
  do: 'Place an order and stop at the confirmation',
  expect: 'A person can read it',
  uses: [],
  covers: [],
  fleetCandidate: false,
  candidateWhy: null,
  steps: [SCREEN_STEP],
};

/** A one-pixel PNG. The route serves bytes, so the bench lays real ones down. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Bench {
  system: System;
  dir: string;
  runId: string;
  comments: IssueCommentInput[];
}

function bench(opts: { refuses?: string } = {}): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-capture-'));
  const recorder = commentSink();
  const sink =
    opts.refuses === undefined
      ? recorder
      : {
          ...recorder,
          upsertIssueComment: (): Promise<never> => Promise.reject(new Error(opts.refuses)),
        };
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
      sink,
      stateReader: new FakeStateReader({}),
      tenants: new FakeTenantKeeper(),
      environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver(),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
  const { store, config } = system;
  store.validation.ingestValidation(GOAL, { checks: [CHECK], resources: [], supersededReason: '', amendNote: '' });
  store.remoteValidation.openRemoteSheet({ goalRef: GOAL, environment: 'acceptance' });
  store.remoteValidation.saveRemoteSheetRows(GOAL, 'acceptance', [
    {
      rowId: ROW,
      kind: 'check',
      seq: 1,
      title: CHECK.title,
      sourceId: CHECK.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
      idleReason: null,
    },
  ]);
  const { run } = store.remoteValidation.beginRemoteRun({
    goalRef: GOAL,
    environment: 'acceptance',
    tenant: 'validation-customer-1',
    startedSha: DEPLOYED,
  });
  assert.ok(run !== null, 'nothing else holds this environment and tenant');
  // The screen the agent wrote into the run's own artefacts, which the desk moves out of them.
  const artefacts = join(remoteValidationRunDir(config.validationRoot, GOAL, run.id), 'artefacts');
  mkdirSync(artefacts, { recursive: true });
  writeFileSync(join(artefacts, 'confirmation.png'), PIXEL);
  return { system, dir, runId: run.id, comments: recorder.comments };
}

function report(dir: string, rows: unknown[]): string {
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(rows));
  return path;
}

function close(b: Bench): void {
  b.system.store.close();
  rmSync(b.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function settle(b: Bench): Promise<void> {
  const settled = await b.system.remoteReadings.settle(b.runId, {
    reportPath: report(b.dir, [{ selector: CHECK.id, status: 'skipped', capture: 'confirmation.png' }]),
    artefacts: null,
  });
  assert.ok(settled.ok, 'ok' in settled ? '' : String(settled));
}

// ------------------------------------------ the reading holds the capture, whoever holds the check

test('a run that will not overwrite a settled check still names the screen on its own reading', async () => {
  const b = bench();
  // Somebody looked at this check already, so the run must leave their reading alone — and used to
  // throw the image away with it, because `validation_checks.capture` was the only column anything
  // could build a URL from.
  b.system.store.validation.recordValidationResult(GOAL, CHECK.id, {
    state: 'passed',
    note: 'I watched it happen.',
    by: 'operator',
  });
  await settle(b);

  const check = b.system.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(check?.state, 'passed', 'a reading somebody took is theirs');
  assert.equal(check?.resultBy, 'operator');
  assert.equal(check?.capture, null, 'and nothing writes an image onto their row');

  const reading = b.system.store.remoteValidation.listRemoteReadings().find((r) => r.rowId === ROW);
  assert.equal(reading?.outcome, 'captured');
  assert.match(reading?.capture ?? '', /^capture-/, 'the row that kept the screen names it');
  assert.doesNotMatch(reading?.capture ?? '', /[\\/]/, 'a capture is a file name, never a path');
  assert.match(reading?.detail ?? '', /keeps this one instead/, 'and says whose reading it is not replacing');
  close(b);
});

test('the sheet row carries its own capture URL, keyed on the run and the row', async () => {
  const b = bench();
  await settle(b);
  const state = buildStateSnapshot(b.system, { remoteCaptureSigner: (runId, rowId) => `tok-${runId}-${rowId}` });
  const row = state.remoteSheets[0]?.rows.find((r) => r.rowId === ROW);
  assert.ok(row?.reading?.captureUrl != null, 'the row that holds the screen is the row that links to it');
  assert.match(
    row.reading.captureUrl,
    new RegExp(`^/validation-captures/run/${b.runId}/${encodeURIComponent(ROW)}\\?tk=`),
    'never the check route — that key belongs to whoever settled the check',
  );
  close(b);
});

test('the capture route serves the sheet-kept screen, and 404s for a row that handed none back', async () => {
  const b = bench();
  await settle(b);
  const { app } = await buildApp(b.system);
  const served = await app.inject({
    method: 'GET',
    url: `/validation-captures/run/${b.runId}/${encodeURIComponent(ROW)}`,
  });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.deepEqual(served.rawPayload, PIXEL, 'the bytes the agent handed back, out of the goal’s own directory');

  const missing = await app.inject({
    method: 'GET',
    url: `/validation-captures/run/${b.runId}/${encodeURIComponent('check:nothing-here')}`,
  });
  assert.equal(missing.statusCode, 404, 'a row with no reading names no file, so there is nothing to serve');
  await app.close();
  close(b);
});

// ---------------------------------------------------------------- and onto the ticket, exactly once

test('a captured screen is posted to the goal’s ticket once, and never a second time on a re-read', async () => {
  const b = bench();
  await settle(b);

  await b.system.remoteValidation.run();
  assert.equal(b.comments.length, 1, 'the person who never opens the cockpit is told a screen is waiting');
  const posted = b.comments[0];
  assert.equal(posted?.number, 12);
  assert.equal(posted?.commentRef, null);
  assert.match(posted?.body ?? '', /A screen was captured on `acceptance`/);
  assert.match(posted?.body ?? '', /confirmation screen reads legibly/, 'it names the check, not just the row id');
  assert.match(posted?.body ?? '', /a person judges that/, 'and states that nothing here judges the screen');

  await b.system.remoteValidation.run();
  assert.equal(b.comments.length, 1, 'a screen posted twice on a re-read is worse than one never posted');

  assert.deepEqual(
    b.system.store.remoteValidation.listPostedCaptures().map((r) => [r.runId, r.rowId]),
    [[b.runId, ROW]],
    'the record is the idempotence — nothing about a tracker comment can be read back',
  );

  // The same trap as an arrival's and a sheet reading's: a world event matching the goal's issue ref
  // expires its standing delivery verdict, so a posting written as one hands delivered work back.
  assert.deepEqual(
    b.system.store.world.listWorldEvents().filter((e) => e.ref === GOAL),
    [],
    'a posting is never a WorldEvent',
  );
  close(b);
});

test('a posting the tracker refused is not recorded, so the next pulse is the retry', async () => {
  const b = bench({ refuses: 'the tracker was unreachable' });
  await settle(b);
  await b.system.remoteValidation.run();
  assert.deepEqual(
    b.system.store.remoteValidation.listPostedCaptures(),
    [],
    'a posting recorded before it went is a screen nobody will ever be told about',
  );
  assert.match(
    b.system.store.errors
      .listErrors(10)
      .map((e) => e.message)
      .join('\n'),
    /posting the screen captured for check:confirmation-reads/,
    'and the failure is recorded rather than swallowed',
  );
  close(b);
});

// --------------------------------------------------------------------------- the fold, on its own

const CAPTURED: RemoteReading = {
  goalRef: GOAL,
  environment: 'acceptance',
  rowId: ROW,
  runId: 'run-1',
  outcome: 'captured',
  rows: null,
  value: null,
  detail: null,
  startedSha: null,
  endedSha: null,
  executed: null,
  retries: null,
  durationMs: null,
  artefacts: null,
  capture: 'capture-confirmation-reads-run-1.png',
  readAt: '2026-09-10T12:00:00.000Z',
};

const DETERMINISTIC: RemoteReading = {
  ...CAPTURED,
  rowId: 'state:no-orphans',
  runId: null,
  outcome: 'passed',
  capture: null,
};

test('only a run’s reading with a screen is postable, and the link is optional', () => {
  const readings = [CAPTURED, DETERMINISTIC];
  const postable = postableCaptures({ readings, rows: [], posted: [] });
  assert.deepEqual(
    postable.map((p) => p.rowId),
    [ROW],
    'a query hands nothing back to look at, and a reading no run took can hand none back',
  );

  assert.deepEqual(
    postableCaptures({
      readings,
      rows: [],
      posted: [{ runId: 'run-1', rowId: ROW, goalRef: GOAL, capture: 'x.png', postedAt: 'then' }],
    }),
    [],
    'and one already posted is never offered again',
  );

  const linkless = captureComment({ ...postable[0]!, title: null, url: null });
  assert.match(linkless, /capture-confirmation-reads-run-1\.png/, 'a deployment with no address still names it');
  assert.doesNotMatch(linkless, /\]\(http/, 'and posts no link it cannot honour');

  const linked = captureComment({ ...postable[0]!, title: 'The confirmation screen', url: 'https://harness/x?tk=1' });
  assert.match(linked, /\[Open the screen\]\(https:\/\/harness\/x\?tk=1\)/);
  assert.match(linked, /capture-confirmation-reads-run-1\.png/, 'the prose is what it really carries');
});
