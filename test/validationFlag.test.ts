import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument, type PlanDocument } from '../src/plans/planDocument.js';
import { validationVerdict } from '../src/validation/verdict.js';
import { closeOutPass } from '../src/delivery/closeOut.js';
import type { HumanTask, Issue, IssueDelivery, ValidationCheck, WorldSnapshot } from '../src/types.js';

/**
 * The flag: what a validation plan that is not clear changes, and — just as
 * importantly — what it does not.
 *
 * Both polarities are asserted on every rule here, `planApproval.test.ts`'s
 * discipline. A verdict that counts `deferred` as clear and one that does not are
 * one edit apart, and only one of them is honest; a test that only ever saw the
 * flagged case would pass against either.
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vflag-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 0,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function check(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    originRef: 'issue:12',
    id: 'a',
    letter: 'A',
    seq: 1,
    title: 'It works',
    do: 'Run it.',
    expect: 'It works.',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...over,
  };
}

// -- the verdict, both directions --------------------------------------------

test('passed and waived clear; unrun, failed and deferred do not', () => {
  assert.equal(validationVerdict([]).state, 'clear');
  assert.equal(validationVerdict([check({ state: 'passed' })]).state, 'clear');
  // Said out loud, with a reason, as a decision not to check — the one thing
  // other than a pass that settles.
  assert.equal(validationVerdict([check({ state: 'waived' })]).state, 'clear');
  assert.equal(validationVerdict([check({ state: 'passed' }), check({ id: 'b', state: 'waived' })]).state, 'clear');

  assert.equal(validationVerdict([check({ state: 'unrun' })]).state, 'flagged');
  assert.equal(validationVerdict([check({ state: 'failed' })]).state, 'flagged');
  // The guard that makes deferral honest: it takes a check out of today's work
  // and leaves it in the count. Otherwise it is the quiet exit `unrun` is loud
  // about.
  assert.equal(validationVerdict([check({ state: 'deferred' })]).state, 'flagged');
  assert.equal(validationVerdict([check({ state: 'passed' }), check({ id: 'b', state: 'unrun' })]).state, 'flagged');
});

test('a superseded check is out of the count as well as out of the sheet', () => {
  const verdict = validationVerdict([
    check({ state: 'passed' }),
    check({ id: 'b', state: 'unrun', supersededReason: 'an amended plan dropped it' }),
  ]);
  // Flagging a goal over a check its own plan withdrew is the one way this
  // becomes noise the operator learns to click past.
  assert.equal(verdict.state, 'clear');
  assert.equal(verdict.total, 1);
});

// -- the close-out obligation ------------------------------------------------

function issue(number: number): Issue {
  return { id: `i${number}`, number, title: 'Ship it', body: '', labels: [], state: 'open', linkedPrNumber: null };
}

function delivery(number: number): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: 'the goal is reached',
    detail: null,
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: 'now',
    updatedAt: 'now',
  };
}

function filed(over: Partial<Parameters<typeof closeOutPass>[0]> = {}): { detail: string } {
  const steps = closeOutPass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    shortfalls: [],
    existing: [] as HumanTask[],
    validation: new Map(),
    ...over,
  });
  const file = steps.find((s) => s.kind === 'file');
  assert.ok(file && file.kind === 'file');
  return { detail: file.detail };
}

test('the close-out obligation states the count, and only when there is one to state', () => {
  // Clear, and a goal with no plan at all: nothing is added either way, because
  // the row is an ask about the tracker and not a place to congratulate anyone.
  assert.doesNotMatch(filed().detail, /Validation/);
  assert.doesNotMatch(
    filed({
      validation: new Map([
        ['issue:12', { verdict: validationVerdict([check({ state: 'passed' })]), outstanding: [] }],
      ]),
    }).detail,
    /Validation/,
  );

  const flagged = filed({
    validation: new Map([
      [
        'issue:12',
        {
          verdict: validationVerdict([check({ state: 'unrun' }), check({ id: 'b', state: 'deferred' })]),
          outstanding: ['A. **It works** — unrun', 'B. **It still works** — deferred — env rebuilt Thursday'],
        },
      ],
    ]),
  }).detail;
  assert.match(flagged, /Validation is not clear/);
  assert.match(flagged, /1 never run/);
  assert.match(flagged, /1 deferred/);
  // The reasons ride through rather than being summarised: a bare count is what
  // gets read as noise.
  assert.match(flagged, /env rebuilt Thursday/);
});

// -- what closing a flagged goal costs ---------------------------------------

function plan(system: System, checks: Record<string, unknown>[]): string {
  const parsed = validatePlanDocument({
    version: 1,
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    reason: 'One small fix.',
    validation: { checks },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const doc: PlanDocument = parsed.document;
  ingestPlanDocument(system.store, { doc, originRef: 'issue:12', title: 'Ship it' });
  // The goal, which is what the checks are keyed on.
  return 'issue:12';
}

const CHECK = { id: 'a', title: 'It works', do: 'Run it.', expect: 'It works.' };

async function server(system: System) {
  const { app } = await buildApp(system);
  return app;
}

test('ending a run on a flagged goal costs a sentence, and a clear one costs nothing', async () => {
  const system = build();
  plan(system, [CHECK]);
  system.store.recordIssueRun({
    originRef: 'issue:12',
    issueNumber: 12,
    title: 'Ship it',
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    complete: true,
  });
  const app = await server(system);

  const refused = await app.inject({ method: 'POST', url: '/api/issues/12/dismiss-run', payload: {} });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /note is required/);
  // Refused, not blocked: the run is untouched, so the operator's next click
  // still works.
  assert.equal(system.store.listIssueRuns()[0]!.dismissedAt, null);

  const withNote = await app.inject({
    method: 'POST',
    url: '/api/issues/12/dismiss-run',
    payload: { note: 'shipping it anyway, checking A on Monday' },
  });
  assert.equal(withNote.statusCode, 200);
  const ended = system.store.listIssueRuns()[0]!;
  assert.ok(ended.dismissedAt);
  assert.equal(ended.dismissNote, 'shipping it anyway, checking A on Monday');
  await app.close();

  // The other polarity: the same goal, with its one check passed, ends with no
  // note at all. A guard that fired either way would just be friction.
  const clear = build();
  const clearPlan = plan(clear, [CHECK]);
  clear.store.recordValidationResult(clearPlan, 'a', { state: 'passed', note: 'ran it', by: 'operator' });
  clear.store.recordIssueRun({
    originRef: 'issue:12',
    issueNumber: 12,
    title: 'Ship it',
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    complete: true,
  });
  const clearApp = await server(clear);
  const ok = await clearApp.inject({ method: 'POST', url: '/api/issues/12/dismiss-run', payload: {} });
  assert.equal(ok.statusCode, 200);
  await clearApp.close();
});

test('marking a close-out done on a flagged goal costs a sentence; an ordinary ask does not', async () => {
  const system = build();
  plan(system, [CHECK]);
  const { task: closeOut } = system.store.recordHumanTask({
    title: 'Close issue #12 in the tracker',
    detail: 'still open',
    originRef: 'issue:12',
    kind: 'close_out',
    agentId: null,
    taskId: null,
  });
  // An ordinary ask on the same goal: nothing to do with the validation plan, and
  // asking a note of somebody ticking off "plug the cable in" is the friction
  // that gets the whole flag ignored.
  const { task: ask } = system.store.recordHumanTask({
    title: 'Plug the cable in',
    detail: 'rack 4',
    originRef: 'issue:12',
    agentId: null,
    taskId: null,
  });
  const app = await server(system);

  const refused = await app.inject({ method: 'POST', url: `/api/human-tasks/${closeOut.id}/done`, payload: {} });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /note is required/);
  assert.equal(system.store.getHumanTask(closeOut.id)!.status, 'open');

  const plain = await app.inject({ method: 'POST', url: `/api/human-tasks/${ask.id}/done`, payload: {} });
  assert.equal(plain.statusCode, 200);

  const withNote = await app.inject({
    method: 'POST',
    url: `/api/human-tasks/${closeOut.id}/done`,
    payload: { note: 'closed it; A is on Monday' },
  });
  assert.equal(withNote.statusCode, 200);
  assert.equal(system.store.getHumanTask(closeOut.id)!.resolution, 'closed it; A is on Monday');
  await app.close();
});

// -- and what it does not do -------------------------------------------------

test('a flagged goal blocks nothing: the cycle runs and the conclusion is untouched', async () => {
  const system = build();
  plan(system, [CHECK]);
  const world: WorldSnapshot = { takenAt: new Date().toISOString(), pullRequests: [], issues: [issue(12)] };
  system.store.setWorldBaseline(world);

  const report = await system.harness.runCycle('manual');
  assert.ok(report, 'a cycle runs with an unrun validation plan on the books');

  // The conclusion is a different question with a different author, and a
  // flagged plan must not answer it.
  system.store.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'done',
    note: 'the agent says so',
    by: 'agent',
    agentId: null,
    taskId: null,
  });
  assert.equal(system.store.getIssueConclusion('issue:12')!.verdict, 'done');
});
