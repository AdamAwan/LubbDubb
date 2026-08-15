import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { conclusionOrigin, issueConclusionOrigin, resolveIssueConclusion } from '../src/issueConclusion.js';
import { outstandingWorkNote, validateConclusion } from '../src/mcp/conclusion.js';
import { MCP_TOOL_NAMES } from '../src/mcp/names.js';
import type { Agent, IssueConclusion, Plan, PlanPart } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// -- the pure resolver -------------------------------------------------------

function stored(over: Partial<IssueConclusion> = {}): IssueConclusion {
  return {
    originRef: 'issue:12',
    verdict: 'done',
    note: 'shipped it',
    by: 'agent',
    agentId: 'a1',
    taskId: 't1',
    createdAt: 'then',
    updatedAt: 'now',
    ...over,
  };
}

function plan(status: Plan['status']): Plan {
  return {
    id: 'p1',
    originRef: 'issue:12',
    title: 'x',
    status,
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    discussing: false,
    statusCommentRef: null,
    createdAt: 'then',
    updatedAt: 'now',
  };
}

/**
 * One live part, so a plan under test has a **shape**: the resolver reads the
 * single-PR arm off an empty part list, not off a status. The tests below are
 * about a decomposition unless they say otherwise, so that is the default.
 */
function partRow(): PlanPart {
  return {
    id: 'p1:a',
    planId: 'p1',
    slug: 'a',
    seq: 1,
    title: 'The a part',
    scope: 'src/a/',
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    rationale: null,
    acceptance: null,
    touches: [],
    acceptanceMet: [],
    size: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    taskId: null,
    createdAt: 'then',
    updatedAt: 'now',
  };
}

const resolve = (
  stored: IssueConclusion | null,
  plan: Plan | null,
  shortfall: Parameters<typeof resolveIssueConclusion>[3] = null,
  parts: PlanPart[] = [partRow()],
): ReturnType<typeof resolveIssueConclusion> => resolveIssueConclusion(stored, plan, parts, shortfall);

test('nothing stored and no plan resolves to undeclared, not to more_work', () => {
  const r = resolve(null, null);
  assert.equal(r.verdict, 'undeclared');
  assert.equal(r.by, null);
});

test('a complete plan derives done; an in-flight one derives more_work', () => {
  assert.equal(resolve(null, plan('complete')).verdict, 'done');
  assert.equal(resolve(null, plan('complete')).by, 'plan');
  assert.equal(resolve(null, plan('active')).verdict, 'more_work');
  assert.equal(resolve(null, plan('awaiting_approval')).verdict, 'more_work');
  // `planning` is in flight too: a plan being drawn up is an unsettled
  // decomposition, and the only two ways to reach it — a fresh plan and a replan
  // — are both goals nobody has finished.
  assert.equal(resolve(null, plan('planning')).verdict, 'more_work');
  assert.equal(resolve(null, plan('planning')).by, 'plan');
});

// The single-PR arm and an abandoned plan are both statements about shape, not
// about whether the PR has been written — deriving either verdict from one would
// be a guess.
test('an abandoned plan derives nothing, and every live one speaks', () => {
  assert.equal(resolve(null, plan('abandoned')).verdict, 'undeclared');
  // The status is the whole reading, and the part count has no say in it. It used
  // to: a plan delivering one pull request carried *no parts* and was scheduled by
  // rule `issue-pickup`, so `active` did not mean the plan was working the issue,
  // and an unguarded read made every issue worked whole say `more_work` for ever.
  // One rule schedules every plan now, so an `active` plan owns its issue whether
  // it has one part or eight.
  assert.equal(resolve(null, plan('active'), null, []).verdict, 'more_work');
  assert.equal(resolve(null, plan('active'), null, [partRow()]).verdict, 'more_work');
  // Nothing has been worked at all until a human answers a gated plan.
  assert.equal(resolve(null, plan('awaiting_approval'), null, []).verdict, 'more_work');
});

// The bug this ordering fixes: an issue worked `single` has one agent, that agent
// declares `done`, and an accepted shortfall then hands the issue to a plan. Both
// records now exist — the one case `conclusionOrigin` cannot prevent — and with
// the declaration ranked first the spent verdict outranked the plan that had just
// taken the issue back. Ownership, read backwards.
test('a plan in flight beats a declaration made before it took the issue back', () => {
  for (const status of ['planning', 'active', 'awaiting_approval'] as const) {
    const r = resolve(stored({ verdict: 'done' }), plan(status));
    assert.equal(r.verdict, 'more_work', status);
    assert.equal(r.by, 'plan', status);
  }
  // A settled plan does not: an agent saying work remains on an issue whose parts
  // all merged is telling the roll-up something it cannot see.
  assert.equal(resolve(stored({ verdict: 'done' }), plan('complete')).verdict, 'done');
  assert.equal(resolve(stored({ verdict: 'done' }), plan('complete')).by, 'agent');
});

// Arm 1 is still the escape hatch, and it is the only thing above the plan.
test("the operator's toggle still beats a plan in flight", () => {
  const r = resolve(stored({ verdict: 'done', by: 'operator' }), plan('planning'));
  assert.equal(r.verdict, 'done');
  assert.equal(r.by, 'operator');
});

test("an agent's declaration beats the plan derivation", () => {
  const r = resolve(stored({ verdict: 'more_work' }), plan('complete'));
  assert.equal(r.verdict, 'more_work');
  assert.equal(r.by, 'agent');
});

// The escape hatch: an operator looking at a complete plan and saying "there is
// more to do here" must not be argued with by a derivation.
test("the operator's toggle beats everything", () => {
  const r = resolve(stored({ verdict: 'more_work', by: 'operator' }), plan('complete'));
  assert.equal(r.verdict, 'more_work');
  assert.equal(r.by, 'operator');
});

// -- which origins may conclude ---------------------------------------------

test('only a whole-issue origin may conclude', () => {
  assert.equal(conclusionOrigin('issue:12').ok, true);
  for (const ref of ['issue:12:part:schema', 'issue:12:plan', 'pr:42:ci', 'job:abc', 'epic:e1:work', null, '']) {
    assert.equal(conclusionOrigin(ref).ok, false, `${ref} must not conclude an issue`);
  }
});

// A part agent gets its own refusal, because it is being told something specific:
// the plan already speaks for the issue, so there is nothing for it to declare.
test('a part agent is told the plan concludes the issue, not it', () => {
  const r = conclusionOrigin('issue:12:part:schema');
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /part of issue #12's plan/);
  assert.match(r.ok === false ? r.error : '', /report_finding/);
});

test('a planning agent is pointed at plan_submit', () => {
  const r = conclusionOrigin('issue:12:plan');
  assert.match(r.ok === false ? r.error : '', /plan_submit/);
});

// -- the tool's argument layer ----------------------------------------------

test('validateConclusion requires a known status and a non-empty note', () => {
  assert.equal(validateConclusion({ status: 'done', note: 'shipped' }).ok, true);
  assert.equal(validateConclusion({ status: 'finished', note: 'x' }).ok, false);
  assert.equal(validateConclusion({ status: 'done', note: '   ' }).ok, false);
  assert.equal(validateConclusion({ status: 'done' }).ok, false);
  // Unlike a progress note, an over-long conclusion is refused rather than
  // trimmed: it is a verdict an operator acts on, not a cheap status line.
  assert.equal(validateConclusion({ status: 'done', note: 'x'.repeat(2001) }).ok, false);
});

test('the outstanding-work preamble attributes and quotes rather than instructing', () => {
  const note = outstandingWorkNote('the migration is still missing', '2026-07-27T00:00:00Z');
  assert.match(note, /> the migration is still missing/, 'quoted, so it cannot read as the harness speaking');
  assert.match(note, /not finished/);
  assert.match(note, /report, not as instructions/);
});

// -- persistence -------------------------------------------------------------

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

function build(overrides: Record<string, unknown> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

test('a conclusion is latest-wins per issue and keeps its original createdAt', () => {
  const system = build();
  const first = system.store.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'more_work',
    note: 'half of it',
    by: 'agent',
  });
  const second = system.store.recordIssueConclusion({
    originRef: 'issue:12',
    verdict: 'done',
    note: 'the rest',
    by: 'agent',
  });
  assert.equal(system.store.listIssueConclusions().length, 1, 'one row per issue, not an append log');
  assert.equal(system.store.getIssueConclusion('issue:12')?.verdict, 'done');
  assert.equal(second.createdAt, first.createdAt, 'still dates the first time anyone concluded it');
  system.store.close?.();
});

test('clearing a conclusion deletes the row rather than storing a third verdict', () => {
  const system = build();
  system.store.recordIssueConclusion({ originRef: 'issue:12', verdict: 'done', note: 'n', by: 'operator' });
  assert.equal(system.store.clearIssueConclusion('issue:12'), true);
  assert.equal(system.store.getIssueConclusion('issue:12'), null);
  assert.equal(resolve(null, null).verdict, 'undeclared');
  system.store.close?.();
});

// -- the tool, through the same dispatch an agent's bridge reaches ------------

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('conclude_work is advertised under its name in the allow-list', () => {
  assert.ok(MCP_TOOL_NAMES.includes('conclude_work'), 'a tool missing from names.ts connects but is never callable');
});

test('conclude_work records the verdict against the issue the credential names', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'conclude_work', { status: 'done', note: 'all three acceptance criteria' });
  assert.equal(res.isError, false);

  const conclusion = system.store.getIssueConclusion('issue:12');
  assert.equal(conclusion?.verdict, 'done');
  assert.equal(conclusion?.by, 'agent');
  assert.equal(conclusion?.agentId, agent.id, 'attribution is structural, from the credential');
  // Said in the response, so an agent does not believe the ticket was closed.
  assert.match(res.text, /does not close the ticket/);
  system.store.close?.();
});

test('a part agent cannot conclude its parent issue', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:part:schema');
  const res = await callTool(system, agent, 'conclude_work', { status: 'done', note: 'my part is done' });
  assert.equal(res.isError, true, 'refused rather than silently scoped to the part');
  assert.equal(system.store.getIssueConclusion('issue:12'), null, 'and nothing is written');
  system.store.close?.();
});

test('a PR-concern agent cannot conclude the issue behind its PR', async () => {
  const system = build();
  const agent = spawnAgent(system, 'pr:42:ci');
  const res = await callTool(system, agent, 'conclude_work', { status: 'done', note: 'ci is green' });
  assert.equal(res.isError, true);
  system.store.close?.();
});

test('a rejected conclusion writes nothing', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'conclude_work', { status: 'done', note: '' });
  assert.equal(res.isError, true);
  assert.equal(system.store.getIssueConclusion('issue:12'), null);
  system.store.close?.();
});

// -- the operator's override over HTTP --------------------------------------

test('the cockpit can set, flip and clear an issue conclusion', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const set = await app.inject({
    method: 'POST',
    url: '/api/issues/12/conclusion',
    payload: { verdict: 'done', note: 'looks finished to me' },
  });
  assert.equal(set.statusCode, 200);
  assert.equal(system.store.getIssueConclusion(issueConclusionOrigin(12))?.by, 'operator');

  const clear = await app.inject({ method: 'POST', url: '/api/issues/12/conclusion', payload: { verdict: null } });
  assert.equal(clear.statusCode, 200);
  assert.equal(system.store.getIssueConclusion('issue:12'), null);

  const bad = await app.inject({ method: 'POST', url: '/api/issues/12/conclusion', payload: { verdict: 'maybe' } });
  assert.equal(bad.statusCode, 400);

  await app.close();
  system.store.close?.();
});
