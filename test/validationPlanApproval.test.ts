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
import { sheetableArrivals } from '../src/environments/watchWindow.js';
import { checkSetAuthored } from '../src/validation/authoring.js';
import { checkSetReleased } from '../src/validation/planApproval.js';
import type {
  GoalArrival,
  Issue,
  IssueDelivery,
  Plan,
  Proposal,
  ValidationCheck,
  ValidationPlanRecord,
} from '../src/types.js';

// → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work

const NOW = '2025-01-01T00:00:00.000Z';

const GOAL = 'issue:12';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vgate-'));
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

function issue(): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
}

function delivered(): IssueDelivery {
  return {
    originRef: GOAL,
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
    originRef: GOAL,
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

function record(over: Partial<ValidationPlanRecord> = {}): ValidationPlanRecord {
  return {
    originRef: GOAL,
    hint: 'the upload path against a real store',
    note: 'wrote two checks against the merged importer',
    emptyReason: null,
    authoredAt: NOW,
    releasedAt: null,
    ...over,
  };
}

function check(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    originRef: GOAL,
    id: 'csv-opens',
    letter: 'A',
    seq: 1,
    title: 'The export opens in Excel',
    do: 'Export a report.',
    expect: 'It opens.',
    uses: [],
    covers: [],
    steps: [],
    fleetCandidate: true,
    candidateWhy: 'reads a file; no login',
    actor: 'fleet',
    handbackNote: null,
    state: 'unrun',
    resultNote: null,
    resultBy: null,
    resultAt: null,
    claimedBy: null,
    claimedAt: null,
    deferUntil: null,
    supersededReason: null,
    revision: null,
    amendedAt: null,
    amendNote: null,
    area: null,
    capture: null,
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
    validationPlans: [record()],
    validationChecks: [check()],
    ...over,
  };
}

interface Ask {
  type: string;
  checks?: number;
  note?: string | null;
  hint?: string | null;
  set?: {
    letter: string;
    title: string;
    steps: { kind: string; actor: string }[];
    fleetBlocked: boolean;
    carriesQuery: boolean;
  }[];
}

function asks(actions: { type: string }[]): Ask[] {
  return actions.filter((a) => a.type === 'propose_validation_plan') as never;
}

function checkDispatches(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => /:validate:/.test(o));
}

test('an authored check set is put to the operator, and nothing runs it until they answer', async () => {
  const decided = await new RuleDispatcher().decide(ctx());
  const ask = asks(decided.actions);
  assert.equal(ask.length, 1, 'the set is proposed');
  assert.equal(ask[0]?.checks, 1);
  assert.equal(
    ask[0]?.note,
    'wrote two checks against the merged importer',
    'the planner’s own note rides on the ask — a verdict on a number is not a verdict',
  );
  assert.deepEqual(
    (ask[0]?.set ?? []).map((c) => [c.letter, c.title]),
    [['A', 'The export opens in Excel']],
    'and so does the set itself, as structure the card draws rather than a paragraph',
  );
  assert.deepEqual(
    checkDispatches(decided.actions),
    [],
    'a check handed to the fleet on an unaccepted set dispatches nothing',
  );
});

test('the ask carries each check’s journey, who carries each step, and which read the store', async () => {
  const withSteps = check({
    steps: [
      {
        kind: 'manual',
        do: 'Seed a supplier account',
        area: null,
        when: 'inline',
        script: null,
        scriptSweptAt: null,
        actor: 'human',
        why: null,
      },
      {
        kind: 'state',
        do: 'Count the audit rows',
        area: null,
        when: 'inline',
        script: null,
        scriptSweptAt: null,
        actor: 'fleet',
        why: null,
      },
    ],
  });
  const decided = await new RuleDispatcher().decide(ctx({ validationChecks: [withSteps] }));
  const set = asks(decided.actions)[0]?.set ?? [];
  assert.deepEqual(
    set[0]?.steps.map((s) => [s.kind, s.actor]),
    [
      ['manual', 'human'],
      ['state', 'fleet'],
    ],
    'the journey is drawn in order, with each step’s actor — prose in a `do` cannot say that to a reader',
  );
  assert.equal(set[0]?.fleetBlocked, true, 'a first step that is a person’s is stated, not left to be inferred');
  assert.equal(
    set[0]?.carriesQuery,
    true,
    'and a check reading the store is flagged: the accept never covers its query',
  );
});

test('a released set is not re-proposed, and its fleet checks dispatch', async () => {
  const decided = await new RuleDispatcher().decide(ctx({ validationPlans: [record({ releasedAt: NOW })] }));
  assert.deepEqual(asks(decided.actions), [], 'the operator has answered; it is not asked again');
  assert.deepEqual(checkDispatches(decided.actions), ['issue:12:validate:csv-opens']);
});

test('a pending proposal holds the ask rather than raising a second one', async () => {
  const pending: Proposal = {
    id: 'prop-1',
    kind: 'validation_plan',
    ref: 'issue:12:validate-plan',
    status: 'pending',
    action: { type: 'propose_validation_plan', originRef: GOAL, issueNumber: 12 } as never,
    note: null,
    decidedBy: null,
    decidedAt: null,
    escalationId: 'esc-1',
    createdAt: NOW,
  };
  const decided = await new RuleDispatcher().decide(ctx({ proposals: [pending] }));
  assert.deepEqual(asks(decided.actions), []);
});

test('an empty set is proposed too — declaring nothing is the verdict worth a second pair of eyes', async () => {
  const decided = await new RuleDispatcher().decide(
    ctx({
      validationPlans: [record({ note: 'the suite settles it', emptyReason: 'area Exports asserts the file' })],
      validationChecks: [],
    }),
  );
  const ask = asks(decided.actions);
  assert.equal(ask.length, 1);
  assert.equal(ask[0]?.checks, 0);
  assert.deepEqual(ask[0]?.set, [], 'an empty set is proposed as an empty set');
});

test('accepting releases the set; rejecting takes the stamp off and leaves the rows to amend', async () => {
  const system = build();
  system.store.ingestValidation(GOAL, {
    checks: [
      {
        id: 'csv-opens',
        seq: 1,
        title: 'The export opens',
        do: 'Export.',
        expect: 'It opens.',
        uses: [],
        covers: [],
        fleetCandidate: false,
        candidateWhy: null,
      },
    ],
    resources: [],
    supersededReason: 'withdrawn',
    amendNote: '',
  });
  system.store.recordValidationAuthoring(GOAL, { note: 'two checks', emptyReason: null });
  const authored = system.store.getValidationPlanRecord(GOAL);
  assert.equal(authored?.releasedAt, null, 'authoring alone releases nothing');
  assert.equal(checkSetReleased({ record: authored, checks: system.store.listValidationChecks(GOAL) }), false);

  const released = system.store.releaseValidationPlan(GOAL);
  assert.ok(released?.releasedAt, 'the accept writes the release stamp');
  assert.equal(
    checkSetReleased({ record: released, checks: system.store.listValidationChecks(GOAL) }),
    true,
    'and from then on the bench rows are work',
  );

  const sentBack = system.store.withdrawValidationAuthoring(GOAL);
  assert.equal(sentBack?.authoredAt, null, 'a reject takes the stamp off');
  assert.equal(sentBack?.releasedAt, null);
  assert.deepEqual(
    system.store.listValidationChecks(GOAL).map((c) => [c.id, c.supersededReason]),
    [['csv-opens', null]],
    'the rows it wrote stay, so the next planner amends them rather than starting over',
  );
  assert.equal(
    checkSetAuthored({ record: sentBack, checks: system.store.listValidationChecks(GOAL) }),
    false,
    'and the validation planner is dispatchable again — a refused set nobody rewrites is the quiet failure',
  );
  system.store.close();
});

test('a set a plan document ingested before the gate reads as released, on both readers', () => {
  const checks = [check()];
  assert.equal(
    checkSetReleased({ record: null, checks }),
    true,
    'no record and real rows is a set an operator may be halfway through; holding it would stop every one of them',
  );
  assert.equal(
    checkSetReleased({ record: { ...record(), authoredAt: null, note: null }, checks }),
    true,
    'a hint-only record is the same set — the stamp is the authority only where the planner wrote one',
  );

  const arrival: GoalArrival = {
    goalRef: GOAL,
    environment: 'acceptance',
    arrivedAt: NOW,
    announcedAt: NOW,
    watchedAt: null,
    sheetedAt: null,
  };
  const considered = sheetableArrivals({
    arrivals: [arrival],
    environments: [{ name: 'acceptance', validate: { permits: ['state'] } } as never],
    authored: (goalRef) => checkSetReleased({ record: null, checks: goalRef === GOAL ? checks : [] }),
    probeIntervalMs: 60_000,
    now: Date.parse(NOW) + 1_000,
  });
  assert.deepEqual(
    considered.map((c) => c.assemble),
    [true],
    'so a sheet still assembles for it',
  );
});
