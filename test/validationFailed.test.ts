import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import type {
  Agent,
  Decision,
  Issue,
  IssueDelivery,
  Plan,
  ValidationCheck,
  ValidationCheckState,
} from '../src/types.js';

/**
 * What happens when a validation check comes back **failed**.
 *
 * Before this rule, nothing did: the one verdict in the harness that says the
 * delivered thing does not work wrote a note and waited for a person. The
 * properties asserted here are the ones a later edit would break silently:
 *
 * 1. **A failed check is looked at; every other state is not.** A `passed`,
 *    `waived` or `deferred` check has an answer, and an `unrun` one is rule
 *    `validate-check`'s.
 * 2. **The delivery survives it.** The tempting wiring — record the failure as a
 *    shortfall and reuse the three arms that exist — clears the goal's delivery
 *    row, which un-parks the goal and settles the obligation the reading was
 *    taken for.
 * 3. **The agent cannot record a reading.** Its origin is not one
 *    `validation_report` parses, so the refusal is structural.
 * 4. **Each reading gets its own budget.** A check that failed, was fixed and
 *    failed again is looked at again rather than meeting a spent attempt cap.
 */

const NOW = '2025-01-01T12:00:00.000Z';
const ORIGIN = 'issue:12:validate-failure:csv-opens';
const READING = '2025-01-01T11:00:00.000Z';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vfailed-'));
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

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'every part merged',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

function plan(): Plan {
  return {
    id: 'plan-12',
    originRef: 'issue:12',
    title: 'Ship it',
    status: 'active',
    reason: 'One fix.',
    diagnosis: null,
    approach: null,
    alternatives: null,
    openQuestions: null,
    risks: null,
    outOfScope: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function check(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    originRef: 'issue:12',
    id: 'csv-opens',
    letter: 'A',
    seq: 1,
    title: 'The export opens in Excel',
    do: 'Export a report and open it.',
    expect: 'It opens with the columns intact.',
    uses: [],
    covers: [],
    fleetCandidate: false,
    candidateWhy: null,
    actor: 'human',
    handbackNote: null,
    claimedBy: null,
    claimedAt: null,
    state: 'failed',
    resultNote: 'the columns are shifted one to the right from row 40 on',
    resultBy: 'operator',
    resultAt: READING,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [issue()] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    plans: [plan()],
    deliveries: [delivered()],
    ...over,
  };
}

function runner(): RuleDispatcher {
  return new RuleDispatcher({}, {}, undefined, 'main', {}, {}, {}, '/srv/validation');
}

/** The origins this rule dispatched on, in order. */
function diagnoses(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.includes(':validate-failure:'));
}

/** One executed dispatch on an origin, as the audit log records it. */
function attempt(origin: string, at: string): Decision {
  return {
    id: `d-${at}`,
    cycleId: 'c1',
    rule: 'validation-failed',
    admission: null,
    reason: 'looked into it',
    outcome: 'executed',
    detail: null,
    action: {
      type: 'dispatch_code_agent',
      title: 'Look into it',
      prompt: 'p',
      branch: 'validate-failure/issue/12/csv-opens',
      base: 'main',
      originRef: origin,
    },
    createdAt: at,
  } as unknown as Decision;
}

test('a failed check gets an agent; every other state does not', async () => {
  const failed = await runner().decide(ctx({ validationChecks: [check()] }));
  assert.deepEqual(diagnoses(failed.actions), ['issue:12:validate-failure:csv-opens']);

  // `unrun` is rule `validate-check`'s, and the other three carry an answer
  // somebody settled on. Only `failed` says the delivered thing does not work.
  for (const state of ['unrun', 'passed', 'waived', 'deferred'] as ValidationCheckState[]) {
    const other = await runner().decide(ctx({ validationChecks: [check({ state, resultBy: null })] }));
    assert.deepEqual(diagnoses(other.actions), [], `a ${state} check is not a finding about the goal`);
  }

  // Its own plan stopped asking for it, so the reading it withdrew is not worth
  // an agent either.
  const withdrawn = await runner().decide(ctx({ validationChecks: [check({ supersededReason: 'the screen went' })] }));
  assert.deepEqual(diagnoses(withdrawn.actions), []);
});

test('it is a read-only code agent on the default branch, in its own namespace', async () => {
  const decided = await runner().decide(ctx({ validationChecks: [check()] }));
  const action = decided.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-failure:csv-opens');
  assert.equal(action?.type, 'dispatch_code_agent');
  const dispatch = action as unknown as { branch: string; base: string; readOnly?: boolean; prompt: string };
  // The delivered work is *on* the default branch, which is the only checkout the
  // failure can be reproduced in.
  assert.equal(dispatch.base, 'main');
  // Its own namespace: git cannot put a ref beneath another ref, and `validate/`
  // is the run's.
  assert.equal(dispatch.branch, 'validate-failure/issue/12/csv-opens');
  // It diagnoses; it does not fix. A branch nothing opens a pull request from is
  // a ref nothing would ever reap.
  assert.equal(dispatch.readOnly, true);
  // The two halves it cannot start without, appended rather than interpolated.
  assert.match(dispatch.prompt, /Export a report and open it\./);
  assert.match(dispatch.prompt, /columns are shifted one to the right/);
  // Who took the reading, because "an agent says this failed" and "I ran it and
  // it failed" are different facts.
  assert.match(dispatch.prompt, /A person ran it/);
});

test('a goal that is not delivered, and a check somebody is re-running, are left alone', async () => {
  // A reading taken against half-built work is a finding about the calendar.
  const inFlight = await runner().decide(ctx({ deliveries: [], validationChecks: [check()] }));
  assert.deepEqual(diagnoses(inFlight.actions), []);

  // A desktop session has the check back: its reading is about to replace the one
  // this dispatch would have been sent to explain.
  const claimed = await runner().decide(ctx({ validationChecks: [check({ claimedBy: 'laptop', claimedAt: NOW })] }));
  assert.deepEqual(diagnoses(claimed.actions), []);
});

test('each reading gets its own attempt budget', async () => {
  const spent = [
    attempt(ORIGIN, '2025-01-01T09:00:00.000Z'),
    attempt(ORIGIN, '2025-01-01T09:30:00.000Z'),
    attempt(ORIGIN, '2025-01-01T10:00:00.000Z'),
  ];
  // Three attempts against the *previous* reading. Counted, they would leave a
  // check that failed again after a fix with a spent cap and no second look —
  // exactly where a repeat failure is worth most.
  const again = await runner().decide(ctx({ recentDecisions: spent, validationChecks: [check()] }));
  assert.deepEqual(diagnoses(again.actions), ['issue:12:validate-failure:csv-opens']);

  // Attempts against *this* reading do count: three of them and the rule stops,
  // silently, because the flag and the note are already in front of the operator.
  const thisReading = spent.map((_, i) => attempt(ORIGIN, `2025-01-01T11:${10 + i}:00.000Z`));
  const capped = await runner().decide(ctx({ recentDecisions: thisReading, validationChecks: [check()] }));
  assert.deepEqual(diagnoses(capped.actions), []);
  assert.equal(
    capped.actions.filter((a) => a.type === 'escalate_to_human').length,
    0,
    'nothing is gated on a check, so a spent cap escalates nothing',
  );
});

test('the diagnosis dispatch clears no verdict: the goal stays delivered and parked', async () => {
  const decided = await runner().decide(ctx({ validationChecks: [check()] }));
  // The whole reason this is not wired through a shortfall. A shortfall clears the
  // delivery, which un-parks the goal, settles its close-out obligation and
  // declines the validation bench row — the failed check would delete the rows it
  // was reported into.
  for (const action of decided.actions) {
    assert.notEqual(action.type, 'record_issue_shortfall' as string);
    assert.notEqual(action.type, 'clear_issue_delivery' as string);
  }
});

test('the agent it sends may not record a reading on the check', async () => {
  const system = build();
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    validation: {
      checks: [{ id: 'csv-opens', title: 'The export opens', do: 'Export a report.', expect: 'It opens.' }],
    },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: 'issue:12', title: 'Ship it' });

  const task = system.store.createTask({
    kind: 'code',
    title: 'Look into check A',
    prompt: 'diagnose it',
    branch: 'validate-failure/issue/12/csv-opens',
    originRef: 'issue:12:validate-failure:csv-opens',
    originTitle: 'Ship it',
  });
  const agent: Agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
  const session = system.mcp.session(agent.id);
  assert.ok(session);
  const result = (await session!.call('validation_report', {
    result: 'passed',
    note: 'I could not reproduce it, so it must be fine',
  })) as ToolResultText;

  // Structural, not a sentence in a prompt: the tool resolves its check from the
  // dispatch origin, and a diagnosis origin is not one it parses. The reading
  // belongs to whoever took it.
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /validation_amend/);
  const after = system.store.listValidationChecks('issue:12').find((c) => c.id === 'csv-opens');
  assert.equal(after?.state, 'unrun', 'nothing was recorded');
});
