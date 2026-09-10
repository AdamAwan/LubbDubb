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
import { sheetableArrivals } from '../src/environments/watchWindow.js';
import { validationPlanNote } from '../src/validation/authoring.js';
import { issueOriginRole } from '../src/issueOrigins.js';
import { phaseOf } from '../src/spendInsights.js';
import type { Agent, GoalArrival, Issue, IssueDelivery, Plan } from '../src/types.js';

// → docs/spec/20-validation.md#when-the-check-set-is-written

const NOW = '2025-01-01T00:00:00.000Z';

const GOAL = 'issue:12';

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-vauthor-'));
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

const CHECK = { id: 'csv-opens', title: 'The export opens in Excel', do: 'Export a report.', expect: 'It opens.' };

function ingest(system: System, validation: Record<string, unknown> | undefined): void {
  const parsed = validatePlanDocument({
    version: 1,
    reason: 'One fix.',
    parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
    ...(validation === undefined ? {} : { validation }),
  });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
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

function authoringDispatches(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.endsWith(':validate-plan'));
}

test('a plan document carrying a full check set is ingested exactly as it always was', () => {
  const system = build();
  ingest(system, { checks: [CHECK], resources: [{ name: 'fixture.tar.gz', kind: 'fixture' }] });

  const checks = system.store.listValidationChecks(GOAL);
  assert.deepEqual(
    checks.map((c) => [c.letter, c.id, c.state]),
    [['A', 'csv-opens', 'unrun']],
    'the rows are real and an operator may be halfway through them',
  );
  assert.deepEqual(
    system.store.listValidationResources(GOAL).map((r) => r.name),
    ['fixture.tar.gz'],
  );
  assert.equal(
    system.store.getValidationPlanRecord(GOAL)?.authoredAt,
    null,
    'and a legacy plan is not an authoring — nothing pretends the validation planner ran',
  );
  system.store.close();
});

test('a hint-only block writes the hint and withdraws nothing', () => {
  const system = build();
  ingest(system, { checks: [CHECK] });
  ingest(system, { hint: 'worth checking: the upload path against a real store' });

  assert.deepEqual(
    system.store.listValidationChecks(GOAL).map((c) => [c.id, c.supersededReason]),
    [['csv-opens', null]],
    'a hint is not an empty check set — re-reading it as one would delete a set somebody is using',
  );
  assert.equal(
    system.store.getValidationPlanRecord(GOAL)?.hint,
    'worth checking: the upload path against a real store',
  );
  system.store.close();
});

test('an explicit empty check set still withdraws every check, said out loud', () => {
  const system = build();
  ingest(system, { checks: [CHECK] });
  ingest(system, { checks: [] });

  assert.equal(
    system.store.listValidationChecks(GOAL)[0]?.supersededReason !== null,
    true,
    'withdrawing every check is "checks": [], which is the one reading of it that is honest',
  );
  system.store.close();
});

test('the rule dispatches for a delivered goal with no check set, and for nothing else', async () => {
  const d = new RuleDispatcher();

  const open = await d.decide(ctx({ deliveries: [] }));
  assert.deepEqual(authoringDispatches(open.actions), [], 'a goal that is not delivered has nothing to write against');

  const delivering = await d.decide(ctx());
  assert.deepEqual(
    authoringDispatches(delivering.actions),
    ['issue:12:validate-plan'],
    'the assessor writing `delivered` is the trigger',
  );

  const legacy = await d.decide(
    ctx({
      validationChecks: [
        {
          originRef: GOAL,
          id: 'csv-opens',
          letter: 'A',
          seq: 1,
          title: 'The export opens',
          do: 'Export.',
          expect: 'It opens.',
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
          state: 'unrun',
          resultNote: null,
          resultBy: null,
          resultAt: null,
          deferUntil: null,
          supersededReason: null,
          revision: null,
          amendedAt: null,
          amendNote: null,
          area: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  );
  assert.deepEqual(
    authoringDispatches(legacy.actions),
    [],
    'a goal already carrying checks is left alone, whoever wrote them',
  );

  const written = await d.decide(
    ctx({ validationPlans: [{ originRef: GOAL, hint: null, note: 'considered', emptyReason: 'x', authoredAt: NOW }] }),
  );
  assert.deepEqual(
    authoringDispatches(written.actions),
    [],
    'and an empty set that was authored is an answer, not a goal still waiting for one',
  );
});

test('the dispatch goes through the candidate list, so the headroom cut and the queue see it', async () => {
  const d = new RuleDispatcher();
  const full = await d.decide(ctx({ agentHeadroom: 0 }));
  assert.deepEqual(authoringDispatches(full.actions), [], 'no headroom, no dispatch');
  assert.deepEqual(
    (full.upcoming ?? []).filter((q) => q.rule === 'validation-plan').map((q) => q.status),
    ['waiting'],
    'an inline raw.push would bypass both — it is in the queue instead',
  );
});

test('the prompt appends the hint, the coverage part and the environments rather than interpolating them', async () => {
  const d = new RuleDispatcher();
  const decided = await d.decide(
    ctx({
      validationPlans: [
        {
          originRef: GOAL,
          hint: 'the upload path against a real store',
          note: null,
          emptyReason: null,
          authoredAt: null,
        },
      ],
      planParts: [
        {
          id: 'plan-12:suite',
          planId: 'plan-12',
          slug: 'suite',
          seq: 1,
          title: 'Cover the importer',
          scope: 'tests/',
          touches: [],
          rationale: null,
          acceptance: 'the area asserts the confirmation step',
          acceptanceMet: [],
          size: null,
          expectedKind: null,
          profile: null,
          coverage: 'Checkout Tests',
          outcomeKind: null,
          outcomeRef: null,
          outcomeSummary: null,
          dependsOn: [],
          branch: null,
          prNumber: null,
          status: 'merged',
          blockedReason: null,
          blockedBy: null,
          taskId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  );
  const dispatch = decided.actions.find((a) => a.type === 'dispatch_code_agent') as { prompt: string } | undefined;
  assert.ok(dispatch, 'a delivered goal with no check set gets an agent');
  assert.match(dispatch.prompt, /the upload path against a real store/, 'the hint reaches the agent');
  assert.match(dispatch.prompt, /Checkout Tests/, 'and so does what the coverage part built');
  assert.match(
    dispatch.prompt,
    /informs you rather than binding you/,
    'a coverage part informs the validation planner and emits no check of its own',
  );
});

test('the origin is classified, so it expands under a priority flag and its spend files as evidence', () => {
  assert.equal(issueOriginRole(12, 'issue:12:validate-plan'), 'evidence');
  assert.equal(phaseOf('issue:12:validate-plan'), 'evidence', 'left unclassified it would file under "other"');
});

test('validation_plan writes the whole set, with a note, and stamps the goal as authored', async () => {
  const system = build();
  ingest(system, { hint: 'the upload path' });
  const agent = spawnAgent(system, 'issue:12:validate-plan');

  const res = await callTool(system, agent, 'validation_plan', {
    note: 'the hint asked for the audit rows; the suite already asserts them, so this checks the upload only',
    checks: [CHECK],
  });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(
    system.store.listValidationChecks(GOAL).map((c) => [c.letter, c.id]),
    [['A', 'csv-opens']],
  );
  const record = system.store.getValidationPlanRecord(GOAL);
  assert.match(record?.note ?? '', /the suite already asserts them/, 'the departure from the hint is on the record');
  assert.notEqual(record?.authoredAt, null);
  assert.equal(record?.hint, 'the upload path', 'and writing the set does not un-write the plan’s intent');
  system.store.close();
});

test('an empty check set is refused without a reason and accepted with one', async () => {
  const system = build();
  ingest(system, { hint: 'the upload path' });
  const agent = spawnAgent(system, 'issue:12:validate-plan');

  const bare = await callTool(system, agent, 'validation_plan', { note: 'nothing needs a run' });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /carries a reason/);
  assert.equal(
    system.store.getValidationPlanRecord(GOAL)?.authoredAt,
    null,
    'a refused call authors nothing, so the sheet keeps waiting',
  );

  const reasoned = await callTool(system, agent, 'validation_plan', {
    note: 'followed the hint',
    emptyReason: 'area `Checkout Tests` now asserts the confirmation step and nothing else needs a run',
  });
  assert.equal(reasoned.isError, false, reasoned.text);
  const record = system.store.getValidationPlanRecord(GOAL);
  assert.match(record?.emptyReason ?? '', /Checkout Tests/, 'null with no account of itself is the failure');
  assert.notEqual(record?.authoredAt, null, 'and declaring nothing is a complete answer');
  system.store.close();
});

test('validation_plan is refused from any other origin, and validation_amend from this one', async () => {
  const system = build();
  ingest(system, { hint: 'the upload path' });

  const partAgent = spawnAgent(system, 'issue:12:part:whole');
  const wrongOrigin = await callTool(system, partAgent, 'validation_plan', { note: 'n', emptyReason: 'r' });
  assert.equal(wrongOrigin.isError, true);
  assert.match(wrongOrigin.text, /validation_amend/, 'it is pointed at the transport that speaks for one check');

  const planner = spawnAgent(system, 'issue:12:validate-plan');
  const amend = await callTool(system, planner, 'validation_amend', { note: 'n', checks: [CHECK] });
  assert.equal(amend.isError, true, 'two ways to say one thing that disagree about omission is the drift');
  assert.match(amend.text, /validation_plan/);
  system.store.close();
});

test('sheet assembly waits for the check set, and the staleness guard is cut first', () => {
  const now = Date.parse('2025-01-01T12:00:00.000Z');
  const environments = [{ name: 'acceptance', at: 'echo', validate: { permits: ['check' as const] } }];
  const arrival = (over: Partial<GoalArrival> = {}): GoalArrival => ({
    goalRef: GOAL,
    environment: 'acceptance',
    arrivedAt: new Date(now - 60_000).toISOString(),
    announcedAt: null,
    watchedAt: null,
    sheetedAt: null,
    ...over,
  });
  const call = (authored: boolean, over: Partial<GoalArrival> = {}) =>
    sheetableArrivals({
      arrivals: [arrival(over)],
      environments,
      authored: () => authored,
      probeIntervalMs: 5 * 60 * 1000,
      now,
    });

  assert.deepEqual(call(false), [], 'a fresh arrival with no check set is deferred, and left unstamped');
  assert.deepEqual(
    call(true).map((v) => v.assemble),
    [true],
    'and assembled once the set is written, however long that took',
  );
  assert.deepEqual(
    call(false, { arrivedAt: new Date(now - 60 * 60 * 1000).toISOString() }).map((v) => v.assemble),
    [false],
    'an arrival older than the guard is stamped and not assembled — the backfill guard is cut before authoring',
  );
});

test('the environment note lists what each environment can drive, and the areas its runner offered', () => {
  assert.equal(
    validationPlanNote([{ name: 'acceptance', validate: undefined }]),
    '',
    'nothing configured, nothing said',
  );
  const note = validationPlanNote(
    [{ name: 'acceptance', validate: { permits: ['check', 'state'], browser: { runner: 'npm test' } } }],
    [{ environment: 'acceptance', selector: 'Checkout Tests', tests: 4, listedAt: NOW }],
  );
  assert.match(note, /`Checkout Tests`/, 'the area is a pick from the runner’s own listing, copied exactly');
  assert.match(note, /No tenant is configured/, 'and a run that writes is told it has nowhere to write');
});
