import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { FakeTenantKeeper } from '../src/validation/remote/fakeTenantKeeper.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { remoteValidationRunDir } from '../src/validation/remote/origin.js';
import { demandsProof, validateReport } from '../src/validation/report.js';
import { checkBriefing } from '../src/validation/fleet.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { ValidationCheck, ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * `proof` — what a check's author says has to come **back** for a pass to count.
 *
 * A check the fleet drives goes green on an agent's word, and the authoring note now makes a driven
 * check the ordinary case rather than the exception. `proof` is the counterweight: freedom in *how*,
 * an obligation on *what comes back*. Both channels that can record a reading carry the rule, because
 * a rule on one of them is a rule the other walks around without noticing.
 *
 * → docs/spec/20-validation.md#proof
 * → docs/spec/36-remote-validation.md#a-check-the-agent-drives-itself
 */

const GOAL = 'issue:12';
const DEPLOYED = 'cccccccc3333333333333333333333333333333c';
const ROW = 'check:batch-imports';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: {
    permits: ['check'],
    tenant: 'validation-customer-1',
    browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' },
  },
};

/** No area and no script, so the run's own agent is the instrument and the reading is worth `agent`. */
const DRIVEN_STEP: ValidationStep = {
  kind: 'browser',
  do: 'Upload a file through the importer and find the batch it made',
  area: null,
  expects: null,
  when: 'inline',
  script: null,
  scriptSweptAt: null,
  actor: 'fleet',
  why: null,
};

const PROOF = 'A screen of the batch page with the row count visible.';

function checkInput(proof: string | null): ValidationCheckInput {
  return {
    id: 'batch-imports',
    seq: 1,
    title: 'An uploaded file shows on the batch page with its row count',
    do: 'Upload a file through the new importer',
    expect: 'The batch page lists it, and the count matches the file',
    proof,
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    steps: [DRIVEN_STEP],
  };
}

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ------------------------------------------------------------------ the tool channel refuses a pass

test('a check that declares proof is refused a pass that hands nothing back', () => {
  const parsed = validateReport({ result: 'passed', note: 'Looked right to me.' }, { proof: PROOF });
  assert.equal(parsed.ok, false, 'an agent cannot settle this check on its own word');
  assert.match(
    parsed.ok ? '' : parsed.error,
    /declares "proof"/,
    'and the refusal names the demand rather than reading as a schema error',
  );
  assert.match(
    parsed.ok ? '' : parsed.error,
    /"failed".+"blocked"/s,
    'it offers the two honest answers, so the agent does not read this as "try again with a pass"',
  );
});

test('a check that declares proof takes a pass that names the capture', () => {
  const parsed = validateReport(
    { result: 'passed', note: 'Batch page listed it, 412 rows.', capture: 'batch.png' },
    { proof: PROOF },
  );
  assert.ok(parsed.ok, 'the evidence its author asked for in advance is what makes the pass recordable');
  assert.equal(parsed.ok ? parsed.report.capture : null, 'batch.png');
});

test('a capture still never rides a pass on a check that demanded none', () => {
  // The rule this narrows, and the reason it exists: an image an agent *volunteered* beside a green
  // row it awarded itself reads as the evidence for it, and nobody looked. `proof` inverts that
  // direction — the demand is the author's, written before the run — which is why it is the only
  // thing that opens this door.
  const parsed = validateReport({ result: 'passed', note: 'Looked right.', capture: 'batch.png' }, { proof: null });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /volunteered beside a pass/);
});

test('an empty proof is no proof, so a whitespace string cannot switch the rule on', () => {
  assert.equal(demandsProof({ proof: null }), false);
  assert.equal(demandsProof({ proof: '   ' }), false, 'absent and blank are the same fact');
  assert.equal(demandsProof({ proof: PROOF }), true);
});

test('proof changes nothing about a blocked report, which records no reading at all', () => {
  const parsed = validateReport({ result: 'blocked', note: 'The importer never loaded.' }, { proof: PROOF });
  assert.ok(parsed.ok, 'a check an agent could not reach is still given back, evidence or no evidence');
});

// ------------------------------------------------------------------------------- what the agent reads

test('the check briefing states the demand and what happens without it', () => {
  const check = { ...checkInput(PROOF), letter: 'A', handbackNote: null, candidateWhy: null } as ValidationCheck;
  const brief = checkBriefing(check);
  assert.match(brief, /### Proof/, 'the demand is its own section, not a sentence inside Expect');
  assert.match(brief, new RegExp(PROOF.slice(0, 20)));
  assert.match(brief, /refused a pass without it/, 'and the agent is told the consequence before it runs');

  const without = checkBriefing({ ...check, proof: null });
  assert.doesNotMatch(without, /### Proof/, 'a check that demanded none grows no empty section');
});

// ---------------------------------------------------------------------------------- the sheet's run

interface Bench {
  system: System;
  dir: string;
  runId: string;
}

function bench(proof: string | null): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-proof-'));
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
  const check = checkInput(proof);
  store.validation.ingestValidation(GOAL, { checks: [check], resources: [], supersededReason: '', amendNote: '' });
  store.remoteValidation.openRemoteSheet({ goalRef: GOAL, environment: 'acceptance' });
  store.remoteValidation.saveRemoteSheetRows(GOAL, 'acceptance', [
    {
      rowId: ROW,
      kind: 'check',
      seq: 1,
      title: check.title,
      sourceId: check.id,
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
  const artefacts = join(remoteValidationRunDir(config.validationRoot, GOAL, run.id), 'artefacts');
  mkdirSync(artefacts, { recursive: true });
  writeFileSync(join(artefacts, 'batch.png'), PIXEL);
  return { system, dir, runId: run.id };
}

function close(b: Bench): void {
  b.system.store.close();
  rmSync(b.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function settle(b: Bench, row: Record<string, unknown>): Promise<void> {
  const path = join(b.dir, 'report.json');
  writeFileSync(path, JSON.stringify([row]));
  const settled = await b.system.remoteReadings.settle(b.runId, { reportPath: path, artefacts: null });
  assert.ok(settled.ok, 'ok' in settled ? '' : String(settled));
}

test('a driven check that demanded proof is blocked when the run reports a pass with no screen', async () => {
  const b = bench(PROOF);
  await settle(b, { selector: 'batch-imports', status: 'passed' });

  const check = b.system.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(check?.state, 'unrun', 'a blocked row writes nothing at all — no reading was taken');

  const reading = b.system.store.remoteValidation.listRemoteReadings().find((r) => r.rowId === ROW);
  assert.equal(reading?.outcome, 'blocked', 'and the run says so on its own row rather than going quiet');
  close(b);
});

test('a driven check that demanded proof passes with the screen beside it, and is not handed to a person', async () => {
  const b = bench(PROOF);
  await settle(b, { selector: 'batch-imports', status: 'passed', capture: 'batch.png' });

  const check = b.system.store.validation.listValidationChecks(GOAL)[0];
  // The distinction `proof` exists to keep: a `screenshot` step asserts nothing and reaches
  // `captured`, waiting for somebody's judgement. A `proof` rides a check that **did** assert, so the
  // row reaches what the instrument reached. Folding the two would put a person in front of every
  // driven goal, which is the thing a driven check exists to remove.
  assert.equal(check?.state, 'passed', 'the agent asserted, and the evidence is what made it recordable');
  assert.equal(check?.resultBy, 'agent', 'and it is still the weakest attribution on the sheet');
  assert.match(check?.capture ?? '', /^capture-/, 'the screen is kept with the goal, under the harness’s own name');
  close(b);
});

test('a driven check that demanded nothing passes on its report alone, exactly as before', async () => {
  const b = bench(null);
  await settle(b, { selector: 'batch-imports', status: 'passed' });

  const check = b.system.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(check?.state, 'passed', 'proof tightens a check whose author asked for it, and no other');
  assert.equal(check?.resultBy, 'agent');
  close(b);
});

test('a demand for proof does not withhold a red the product earned', async () => {
  const b = bench(PROOF);
  await settle(b, { selector: 'batch-imports', status: 'failed' });

  const check = b.system.store.validation.listValidationChecks(GOAL)[0];
  assert.equal(check?.state, 'failed', 'a finding about the goal is never traded for missing evidence');
  close(b);
});

// -------------------------------------------------------------------------------- amendment and the band

test('changing what a check has to prove withdraws the reading it already had', () => {
  const b = bench(PROOF);
  const { store } = b.system;
  store.validation.recordValidationResult(GOAL, 'batch-imports', {
    state: 'passed',
    note: 'Saw the batch page.',
    by: 'operator',
  });

  store.validation.amendValidation(GOAL, {
    checks: [{ ...checkInput('A screen of the audit log, not the batch page.'), seq: undefined } as never],
    withdraw: [],
    resources: [],
    note: 'The evidence moved: the batch page no longer shows the count.',
  });

  const check = store.validation.listValidationChecks(GOAL)[0];
  assert.equal(
    check?.state,
    'unrun',
    'a pass earned by handing back one screen is not a pass under a demand for another',
  );
  assert.equal(
    check?.revision?.proof,
    PROOF,
    'and the band keeps what it used to demand, not just what it used to say',
  );
  close(b);
});
