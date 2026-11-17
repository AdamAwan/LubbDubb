import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { remoteValidationRunDir } from '../src/validation/remote/origin.js';
import { RecordingRetentionDesk } from '../src/retention/recordingRetention.js';
import { localValidationOutputDir } from '../src/validation/local/origin.js';
import { validationGoalDir } from '../src/validation/resources.js';
import { commentSink } from './support/commentSink.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { IssueCommentInput, IssueImageInput, IssueImageResult } from '../src/sink/actionSink.js';
import type { ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * A remote run's video: kept out of the swept artefacts, named on the run, served by run id alone.
 *
 * → docs/spec/36-remote-validation.md#the-runs-recording
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
  proof: null,
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
  /** Every image the provider was asked to hold, as the desk handed it over. */
  attached: Array<{ number: number; fileName: string; bytes: number }>;
}

function bench(opts: { refuses?: string; attaches?: boolean | string } = {}): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-capture-'));
  const attached: Array<{ number: number; fileName: string; bytes: number }> = [];
  // `attaches` is three-valued on purpose, because the desk's three cases are: a provider with no
  // attachment API at all (undefined), one that holds the image (true), and one that fails while
  // trying (a message). The third is the one worth a test — a comment must still go up.
  const image =
    opts.attaches === undefined
      ? {}
      : {
          canAttachIssueImage: () => true,
          attachIssueImage: async (input: IssueImageInput): Promise<IssueImageResult> => {
            if (typeof opts.attaches === 'string') throw new Error(opts.attaches);
            attached.push({ number: input.number, fileName: input.fileName, bytes: input.bytes.length });
            return { ok: true, url: `https://ado.test/_apis/wit/attachments/att-1?fileName=${input.fileName}` };
          },
        };
  const sink = commentSink({
    ...image,
    ...(opts.refuses === undefined
      ? {}
      : { upsertIssueComment: (): Promise<never> => Promise.reject(new Error(opts.refuses)) }),
  });
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
  return { system, dir, runId: run.id, comments: sink.comments, attached };
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

const VIDEO = Buffer.from('not really a video');

function artefactsOf(b: Bench): string {
  return join(remoteValidationRunDir(b.system.config.validationRoot, GOAL, b.runId), 'artefacts');
}

test('a settled run keeps the newest video it recorded, under a name the harness composed', async () => {
  const b = bench();
  writeFileSync(join(artefactsOf(b), 'video-2026-11-16T10-00-00.webm'), 'older');
  writeFileSync(join(artefactsOf(b), 'video-2026-11-16T10-05-00.webm'), VIDEO);
  await settle(b);

  const run = b.system.store.remoteValidation.getRemoteRun(b.runId);
  assert.equal(run?.recording, `recording-${b.runId}.webm`);
  assert.equal(run?.recordingStatus, 'kept');

  const state = buildStateSnapshot(b.system, { remoteRecordingSigner: (runId) => `tok-${runId}` });
  assert.equal(state.remoteSheets[0]?.run?.recordingUrl, `/validation-captures/recording/${b.runId}?tk=tok-${b.runId}`);

  const { app } = await buildApp(b.system);
  const served = await app.inject({ method: 'GET', url: `/validation-captures/recording/${b.runId}` });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'video/webm');
  assert.deepEqual(served.rawPayload, VIDEO, 'the newest recording, out of the goal’s own directory');
  await app.close();
  close(b);
});

test('a run that recorded nothing has no recording, and the route says so', async () => {
  const b = bench();
  await settle(b);

  assert.equal(b.system.store.remoteValidation.getRemoteRun(b.runId)?.recording, null);
  assert.equal(
    b.system.store.remoteValidation.getRemoteRun(b.runId)?.recordingStatus,
    'missing',
    'the default browser offers the recorder, so no video is a recording that went missing',
  );
  const state = buildStateSnapshot(b.system, { remoteRecordingSigner: (runId) => `tok-${runId}` });
  assert.equal(state.remoteSheets[0]?.run?.recordingUrl, null);

  const { app } = await buildApp(b.system);
  const served = await app.inject({ method: 'GET', url: `/validation-captures/recording/${b.runId}` });
  assert.equal(served.statusCode, 404);
  await app.close();
  close(b);
});

test('a run whose browser offers no recorder reads as not offered, never as missing', async () => {
  const b = bench();
  b.system.config.localValidation = { ...b.system.config.localValidation, browser: null };
  await settle(b);

  assert.equal(b.system.store.remoteValidation.getRemoteRun(b.runId)?.recordingStatus, 'not_offered');
  close(b);
});

test('a recording can be fetched a byte range at a time, so a player can seek', async () => {
  const b = bench();
  writeFileSync(join(artefactsOf(b), 'video-1.webm'), VIDEO);
  await settle(b);
  const { app } = await buildApp(b.system);
  const url = `/validation-captures/recording/${b.runId}`;

  const part = await app.inject({ method: 'GET', url, headers: { range: 'bytes=4-9' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 4-9/${String(VIDEO.length)}`);
  assert.deepEqual(part.rawPayload, VIDEO.subarray(4, 10));

  const whole = await app.inject({ method: 'GET', url });
  assert.equal(whole.headers['accept-ranges'], 'bytes', 'a player is told it may ask for ranges');

  const past = await app.inject({ method: 'GET', url, headers: { range: 'bytes=999-' } });
  assert.equal(past.statusCode, 416);
  await app.close();
  close(b);
});

test('videos older than the retention window are deleted, and nothing else is', async () => {
  const b = bench();
  const { store, config } = b.system;
  writeFileSync(join(artefactsOf(b), 'video-1.webm'), VIDEO);
  await settle(b);
  const kept = join(validationGoalDir(config.validationRoot, GOAL), `recording-${b.runId}.webm`);
  assert.ok(existsSync(kept));

  const local = store.localValidations.createLocalValidation({
    originRef: GOAL,
    runId: 'lr1',
    ref: 'main',
    commit: null,
  });
  const dir = localValidationOutputDir(config.validationRoot, GOAL, local.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'shot.png'), PIXEL);
  writeFileSync(join(dir, 'video-1.webm'), VIDEO);
  store.localValidations.recordLocalValidationReport(local.id, {
    status: 'passed',
    summary: 'it worked',
    findings: [],
    visited: [],
    screenshots: ['shot.png', 'video-1.webm'],
    note: null,
    recordingStatus: 'kept',
  });

  const desk = (days: number, ahead: number): RecordingRetentionDesk =>
    new RecordingRetentionDesk({
      store,
      validationRoot: config.validationRoot,
      retentionDays: days,
      errors: b.system.errors,
      now: () => Date.now() + ahead * 86_400_000,
    });

  assert.equal(desk(14, 1).sweep(), 0, 'nothing is old enough yet');
  assert.equal(desk(0, 30).sweep(), 0, '0 keeps every video');
  assert.equal(desk(14, 15).sweep(), 2);

  assert.ok(!existsSync(kept), 'the remote recording is gone');
  assert.equal(store.remoteValidation.getRemoteRun(b.runId)?.recording, null, 'and the run no longer names it');
  assert.ok(!existsSync(join(dir, 'video-1.webm')), 'the local video is gone');
  assert.ok(existsSync(join(dir, 'shot.png')), 'screenshots stay');
  assert.deepEqual(store.localValidations.getLocalValidation(local.id)?.screenshots, ['shot.png']);
  close(b);
});
