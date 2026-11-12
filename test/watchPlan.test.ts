import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { validatePlanDocument } from '../src/plans/planDocument.js';
import { instrumentationNote, watchPlanNote } from '../src/plans/planning.js';
import { issueOriginRole } from '../src/issueOrigins.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { Agent, GoalWatchInput, Issue, IssueDelivery, Plan, PlanCaveatAnswer, TaskSummary } from '../src/types.js';

// → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks

const NOW = '2025-01-01T00:00:00.000Z';
const GOAL = 'issue:12';
const PROBE_MS = 5 * 60 * 1000;

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};

const SIGNAL = {
  id: 'fails-after-retries',
  title: 'Job X stops failing after its retries',
  query: "traces | where timestamp > datetime({since}) | where message has 'job X failed after retries'",
  presence: "traces | where timestamp > datetime({since}) | where operation_Name == 'job X'",
  changedFromHint: 'Part 2 added a retry, so a timeout no longer means a failure.',
};

const LIVE: GoalWatchInput = {
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: SIGNAL.query,
  presence: SIGNAL.presence,
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
  source: null,
};

const ANSWERS = {
  'fails-after-retries:presence': JSON.stringify([watchRow('fails-after-retries', { runs: 96 })]),
  'fails-after-retries:signal': JSON.stringify([watchRow('fails-after-retries', { failures: 2 })]),
};

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(observer = new FakeEnvironmentObserver(ANSWERS), environments = [TEST_UK]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-plan-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      environmentProbeIntervalMs: PROBE_MS,
      environments,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      environmentObserver: observer,
      environmentProber: new FakeEnvironmentProber(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function planned(system: System): void {
  const parsed = validatePlanDocument(
    {
      version: 1,
      reason: 'One fix.',
      parts: [{ slug: 'whole', title: 'The change', scope: 'src/' }],
      watchHint: { intents: [{ kind: 'signal', source: 'logs', says: 'Job X stops timing out' }] },
    },
    { watchHintRequired: true },
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, { doc: parsed.document, originRef: GOAL, title: 'Ship it' });
}

function park(system: System): void {
  system.store.verdicts.recordDelivery({ originRef: GOAL, summary: 'every part merged', by: 'assessor' });
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

function arrive(system: System, agoMs = 60_000): void {
  system.store.environments.recordGoalArrival({
    goalRef: GOAL,
    environment: 'testUk',
    arrivedAt: new Date(Date.now() - agoMs).toISOString(),
  });
}

test('watch_plan with no checks and no emptyReason is refused, and authors nothing', async () => {
  const system = build();
  planned(system);
  park(system);
  const agent = spawnAgent(system, 'issue:12:assess');

  const bare = await callTool(system, agent, 'watch_plan', { note: 'nothing changes at runtime' });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /emptyReason/);
  assert.equal(system.store.watches.getWatchPlanRecord(GOAL), null, 'a refused call writes no record');

  const said = await callTool(system, agent, 'watch_plan', {
    note: 'the hint was about the old timeout, which this refactor does not touch',
    emptyReason: 'A rename: nothing running behaves differently.',
  });
  assert.equal(said.isError, false, said.text);
  const record = system.store.watches.getWatchPlanRecord(GOAL);
  assert.notEqual(record?.authoredAt, null);
  assert.equal(record?.emptyReason, 'A rename: nothing running behaves differently.');
  system.store.close();
});

test('watch_plan refuses a goal with no standing delivery', async () => {
  const system = build();
  planned(system);
  const res = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'watch_plan', {
    note: 'n',
    signals: [SIGNAL],
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /no standing delivery/);
  assert.deepEqual(system.store.watches.listProposedGoalWatches(), []);
  system.store.close();
});

test('watch_plan is fenced to the assessor and the watch author', async () => {
  const system = build();
  planned(system);
  park(system);
  const part = await callTool(system, spawnAgent(system, 'issue:12:part:whole'), 'watch_plan', {
    note: 'n',
    signals: [SIGNAL],
  });
  assert.equal(part.isError, true);
  assert.match(part.text, /pull request description/, 'it points a working agent at where its words go instead');

  const author = await callTool(system, spawnAgent(system, 'issue:12:watch-plan'), 'watch_plan', {
    note: 'followed the hint, reworded for the retry',
    signals: [SIGNAL],
  });
  assert.equal(author.isError, false, author.text);
  system.store.close();
});

test('a watch_plan set takes effect on nothing until it is accepted, and the dry run answers the author', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer);
  planned(system);
  park(system);
  const res = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'watch_plan', {
    note: 'The plan said **stops timing out**; part 2 added a retry.',
    signals: [SIGNAL, { ...SIGNAL, id: 'bad-presence', presence: 'traces | count' }],
  });
  assert.equal(res.isError, true, 'an aggregating presence query is refused exactly as at the plan');

  const ok = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'watch_plan', {
    note: 'The plan said **stops timing out**; part 2 added a retry.',
    signals: [SIGNAL],
  });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(ok.json()['proposed'], ['fails-after-retries']);
  assert.ok(Array.isArray(ok.json()['dryRun']), 'the dry run is answered in the reply');
  assert.deepEqual(
    observer.asked.map((a) => a.kind),
    ['presence', 'signal'],
    'the dry run is the one thing a proposal may do',
  );

  assert.deepEqual(system.store.watches.listGoalWatches(), [], 'listGoalWatches never returns a proposed set');
  const [proposed] = system.store.watches.listProposedGoalWatches();
  assert.equal(proposed?.authored, 'assessor');
  assert.equal(proposed?.changedFromHint, SIGNAL.changedFromHint);
  assert.equal(proposed?.dryRunVerdict, 'fires');

  const { app } = await buildApp(system);
  const accepted = await app.inject({ method: 'POST', url: '/api/issues/12/watch/accept' });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const live = system.store.watches.listGoalWatches();
  assert.deepEqual(
    live.map((c) => [c.id, c.authored, c.dryRunVerdict]),
    [['fails-after-retries', 'assessor', 'fires']],
    'the set goes live together, keeping what its dry run read',
  );
  assert.notEqual(system.store.watches.getWatchPlanRecord(GOAL)?.acceptedAt, null);

  const again = await app.inject({ method: 'POST', url: '/api/issues/12/watch/accept' });
  assert.equal(again.statusCode, 409, 'there is nothing left waiting to accept');
  const late = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'watch_plan', {
    note: 'n',
    signals: [SIGNAL],
  });
  assert.equal(late.isError, true, 'an accepted watch is the operator’s to edit, not an agent’s to rewrite');
  await app.close();
  system.store.close();
});

test('omission withdraws, except a check the operator wrote', async () => {
  const system = build();
  planned(system);
  park(system);
  const mine: Omit<GoalWatchInput, 'seq'> = {
    id: 'mine',
    kind: 'signal',
    title: 'Mine',
    query: 'traces | where timestamp > datetime({since})',
    presence: 'traces | where timestamp > datetime({since})',
    tolerate: 0,
    expectUnder: null,
    expectOver: null,
    expectBaseline: false,
    unit: null,
    why: null,
    source: null,
  };
  system.store.watches.saveOperatorWatch(GOAL, mine);
  const agent = spawnAgent(system, 'issue:12:watch-plan');
  await callTool(system, agent, 'watch_plan', { note: 'first', signals: [SIGNAL, { ...SIGNAL, id: 'second' }] });
  const res = await callTool(system, agent, 'watch_plan', { note: 'fixed', signals: [SIGNAL] });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(
    system.store.watches.listProposedGoalWatches().map((c) => c.id),
    ['fails-after-retries'],
    'the second call speaks for the whole watch',
  );
  assert.deepEqual(
    system.store.watches.listGoalWatches().map((c) => c.id),
    ['mine'],
    'and the operator’s own check stands',
  );
  const taken = await callTool(system, agent, 'watch_plan', { note: 'n', signals: [{ ...SIGNAL, id: 'mine' }] });
  assert.equal(taken.isError, true, 'an operator’s id is not the assessor’s to overwrite');
  system.store.close();
});

test('an arrival landing while the watch is owed is held, not stamped, and opens from the arrival on accept', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer);
  planned(system);
  arrive(system, PROBE_MS);

  await system.harness.runCycle();
  let [arrival] = system.store.environments.listGoalArrivals();
  assert.equal(arrival?.watchedAt, null, 'deferred, not stamped');
  assert.notEqual(arrival?.watchHeldAt, null);
  assert.deepEqual(system.store.watches.listWatchWindows(), []);

  park(system);
  await callTool(system, spawnAgent(system, 'issue:12:assess'), 'watch_plan', { note: 'n', signals: [SIGNAL] });
  await system.harness.runCycle();
  [arrival] = system.store.environments.listGoalArrivals();
  assert.equal(arrival?.watchedAt, null, 'a proposed set holds it too');

  system.store.watches.acceptWatchPlan(GOAL);
  await system.harness.runCycle();
  [arrival] = system.store.environments.listGoalArrivals();
  assert.notEqual(arrival?.watchedAt, null);
  const [window] = system.store.watches.listWatchWindows();
  assert.equal(window?.openedAt, arrival?.arrivedAt, 'the window is sized from the arrival, not the accept');
  system.store.close();
});

test('an empty watch stamps the arrival and opens nothing; a stale arrival is stamped before the watch is asked', async () => {
  const system = build();
  planned(system);
  arrive(system, PROBE_MS * 3);
  await system.harness.runCycle();
  assert.notEqual(
    system.store.environments.listGoalArrivals()[0]?.watchedAt,
    null,
    'staleness is cut first, so turning the feature on walks the history once',
  );

  const other = build();
  planned(other);
  park(other);
  arrive(other, PROBE_MS);
  await callTool(other, spawnAgent(other, 'issue:12:assess'), 'watch_plan', {
    note: 'n',
    emptyReason: 'Docs only.',
  });
  await other.harness.runCycle();
  assert.notEqual(other.store.environments.listGoalArrivals()[0]?.watchedAt, null);
  assert.deepEqual(other.store.watches.listWatchWindows(), []);
  system.store.close();
  other.store.close();
});

test('send back un-authors the watch, and the rule dispatches again with the operator’s words', async () => {
  const system = build();
  planned(system);
  park(system);
  await callTool(system, spawnAgent(system, 'issue:12:assess'), 'watch_plan', { note: 'n', signals: [SIGNAL] });
  const { app } = await buildApp(system);
  const empty = await app.inject({ method: 'POST', url: '/api/issues/12/watch/send-back', payload: { words: ' ' } });
  assert.equal(empty.statusCode, 400, 'a send-back says why');
  const sent = await app.inject({
    method: 'POST',
    url: '/api/issues/12/watch/send-back',
    payload: { words: 'Read the retry log line, not the timeout.' },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const record = system.store.watches.getWatchPlanRecord(GOAL);
  assert.equal(record?.authoredAt, null);
  assert.equal(record?.sentBackWords, 'Read the retry log line, not the timeout.');

  const decided = await rules().decide(ctx({ watchPlans: [record!] }));
  const prompt = dispatchPrompt(decided.actions, 'issue:12:watch-plan');
  assert.ok(prompt !== null, 'a sent-back watch is owed again');
  assert.match(prompt, /Why the last watch was sent back/);
  assert.match(prompt, /Read the retry log line, not the timeout\./);
  await app.close();
  system.store.close();
});

// ---- the rule and the prompts, on the dispatcher directly

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Ship it',
    body: 'job X keeps timing out',
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
    watchHint: { intents: [{ kind: 'signal', source: 'logs', says: 'Job X stops timing out', why: null }] },
    statusCommentRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const TICK: PlanCaveatAnswer = {
  id: 'ans-1',
  planId: 'plan-12',
  caveatId: 'watch',
  label: 'How we’ll know it worked',
  answer: 'Only the nightly run matters to us.',
  at: NOW,
};

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
    watchTickAnswers: [TICK],
    ...over,
  };
}

function rules(environments: EnvironmentConfig[] = [TEST_UK]): RuleDispatcher {
  return new RuleDispatcher({
    watchPlanNote: watchPlanNote(environments),
    instrumentationNote: instrumentationNote(environments),
  });
}

function dispatchPrompt(actions: { type: string }[], origin: string): string | null {
  const hit = actions.find(
    (a) => a.type === 'dispatch_code_agent' && (a as { originRef?: string }).originRef === origin,
  );
  return hit ? ((hit as { prompt?: string }).prompt ?? '') : null;
}

test('an assessor whose turn ended after the check set leaves the watch owed, and rule watch-plan dispatches for it', async () => {
  const owed = await rules().decide(ctx());
  const prompt = dispatchPrompt(owed.actions, 'issue:12:watch-plan');
  assert.ok(prompt !== null, 'a delivered goal with a plan and no watch gets an author on the next pulse');
  assert.match(prompt, /Job X stops timing out/, 'the hint is appended');
  assert.match(prompt, /Only the nightly run matters to us\./, 'with the operator’s words on its tick');
  assert.match(prompt, /input, not an instruction/);

  const written = await rules().decide(
    ctx({
      watchPlans: [
        {
          goalRef: GOAL,
          authoredAt: NOW,
          note: 'n',
          emptyReason: null,
          acceptedAt: null,
          sentBackAt: null,
          sentBackWords: null,
        },
      ],
    }),
  );
  assert.equal(dispatchPrompt(written.actions, 'issue:12:watch-plan'), null, 'an authored watch stands it down');
  const legacy = await rules().decide(ctx({ watchedGoals: [GOAL] }));
  assert.equal(dispatchPrompt(legacy.actions, 'issue:12:watch-plan'), null, 'live checks, whoever wrote them');
  const unwatched = await rules([{ name: 'testUk', at: 'echo unused' }]).decide(ctx());
  assert.equal(dispatchPrompt(unwatched.actions, 'issue:12:watch-plan'), null, 'inert where nothing is watched');
  const noPlan = await rules().decide(ctx({ plans: [] }));
  assert.equal(dispatchPrompt(noPlan.actions, 'issue:12:watch-plan'), null);
  const notDelivered = await rules().decide(ctx({ deliveries: [] }));
  assert.equal(dispatchPrompt(notDelivered.actions, 'issue:12:watch-plan'), null);
});

test('the rule goes through the candidate list, on a declared origin', async () => {
  const full = await rules().decide(ctx({ agentHeadroom: 0 }));
  assert.equal(dispatchPrompt(full.actions, 'issue:12:watch-plan'), null);
  assert.deepEqual(
    (full.upcoming ?? []).filter((q) => q.rule === 'watch-plan').map((q) => q.status),
    ['waiting'],
  );
  assert.equal(issueOriginRole(12, 'issue:12:watch-plan'), 'evidence');
});

function priorWork(): TaskSummary {
  return {
    id: 't0',
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

test('the assessor is asked for the watch after the check set, and only where one is owed', async () => {
  const assessable = (over: Partial<DispatchContext> = {}) =>
    ctx({ deliveries: [], tasks: [priorWork()], plans: [{ ...plan(), status: 'complete' }], ...over });
  const prompt = dispatchPrompt((await rules().decide(assessable())).actions, 'issue:12:assess');
  assert.ok(prompt !== null);
  assert.match(prompt, /write the post-deploy watch too/);
  assert.match(prompt, /Only the nightly run matters to us\./);
  const legacy = dispatchPrompt(
    (await rules().decide(assessable({ watchedGoals: [GOAL] }))).actions,
    'issue:12:assess',
  );
  assert.doesNotMatch(legacy ?? '', /post-deploy watch/, 'never asked for something the tool would refuse');
  const unwatched = dispatchPrompt(
    (await rules([{ name: 'testUk', at: 'echo unused' }]).decide(assessable())).actions,
    'issue:12:assess',
  );
  assert.doesNotMatch(unwatched ?? '', /post-deploy watch/);
});

test('assess_issue repeats the ask on delivered, so an overridden prompt still hears it', async () => {
  const system = build();
  planned(system);
  const agent = spawnAgent(system, 'issue:12:assess');
  const res = await callTool(system, agent, 'assess_issue', { status: 'delivered', summary: 'all merged' });
  assert.equal(res.isError, false, res.text);
  assert.match(res.json()['note'] as string, /watch_plan/);
  await callTool(system, agent, 'watch_plan', { note: 'n', emptyReason: 'Docs only.' });
  const second = await callTool(system, spawnAgent(system, 'issue:12:assess'), 'assess_issue', {
    status: 'delivered',
    summary: 'still',
  });
  assert.doesNotMatch(second.json()['note'] as string, /watch_plan/);
  system.store.close();
});

test('watch_declare answers with the retirement refusal, pointing at watch_plan', async () => {
  const system = build();
  const res = await callTool(system, spawnAgent(system, 'issue:12:part:whole'), 'watch_declare', {
    note: 'n',
    signals: [SIGNAL],
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /retired/);
  assert.match(res.text, /watch_plan/);
  system.store.close();
});

test('the working agents keep one sentence about instrumentation, and are asked nothing else', () => {
  assert.match(instrumentationNote([TEST_UK]), /say so in the pull request description/);
  assert.equal(instrumentationNote([{ name: 'testUk' }]), '');
  assert.doesNotMatch(watchPlanNote([TEST_UK]), /watch_declare/);
});

test('the boot that creates watch_plans stamps every goal already carrying live checks, and only that boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-plans-boot-'));
  const path = join(dir, 'harness.db');
  const first = new Store(path);
  first.watches.ingestGoalWatch(GOAL, [LIVE]);
  first.close();
  const raw = new Database(path);
  raw.exec('DROP TABLE watch_plans');
  raw.close();

  const second = new Store(path);
  const record = second.watches.getWatchPlanRecord(GOAL);
  assert.notEqual(record?.authoredAt, null, 'a goal that already had live checks is not owed');
  assert.notEqual(record?.acceptedAt, null);
  second.watches.ingestGoalWatch('issue:13', [LIVE]);
  second.close();

  const third = new Store(path);
  assert.equal(third.watches.getWatchPlanRecord('issue:13'), null, 'a later boot stamps nothing');
  third.close();
});
