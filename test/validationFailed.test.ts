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
    steps: [],
    capture: null,
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
    area: null,
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

function diagnoses(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.includes(':validate-failure:'));
}

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

  for (const state of ['unrun', 'passed', 'waived', 'deferred'] as ValidationCheckState[]) {
    const other = await runner().decide(ctx({ validationChecks: [check({ state, resultBy: null })] }));
    assert.deepEqual(diagnoses(other.actions), [], `a ${state} check is not a finding about the goal`);
  }

  const withdrawn = await runner().decide(ctx({ validationChecks: [check({ supersededReason: 'the screen went' })] }));
  assert.deepEqual(diagnoses(withdrawn.actions), []);
});

test('it is a read-only code agent on the default branch, in its own namespace', async () => {
  const decided = await runner().decide(ctx({ validationChecks: [check()] }));
  const action = decided.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:validate-failure:csv-opens');
  assert.equal(action?.type, 'dispatch_code_agent');
  const dispatch = action as unknown as { branch: string; base: string; readOnly?: boolean; prompt: string };
  assert.equal(dispatch.base, 'main');
  assert.equal(dispatch.branch, 'validate-failure/issue/12/csv-opens');
  assert.equal(dispatch.readOnly, true);
  assert.match(dispatch.prompt, /Export a report and open it\./);
  assert.match(dispatch.prompt, /columns are shifted one to the right/);
  assert.match(dispatch.prompt, /A person ran it/);
});

test('a goal that is not delivered, and a check somebody is re-running, are left alone', async () => {
  const inFlight = await runner().decide(ctx({ deliveries: [], validationChecks: [check()] }));
  assert.deepEqual(diagnoses(inFlight.actions), []);

  const claimed = await runner().decide(ctx({ validationChecks: [check({ claimedBy: 'laptop', claimedAt: NOW })] }));
  assert.deepEqual(diagnoses(claimed.actions), []);
});

test('each reading gets its own attempt budget', async () => {
  const spent = [
    attempt(ORIGIN, '2025-01-01T09:00:00.000Z'),
    attempt(ORIGIN, '2025-01-01T09:30:00.000Z'),
    attempt(ORIGIN, '2025-01-01T10:00:00.000Z'),
  ];
  const again = await runner().decide(ctx({ recentDecisions: spent, validationChecks: [check()] }));
  assert.deepEqual(diagnoses(again.actions), ['issue:12:validate-failure:csv-opens']);

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

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /validation_amend/);
  const after = system.store.listValidationChecks('issue:12').find((c) => c.id === 'csv-opens');
  assert.equal(after?.state, 'unrun', 'nothing was recorded');
});
