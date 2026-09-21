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
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type {
  Agent,
  Issue,
  IssueDelivery,
  Plan,
  TaskSummary,
  ValidationCheck,
  ValidationPlanRecord,
} from '../src/types.js';

// → docs/spec/20-validation.md#the-authoring-gate

const NOW = '2025-01-01T00:00:00.000Z';

const GOAL = 'issue:12';

const CHECK = { id: 'csv-opens', title: 'The export opens in Excel', do: 'Export a report.', expect: 'It opens.' };

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** The deployment default: `validation.checkSets` unset, which is off. */
function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vgateoff-'));
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
    note: 'wrote one check against the merged importer',
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
    proof: null,
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
    ...over,
  };
}

function priorWork(): TaskSummary {
  return {
    id: 't-work',
    kind: 'code',
    title: 'Do it',
    branch: 'issue/12',
    originRef: GOAL,
    originTitle: 'Ship it',
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function originRefs(actions: { type: string }[], suffix: RegExp): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => suffix.test(o));
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Ship it',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

test('off, no goal is dispatched for a check set and no set is put to the operator', async () => {
  const d = new RuleDispatcher();

  const owed = await d.decide(ctx());
  assert.deepEqual(
    originRefs(owed.actions, /:validate-plan$/),
    [],
    'a delivered goal with no check set is left exactly as delivered',
  );

  const authored = await d.decide(ctx({ validationPlans: [record()], validationChecks: [check()] }));
  assert.deepEqual(
    authored.actions.filter((a) => a.type === 'propose_validation_plan'),
    [],
    'and a set written before the flag went off is put to nobody rather than sitting in the inbox',
  );
});

test('off, the assessor is not briefed to write one — neither the prompt nor the tool’s own answer', async () => {
  const assessable = ctx({ deliveries: [], tasks: [priorWork()], plans: [{ ...plan(), status: 'complete' }] });
  const decided = await new RuleDispatcher().decide(assessable);
  const assess = decided.actions.find(
    (a) => a.type === 'dispatch_code_agent' && (a as { originRef?: string }).originRef === 'issue:12:assess',
  );
  assert.ok(assess, 'the goal is still assessed — the gate is on authoring and nothing else');
  assert.doesNotMatch((assess as { prompt: string }).prompt, /write the check set too/);

  const system = build();
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });

  const res = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'assess_issue', {
    status: 'delivered',
    summary: 'every part is on the default branch',
  });
  assert.equal(res.isError, false, res.text);
  assert.doesNotMatch(
    res.json().note as string,
    /validation_plan/,
    'the tool’s answer is the fold an override cannot drop, so it has to fall silent here too',
  );

  const wrote = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'validation_plan', {
    note: 'followed the hint',
    checks: [CHECK],
  });
  assert.equal(wrote.isError, true, 'and the tool refuses rather than writing a set no rule would propose');
  assert.match(wrote.text, /validation\.checkSets/);
  assert.deepEqual(system.store.validation.listValidationChecks(GOAL), [], 'nothing was written');
  system.store.close();
});

test('off, a plan-time check set and the hand-over behind it are untouched', async () => {
  const system = build();
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    validation: { checks: [CHECK] },
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });

  assert.deepEqual(
    system.store.validation.listValidationChecks(GOAL).map((c) => [c.letter, c.state]),
    [['A', 'unrun']],
    'the gate is on what the fleet authors, so a set the plan document declared is ingested as ever',
  );

  const decided = await new RuleDispatcher().decide(ctx({ validationChecks: [check({ steps: [], actor: 'fleet' })] }));
  assert.deepEqual(
    originRefs(decided.actions, /:validate:/),
    ['issue:12:validate:csv-opens'],
    'and a check the operator handed to the fleet is still run — the flag withholds no reading',
  );
  system.store.close();
});
