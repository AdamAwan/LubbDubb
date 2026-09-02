import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { MAX_RETRO_DOCUMENT, retroOrigin, retroSubmitOrigin, validateRetrospective } from '../src/retro/retro.js';
import { MAX_CLAIM_CHARS } from '../src/knowledge/knowledge.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import type { Agent, Issue, IssueDelivery } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { findTask } from './support/tasks.js';

/** The MCP tool-result shape, as a caller reads it off the wire. */
interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(overrides: Record<string, unknown> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-retro-'));
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
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** Spawn an agent on `originRef`. A temp cwd is enough — nothing here touches git. */
function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'desk',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: null,
    originRef,
    originTitle: 'Add a widget',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

// -- the row -----------------------------------------------------------------

test('a retrospective upserts on the issue and lists as an origin', () => {
  const store = new Store(':memory:');
  assert.equal(store.getRetrospective('issue:12'), null);
  assert.deepEqual(store.listRetrospectiveOrigins(), []);

  const first = store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Delivered in three parts; two agents were spent on a red base.',
    document: '# What shipped\n\n...',
    agentId: 'a1',
    taskId: 't1',
  });
  const second = store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Revised summary.',
    document: '# What shipped\n\nrevised',
    agentId: 'a1',
    taskId: 't1',
  });

  assert.deepEqual(store.listRetrospectiveOrigins(), ['issue:12'], 'a second submission revises one row');
  assert.equal(store.getRetrospective('issue:12')?.summary, 'Revised summary.');
  assert.equal(second.createdAt, first.createdAt, 'the row still dates when the run was first written up');
  assert.ok(second.updatedAt >= first.updatedAt);
  store.close();
});

// -- the pure layer ----------------------------------------------------------

test('the retro origin is its own, and only a retro agent may submit', () => {
  assert.equal(retroOrigin(12), 'issue:12:retro');
  assert.deepEqual(retroSubmitOrigin('issue:12:retro'), { ok: true, issueOrigin: 'issue:12' });
  for (const other of ['issue:12', 'issue:12:part:schema', 'issue:12:assess', 'pr:42:ci', 'job:j1', null]) {
    const refused = retroSubmitOrigin(other);
    assert.equal(refused.ok, false, `${other} must not write an issue's retrospective`);
    if (refused.ok) continue;
    // Refused by name, and pointed at the tool it actually wants.
    assert.match(refused.error, /conclude_work|conclude_part/);
  }
});

test('a retrospective needs a summary and keeps an over-long document, trimmed', () => {
  assert.equal(validateRetrospective({ document: 'x' }).ok, false, 'a document with no summary is refused');
  assert.equal(validateRetrospective({ summary: 'ok' }).ok, false, 'a summary with no document is refused');
  const long = validateRetrospective({ summary: 'ok', document: 'y'.repeat(MAX_RETRO_DOCUMENT + 10) });
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.trimmed, true);
  assert.equal(long.document.length, MAX_RETRO_DOCUMENT);
});

// -- the tool ----------------------------------------------------------------

test('only the retro agent may submit, and a second call revises one row', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:12:retro');

  const first = await callTool(system, retro, 'retro_submit', {
    summary: 'Three parts, one red base, two agents spent on somebody else’s CI.',
    document: '# What shipped\n\nThe schema part and the dispatcher part.',
  });
  assert.equal(first.isError, false);
  assert.match(system.store.getRetrospective('issue:12')?.document ?? '', /schema part/);

  const again = await callTool(system, retro, 'retro_submit', {
    summary: 'Revised.',
    document: '# What shipped\n\nRevised.',
  });
  assert.equal(again.isError, false);
  assert.deepEqual(system.store.listRetrospectiveOrigins(), ['issue:12'], 'a revision is one row, not two');
  assert.equal(system.store.getRetrospective('issue:12')?.summary, 'Revised.');

  // The agent that did the work cannot write the account of it.
  const worker = spawnAgent(system, 'issue:12');
  const refused = await callTool(system, worker, 'retro_submit', { summary: 'mine', document: 'mine' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /conclude_work/);
  system.store.close();
});

test('a submission with no summary is refused, and an over-long document is kept', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:9:retro');

  const noSummary = await callTool(system, retro, 'retro_submit', { document: 'the whole story' });
  assert.equal(noSummary.isError, true);
  assert.equal(system.store.getRetrospective('issue:9'), null, 'a refused submission lands nowhere');

  const long = await callTool(system, retro, 'retro_submit', {
    summary: 'ok',
    document: 'z'.repeat(MAX_RETRO_DOCUMENT + 10),
  });
  assert.equal(long.isError, false);
  assert.match(long.text, /"trimmed":\s*true/);
  assert.equal(system.store.getRetrospective('issue:9')?.document.length, MAX_RETRO_DOCUMENT);
  system.store.close();
});

// -- lessons (issue #355 phase 2) ---------------------------------------------

test('lessons are optional, bounded, and dropped rather than trimmed', () => {
  const none = validateRetrospective({ summary: 'ok', document: 'd' });
  assert.equal(none.ok, true);
  if (!none.ok) return;
  // A run that taught nothing general is the ordinary case, and it must not be a
  // refusal: the write-up is the thing at stake.
  assert.deepEqual(none.lessons, []);
  assert.equal(none.lessonsDropped, 0);
  assert.deepEqual(validateRetrospective({ summary: 'ok', document: 'd', lessons: 'not a list' }).ok, true);

  const parsed = validateRetrospective({
    summary: 'ok',
    document: 'd',
    lessons: ['  The suite wants a built web bundle first.  ', '', 'x'.repeat(MAX_CLAIM_CHARS + 1), 42],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // The over-long one is *gone*, not truncated: half a lesson is a different
  // claim, still promotable, and the gate is a person reading the claim.
  assert.deepEqual(parsed.lessons, ['The suite wants a built web bundle first.']);
  assert.equal(parsed.lessonsDropped, 3, 'an empty, an over-long and a non-string each count as a drop');
});

test('the lesson count is capped, and the overflow is counted rather than silent', () => {
  const parsed = validateRetrospective({
    summary: 'ok',
    document: 'd',
    lessons: Array.from({ length: 9 }, (_, i) => `lesson ${i}`),
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.ok(parsed.lessons.length < 9, 'a write-up that files nine has stopped discriminating');
  assert.equal(parsed.lessonsDropped, 9 - parsed.lessons.length);
  assert.deepEqual(parsed.lessons[0], 'lesson 0', 'the ones it led with are the ones it keeps');
});

test('a retro files its lessons as proposals against the goal it wrote up', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:12:retro');

  const filed = await callTool(system, retro, 'retro_submit', {
    summary: 'Three parts, one red base.',
    document: '# What shipped\n\nThe schema part.',
    lessons: ['The suite wants a built web bundle first.', 'Tickets naming only a symptom under-specify a planner.'],
  });
  assert.equal(filed.isError, false);
  assert.match(filed.text, /"lessonsFiled":\s*2/);

  const claims = system.store.listFacts();
  assert.equal(claims.length, 2);
  for (const claim of claims) {
    // The gate, asserted from the writer's side: an agent's own claim lands a
    // `proposal` and there is no argument it can pass to land it anywhere else.
    assert.equal(claim.reach, 'proposal');
    assert.equal(claim.scope, 'fleet');
    // Provenance is the goal, not the retro origin: the goal is what taught it,
    // and `issue:12:retro` is an implementation detail of who wrote it down —
    // which is `corroborationGoal`'s collapse, applied here like everywhere else.
    assert.equal(claim.originRef, 'issue:12');
    // And the corroboration says where it came from, because a retrospective has
    // no separate observation to give: the write-up beside it is the observation.
    assert.match(system.store.listCorroborations(claim.id)[0]!.words, /retrospective/);
  }
  system.store.close();
});

test('a resubmission revises the write-up without doubling its lessons', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:12:retro');
  const lessons = ['The suite wants a built web bundle first.'];

  await callTool(system, retro, 'retro_submit', { summary: 'first', document: 'first', lessons });
  const again = await callTool(system, retro, 'retro_submit', { summary: 'revised', document: 'revised', lessons });

  assert.equal(again.isError, false);
  assert.equal(system.store.getRetrospective('issue:12')?.summary, 'revised', 'the document is upserted');
  // `claimsMatch` is what folds the second submission's claim onto the first's row
  // — the matching every writer gets now, rather than the exact-text dedupe on one
  // goal `proposeLesson` did.
  assert.equal(system.store.listFacts().length, 1, 'the lessons are not appended a second time');
  // Told the truth about what the operator will see, rather than "0 filed" — which
  // would read as two of them having failed.
  assert.match(again.text, /"lessonsFiled":\s*1/);
  system.store.close();
});

test('a submission whose lessons are all refused still lands its write-up', async () => {
  const system = build();
  const retro = spawnAgent(system, 'issue:9:retro');

  const filed = await callTool(system, retro, 'retro_submit', {
    summary: 'ok',
    document: 'the whole story',
    lessons: ['y'.repeat(MAX_CLAIM_CHARS + 1)],
  });
  assert.equal(filed.isError, false, 'a lesson that does not fit never sinks the retrospective');
  assert.match(filed.text, /"lessonsDropped":\s*1/, 'and the drop is named rather than silent');
  assert.match(system.store.getRetrospective('issue:9')?.document ?? '', /whole story/);
  assert.deepEqual(system.store.listFacts(), []);
  system.store.close();
});

test('a working agent cannot file a lesson through the retro tool', async () => {
  const system = build();
  const worker = spawnAgent(system, 'issue:12');
  const refused = await callTool(system, worker, 'retro_submit', {
    summary: 'mine',
    document: 'mine',
    lessons: ['I should be able to tell the fleet things.'],
  });
  assert.equal(refused.isError, true);
  assert.deepEqual(system.store.listFacts(), [], 'the origin check gates the lessons with the document');
  system.store.close();
});

// -- rule `issue-retro` -----------------------------------------------------------------

const NOW = '2026-07-30T12:00:00.000Z';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: 'please add the thing',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function delivered(number = 12): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: 'every part merged',
    detail: null,
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: NOW,
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
    ...over,
  };
}

/** The dispatcher with the retrospective on — everything else default. */
function writer(): RuleDispatcher {
  return new RuleDispatcher();
}

function retroDispatches(actions: { type: string }[]): string[] {
  return actions
    .filter((a) => a.type.startsWith('dispatch_'))
    .map((a) => ('originRef' in a ? ((a as { originRef?: string | null }).originRef ?? '') : ''))
    .filter((o) => o.endsWith(':retro'));
}

test('a delivered goal with no retrospective gets one desk agent', async () => {
  const plan = await writer().decide(ctx({ deliveries: [delivered()] }));
  assert.deepEqual(retroDispatches(plan.actions), ['issue:12:retro']);
  const action = plan.actions.find((a) => 'originRef' in a && a.originRef === 'issue:12:retro');
  assert.equal(action?.type, 'dispatch_desk_agent', 'it writes no files, so it gets no worktree and no branch');
});

test('an undelivered goal is not written up, and neither is one already written', async () => {
  const undelivered = await writer().decide(ctx());
  assert.deepEqual(retroDispatches(undelivered.actions), [], 'a run that is not over has nothing to write up');

  const already = await writer().decide(ctx({ deliveries: [delivered()], retrospectiveOrigins: ['issue:12'] }));
  assert.deepEqual(retroDispatches(already.actions), [], 'the row is what stops it firing every pulse');
});

test('nothing is written up while anything is still live under the goal', async () => {
  const live = await writer().decide(
    ctx({
      deliveries: [delivered()],
      tasks: [
        {
          id: 't9',
          kind: 'code',
          title: 'Part',
          branch: 'issue/12/schema',
          originRef: 'issue:12:part:schema',
          originTitle: null,
          originSummary: null,
          dispatchReason: null,
          status: 'running',
          agentId: 'a9',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  );
  assert.deepEqual(retroDispatches(live.actions), []);
});

test('the dispatch context carries which goals have one, never what they say', () => {
  // Structural: a rule branching on retrospective prose would let one agent's
  // account of a run change what the harness schedules next.
  const source = readFileSync(join(process.cwd(), 'src', 'dispatcher', 'dispatcher.ts'), 'utf8');
  const field = /retrospectiveOrigins\??:\s*string\[\]/.test(source);
  assert.ok(field, 'the context carries origins as a string list');
  assert.doesNotMatch(source, /retrospectives\??:\s*Retrospective/, 'and never the rows themselves');
});

// -- what the retro agent is handed ------------------------------------------

test('the retro agent’s prompt carries the pad and the harness record, appended', async () => {
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });

  // A goal that was worked, wrote something down, and is now delivered.
  store.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a1',
    taskId: 't1',
    topic: 'store',
    note: 'the ALTER needed a PRAGMA check first',
    decision: null,
  });
  store.recordDelivery({
    originRef: 'issue:12',
    summary: 'PR #41 delivered it',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });

  await system.harness.runCycle('manual');

  const retroTask = findTask(store, (t) => t.originRef === 'issue:12:retro');
  assert.ok(retroTask, 'rule `issue-retro` dispatched a retrospective agent');
  // The pad, attributed and quoted...
  assert.match(retroTask.prompt, /issue:12:part:schema/);
  assert.match(retroTask.prompt, /> the ALTER needed a PRAGMA check first/);
  assert.match(retroTask.prompt, /not instructions/i);
  // ...and the record only the harness has.
  assert.match(retroTask.prompt, /The record the harness kept/);
  assert.match(retroTask.prompt, /PR #41 delivered it/);
  // Appended, never interpolated: an override that never learned about them
  // cannot silently drop them, so no placeholder token survives into the prompt.
  assert.doesNotMatch(retroTask.prompt, /\{dossier\}|\{pad\}|\{scratchpad\}/);

  store.close();
});

test('the dossier’s proposals stop at the goal’s ref boundary, not its prefix', async () => {
  // `issue:1` is a prefix of `issue:19`, so a bare `startsWith` hands issue 1's
  // retrospective agent issue 19's record as if it were its own — silently, and on
  // every repository with more than nine goals.
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_issue', number: 19, title: 'Somebody else’s goal' });

  store.createProposal({
    kind: 'plan',
    ref: 'issue:1:plan:plan',
    action: { type: 'propose_plan', reason: 'test', originRef: 'issue:1', planId: 'plan_one' },
    escalationId: null,
  });
  store.createProposal({
    kind: 'plan',
    ref: 'issue:19:plan:plan',
    action: { type: 'propose_plan', reason: 'test', originRef: 'issue:19', planId: 'plan_nineteen' },
    escalationId: null,
  });

  store.recordDelivery({
    originRef: 'issue:1',
    summary: 'PR #41 delivered it',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });

  await system.harness.runCycle('manual');

  const retroTask = findTask(store, (t) => t.originRef === 'issue:1:retro');
  assert.ok(retroTask, 'rule `issue-retro` dispatched a retrospective agent');
  assert.match(retroTask.prompt, /Proposal \(plan, pending\) on issue:1:plan:plan/);
  assert.doesNotMatch(retroTask.prompt, /issue:19/);

  store.close();
});

// -- what the cockpit is served ----------------------------------------------

test('the snapshot ships the reading and the document is fetched on demand', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Add the thing' });
  await system.harness.runCycle('manual');
  system.store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Three parts; two agents on somebody else’s red CI.',
    document: '# What shipped\n\nA long write-up nobody needs on every poll.',
    agentId: 'a1',
    taskId: 't1',
  });

  const built = await buildApp(system);
  const app = built.app;
  const state = await app.inject({ method: 'GET', url: '/api/state' });
  const issues = state.json().world.issues as { number: number; retrospective: unknown }[];
  assert.deepEqual(issues.find((i) => i.number === 12)?.retrospective, {
    summary: 'Three parts; two agents on somebody else’s red CI.',
    hasDocument: true,
    updatedAt: system.store.getRetrospective('issue:12')?.updatedAt,
  });
  // The snapshot is polled continuously, so the writing itself must not ride on it.
  assert.doesNotMatch(state.body, /A long write-up nobody needs/);

  const one = await app.inject({ method: 'GET', url: '/api/retrospectives/issue:12' });
  assert.equal(one.statusCode, 200);
  assert.match(one.json().retrospective.document, /A long write-up nobody needs/);

  const none = await app.inject({ method: 'GET', url: '/api/retrospectives/issue:99' });
  assert.equal(none.json().retrospective, null, 'an unwritten goal is null, not a 404');

  await app.close();
  system.store.close();
});

// -- what the dossier gathers, and what it is bounded by -----------------------

/**
 * The pair the dossier's caps and its scoping are both about: a goal, and a fleet
 * busy around it. `issue:19` is the boundary case `mine` exists for — `issue:1` is
 * a prefix of it — so the noise is filed there rather than on some far-off number.
 */
function busyFleet(system: System, rows: number): void {
  for (let i = 0; i < rows; i++) {
    system.store.recordDecision({
      cycleId: `cycle_other_${i}`,
      action: { type: 'dispatch_code_agent', reason: 'test', originRef: 'issue:19' } as never,
      outcome: 'executed',
      detail: `somebody else’s decision ${i}`,
    });
    system.store.proposeFact(
      {
        claim: `somebody else’s claim ${i}, which is nothing to do with the goal being written up.`,
        scope: 'fleet',
        lifetime: 'standing',
        expiresInHours: null,
        evidence: 'saw it',
        supersedes: null,
        resolvesWhen: null,
        aboutRef: null,
        where: null,
      },
      { agentId: null, taskId: null, goalRef: 'issue:19', sessionId: null, words: 'saw it' },
    );
  }
}

test('the harness’s own asks reach the dossier, and stop at the goal’s ref boundary', async () => {
  // An escalation the *harness* raises — the plan approval and the shortfall ask —
  // carries no `taskId` at all, so selecting on the task alone dropped the two most
  // consequential human decisions a goal ever produces, into a section that renders
  // perfectly well without them.
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_issue', number: 19, title: 'Somebody else’s goal' });

  const mine = system.escalations.create({
    type: 'approve_change',
    prompt: 'Approve this plan? It splits the work three ways.',
    context: { originRef: 'issue:1', planId: 'plan_one' },
  });
  store.answerEscalation(mine.id, 'Rejected: the split is wrong — one part, not three');
  system.escalations.create({
    type: 'approve_change',
    prompt: 'Approve somebody else’s plan?',
    context: { originRef: 'issue:19', planId: 'plan_nineteen' },
  });

  store.recordDelivery({
    originRef: 'issue:1',
    summary: 'PR #41 delivered it',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });

  await system.harness.runCycle('manual');

  const retroTask = findTask(store, (t) => t.originRef === 'issue:1:retro');
  assert.ok(retroTask, 'rule `issue-retro` dispatched a retrospective agent');
  // The question put to the operator, and its type — neither of which the proposal
  // row carries, since a proposal holds only the answer.
  assert.match(retroTask.prompt, /Escalation \(approve_change, answered\): Approve this plan\?/);
  assert.match(retroTask.prompt, /the split is wrong/);
  assert.doesNotMatch(retroTask.prompt, /somebody else’s plan/, 'the origin match must not reopen the boundary');

  store.close();
});

test('a busy fleet does not erase a goal’s decisions and its claims', async () => {
  // Both reads were capped fleet-wide *before* the goal filter could run, so a
  // goal's rows survived only while nobody else wrote 200 on top of them — and the
  // decision section renders a confident denial rather than a short list.
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Add the thing' });
  system.connector.inject({ kind: 'new_issue', number: 19, title: 'Somebody else’s goal' });

  store.recordDecision({
    cycleId: 'cycle_mine',
    action: { type: 'dispatch_code_agent', reason: 'test', originRef: 'issue:1' } as never,
    outcome: 'deferred',
    detail: 'the decision this goal is about',
  });
  store.proposeFact(
    {
      claim: 'the retry loop never backs off, which is the claim this goal raised.',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'read it',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: null, taskId: null, goalRef: 'issue:1', sessionId: null, words: 'read it' },
  );
  busyFleet(system, 250);

  store.recordDelivery({
    originRef: 'issue:1',
    summary: 'PR #41 delivered it',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });

  await system.harness.runCycle('manual');

  const retroTask = findTask(store, (t) => t.originRef === 'issue:1:retro');
  assert.ok(retroTask, 'rule `issue-retro` dispatched a retrospective agent');
  assert.match(retroTask.prompt, /the decision this goal is about/);
  assert.doesNotMatch(retroTask.prompt, /No decisions are recorded against this issue/);
  assert.match(retroTask.prompt, /### Raised while working this/, 'the section is gated on the list being non-empty');
  assert.match(retroTask.prompt, /the retry loop never backs off/);
  assert.doesNotMatch(retroTask.prompt, /somebody else’s/, 'a goal-scoped read is scoped, not merely bigger');

  store.close();
});

test('the dossier’s caps keep the newest rows of every list it bounds', async () => {
  // The caps keep the *tail*, and the store's reads are newest-first, so a list
  // handed over unreversed kept the oldest rows — under a note saying it had
  // dropped exactly those. A table over the three lists, so a fourth added later
  // has to declare its end.
  const system = build();
  const { store } = system;
  system.connector.inject({ kind: 'new_issue', number: 1, title: 'Add the thing' });

  for (let i = 0; i < 20; i++) {
    system.escalations.create({
      type: 'answer_question',
      prompt: `ESCALATION-${String(i).padStart(2, '0')}`,
      context: { originRef: 'issue:1' },
    });
    store.createProposal({
      kind: 'plan',
      ref: `issue:1:plan:p${String(i).padStart(2, '0')}`,
      action: { type: 'propose_plan', reason: 'test', originRef: 'issue:1', planId: `plan_${i}` },
      escalationId: null,
    });
    store.proposeFact(
      {
        claim: `CLAIM-${String(i).padStart(2, '0')} is a thing an agent noticed on the way past.`,
        scope: 'fleet',
        lifetime: 'standing',
        expiresInHours: null,
        evidence: 'saw it',
        supersedes: null,
        resolvesWhen: null,
        aboutRef: null,
        where: null,
      },
      { agentId: null, taskId: null, goalRef: 'issue:1', sessionId: null, words: 'saw it' },
    );
  }

  store.recordDelivery({
    originRef: 'issue:1',
    summary: 'PR #41 delivered it',
    by: 'assessor',
    agentId: null,
    taskId: null,
  });

  await system.harness.runCycle('manual');

  const retroTask = findTask(store, (t) => t.originRef === 'issue:1:retro');
  assert.ok(retroTask, 'rule `issue-retro` dispatched a retrospective agent');
  const kept: [string, string, number, number][] = [
    // list, row prefix, how many the cap keeps, what the note says was dropped
    ['escalations', 'ESCALATION-', 12, 8],
    ['proposals', 'issue:1:plan:p', 12, 8],
    ['claims', 'CLAIM-', 15, 5],
  ];
  for (const [noun, prefix, max, dropped] of kept) {
    for (let i = 20 - max; i < 20; i++) {
      assert.match(
        retroTask.prompt,
        new RegExp(`${prefix}${String(i).padStart(2, '0')}`),
        `the newest ${noun} are the ones a cap keeps`,
      );
    }
    for (let i = 0; i < 20 - max; i++) {
      assert.doesNotMatch(retroTask.prompt, new RegExp(`${prefix}${String(i).padStart(2, '0')}`));
    }
    assert.match(
      retroTask.prompt,
      new RegExp(`${dropped} of the 20 ${noun} are not shown here — the earliest went first`),
      'and the note names what actually went',
    );
  }

  store.close();
});
