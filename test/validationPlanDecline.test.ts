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
import { sheetRows } from '../src/remoteValidation/sheet.js';
import { validationReadyPass } from '../src/validation/ready.js';
import { validationVerdict, outstandingChecks } from '../src/validation/verdict.js';
import { resolveDeclines } from '../src/validation/planDecline.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Proposal, ValidationCheckInput } from '../src/types.js';

// → docs/spec/20-validation.md#declining-a-single-row

const GOAL = 'issue:12';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vdecline-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function input(id: string, seq: number, title: string): ValidationCheckInput {
  return {
    id,
    seq,
    title,
    do: `Run ${id}.`,
    expect: 'It works.',
    proof: null,
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
  };
}

/** A goal with an authored, unreleased three-check set and a pending proposal on it. */
function proposed(system: System): Proposal {
  system.store.validation.ingestValidation(GOAL, {
    checks: [
      input('csv-opens', 1, 'The export opens in Excel'),
      input('login-works', 2, 'A supplier can sign in'),
      input('browser-tour', 3, 'The whole journey in a browser'),
    ],
    resources: [],
    supersededReason: 'withdrawn',
    amendNote: '',
  });
  system.store.validation.recordValidationAuthoring(GOAL, { note: 'three checks', emptyReason: null });
  return system.store.escalations.createProposal({
    kind: 'validation_plan',
    ref: 'issue:12:validate-plan',
    action: { type: 'propose_validation_plan', originRef: GOAL, issueNumber: 12 } as never,
    escalationId: null,
  });
}

test('one row is declined in the same press that accepts the rest', async () => {
  const system = build();
  const proposal = proposed(system);

  const accepted = await system.proposals.accept(
    proposal.id,
    undefined,
    [],
    [],
    [{ letter: 'C', reason: 'a browser run on every goal is not worth it for this one' }],
  );
  assert.ok(accepted && 'proposal' in accepted && accepted.outcome === 'performed');

  const record = system.store.validation.getValidationPlanRecord(GOAL);
  assert.ok(record?.releasedAt, 'the rest of the set releases — a decline is not a refusal of the set');
  assert.ok(record?.authoredAt, 'and the authoring stamp is untouched, so no planner is asked again');

  const checks = system.store.validation.listValidationChecks(GOAL);
  assert.deepEqual(
    checks.map((c) => [c.letter, c.state]),
    [
      ['A', 'unrun'],
      ['B', 'unrun'],
      ['C', 'declined'],
    ],
    'the four good rows are untouched and only the struck one is settled',
  );
  const struck = checks.find((c) => c.letter === 'C')!;
  assert.equal(struck.resultNote, 'a browser run on every goal is not worth it for this one');
  assert.equal(struck.resultBy, 'operator', 'the decline is the operator’s verdict, attributed to them');
  assert.ok(struck.resultAt, 'and it is settled — a reading, not an absence');
  system.store.close();
});

test('a declined row is settled but never clear, and the close-out line says which it is', () => {
  const system = build();
  system.store.validation.ingestValidation(GOAL, {
    checks: [input('a', 1, 'A'), input('b', 2, 'B')],
    resources: [],
    supersededReason: 'withdrawn',
    amendNote: '',
  });
  system.store.validation.recordValidationResult(GOAL, 'a', { state: 'passed', note: 'ran it', by: 'operator' });
  system.store.validation.recordValidationResult(GOAL, 'b', { state: 'declined', note: 'too costly', by: 'operator' });
  const checks = system.store.validation.listValidationChecks(GOAL);

  const verdict = validationVerdict(checks);
  assert.equal(verdict.declined, 1, 'counted on its own — a decline at the gate is not a waiver at close');
  assert.equal(verdict.waived, 0);
  assert.equal(verdict.state, 'flagged', 'a set whose only interesting row was declined does not read clear');
  assert.match(outstandingChecks(checks).join('\n'), /declined — too costly/, 'listed with the reason it carries');
  system.store.close();
});

test('a declined row is owed to nobody and is never assembled onto a sheet', () => {
  const system = build();
  system.store.validation.ingestValidation(GOAL, {
    checks: [input('a', 1, 'A'), input('b', 2, 'B')],
    resources: [],
    supersededReason: 'withdrawn',
    amendNote: '',
  });
  system.store.validation.recordValidationResult(GOAL, 'b', {
    state: 'declined',
    note: 'not worth it',
    by: 'operator',
  });
  const checks = system.store.validation.listValidationChecks(GOAL);

  const environment = { name: 'acceptance', validate: { permits: ['check'] } } as unknown as EnvironmentConfig;
  const rows = sheetRows({ environment, checks, watches: [], queries: [], approvals: new Set() });
  assert.deepEqual(
    rows.map((r) => r.rowId),
    ['check:a'],
    'the struck row is not on the sheet — assembled, it would be pressed and its reading written back',
  );

  const steps = validationReadyPass({
    issues: [],
    deliveries: [{ originRef: GOAL } as never],
    shortfalls: [],
    existing: [],
    checks: new Map([[GOAL, checks]]),
    sheetRows: new Map(),
    opened: null,
    watchCleared: null,
  });
  const filed = steps.find((s) => s.kind === 'file');
  assert.ok(filed && 'detail' in filed);
  assert.match(
    String(filed.detail),
    /has 1 check for you to run/,
    'and the bench asks for the one live row, never for the one the operator struck',
  );
  system.store.close();
});

test('declining every row sends the set back, carrying the reasons to the next planner', async () => {
  const system = build();
  const proposal = proposed(system);

  const decided = await system.proposals.accept(
    proposal.id,
    'none of these',
    [],
    [],
    [
      { letter: 'A', reason: 'the suite already asserts it' },
      { letter: 'B', reason: 'covered by the login spec' },
      { letter: 'C', reason: 'too expensive' },
    ],
  );
  assert.ok(decided && 'proposal' in decided);
  assert.equal(decided.proposal.status, 'rejected', 'a set declined whole is a rejection, not a released set of none');

  const record = system.store.validation.getValidationPlanRecord(GOAL);
  assert.equal(record?.authoredAt, null, 'the authoring stamp comes off, so the planner is dispatchable again');
  assert.equal(record?.releasedAt, null, 'and nothing was released — an empty released set reads as an emptyReason');
  assert.deepEqual(
    system.store.validation.listValidationChecks(GOAL).map((c) => c.state),
    ['unrun', 'unrun', 'unrun'],
    'no row is settled by a rejection: they are the next planner’s starting point',
  );
  assert.match(String(decided.proposal.note), /none of these/);
  assert.match(String(decided.proposal.note), /the suite already asserts it/, 'the row-by-row words travel with it');
  assert.match(String(decided.proposal.note), /too expensive/);
  system.store.close();
});

test('a letter naming no live row is ignored rather than costing the operator the whole accept', async () => {
  const system = build();
  const proposal = proposed(system);

  const accepted = await system.proposals.accept(
    proposal.id,
    undefined,
    [],
    [],
    [
      { letter: 'C', reason: 'too expensive' },
      { letter: 'Z', reason: 'superseded while the card was open' },
    ],
  );
  assert.ok(accepted && 'detail' in accepted);
  assert.equal(accepted.outcome, 'performed', 'the set still releases — a stale letter is not a refusal');
  assert.match(accepted.detail, /you declined C/);
  assert.match(accepted.detail, /Z named no live check/, 'and the audit line says what was ignored');
  assert.deepEqual(
    system.store.validation.listValidationChecks(GOAL).map((c) => c.state),
    ['unrun', 'unrun', 'declined'],
  );
  system.store.close();
});

test('the reset route is the undo — a decline is the operator’s verdict, not a one-way door', () => {
  const system = build();
  system.store.validation.ingestValidation(GOAL, {
    checks: [input('a', 1, 'A')],
    resources: [],
    supersededReason: 'withdrawn',
    amendNote: '',
  });
  system.store.validation.recordValidationResult(GOAL, 'a', {
    state: 'declined',
    note: 'not worth it',
    by: 'operator',
  });
  const back = system.store.validation.recordValidationResult(GOAL, 'a', { state: 'unrun', note: null, by: null });
  assert.equal(back?.state, 'unrun', 'the arrival looking worse than expected is exactly the case this is for');
  assert.equal(back?.resultNote, null);
  system.store.close();
});

test('declines resolve by letter, and a superseded row is not one of them', () => {
  const system = build();
  system.store.validation.ingestValidation(GOAL, {
    checks: [input('a', 1, 'A'), input('b', 2, 'B')],
    resources: [],
    supersededReason: 'withdrawn',
    amendNote: '',
  });
  system.store.validation.ingestValidation(GOAL, {
    checks: [input('a', 1, 'A')],
    resources: [],
    supersededReason: 'the planner dropped it',
    amendNote: 'rewritten',
  });
  const checks = system.store.validation.listValidationChecks(GOAL);

  const both = resolveDeclines(checks, [
    { letter: 'A', reason: 'no' },
    { letter: 'B', reason: 'also no' },
  ]);
  assert.deepEqual(
    both.resolved.map((r) => r.check.letter),
    ['A'],
    'a superseded row is already off the bench and cannot be declined',
  );
  assert.deepEqual(both.unknown, ['B']);
  assert.equal(both.whole, true, 'and declining every *live* row is still the whole set');
  system.store.close();
});
