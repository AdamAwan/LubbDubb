import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import {
  amendmentProposal,
  contradictionRatio,
  corroborationGoal,
  distinctCorroborators,
  MAX_CLAIM_CHARS,
  MAX_EVIDENCE_CHARS,
  questionScore,
  resolveFactScope,
  validateContradiction,
  validateFactProposal,
  type FactProposal,
} from '../src/knowledge/knowledge.js';
import { buildViewModel } from '../web/src/view/viewModel.js';
import { NOWHERE, placeQuery, readPlace } from '../web/src/cockpit/place.js';
import type { AppState } from '../web/src/types.js';
import type { Agent, FactObservation, KnowledgeFact } from '../src/types.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { StreamChild } from '../src/agents/streamJsonSession.js';
import { failPlanningOpen } from './support/plans.js';

/**
 * Knowledge, phase 1 (docs/spec/27-knowledge.md): the store, the three axes, and
 * the two tools that write to and read from it.
 *
 * Most of what is asserted here is **negative**, and deliberately: this is a store
 * whose failure mode is a claim reaching every agent that nobody vouched for. So
 * the properties that matter are that two agents agreeing carries a claim exactly
 * as far as `lookup` and no further, that a claim an operator rejected cannot come
 * back by being re-proposed, and that the one thing which *can* come back — an
 * amendment naming its barred parent — is the only thing which can.
 */

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-knowledge-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function proposal(overrides: Partial<FactProposal> = {}): FactProposal {
  return {
    claim: 'knip runs every rule at error, so an unimported export turns check red.',
    scope: 'fleet',
    lifetime: 'standing',
    expiresInHours: null,
    evidence: 'check failed on an exported type nothing imported.',
    supersedes: null,
    resolvesWhen: null,
    ...overrides,
  };
}

function seenOn(goalRef: string | null, overrides: Partial<FactObservation> = {}): FactObservation {
  return {
    agentId: `agent_${goalRef ?? 'none'}`,
    taskId: `task_${goalRef ?? 'none'}`,
    goalRef,
    sessionId: null,
    words: 'I hit this too.',
    ...overrides,
  };
}

// -- the axes -----------------------------------------------------------------

test('a fact lands as a proposal carrying all three axes, and the proposer as its first observation', () => {
  const { store } = build();
  const filed = store.proposeFact(proposal(), seenOn('issue:41', { words: 'check went red on an unused export.' }));
  assert.equal(filed.outcome, 'filed');
  const fact = filed.fact;
  // Three independent fields, never one enum: who it is for, how it ends, how far
  // it carries.
  assert.equal(fact.scope, 'fleet');
  assert.equal(fact.lifetime, 'standing');
  assert.equal(fact.expiresAt, null);
  assert.equal(fact.reach, 'proposal');
  assert.equal(fact.originRef, 'issue:41');
  // The count is a table, never a column — and it carries the observer's own words,
  // which is what an operator reads to decide whether a claim should have promoted.
  const corroborations = store.listCorroborations(fact.id);
  assert.equal(corroborations.length, 1);
  assert.equal(corroborations[0]!.goalRef, 'issue:41');
  assert.equal(corroborations[0]!.words, 'check went red on an unused export.');
  assert.deepEqual(store.getFact(fact.id), fact);
});

test('an expiring fact is stamped with when it lapses, and a standing one never is', () => {
  const { store } = build();
  const notice = store.proposeFact(
    proposal({
      claim: 'test (windows) has been timing out at the install step.',
      lifetime: 'expiring',
      expiresInHours: 6,
    }),
    seenOn('pr:412'),
  );
  assert.ok(notice.outcome !== 'barred');
  assert.ok(notice.fact.expiresAt, 'an expiring fact without a clock is a permanent claim wearing one');
  assert.ok(notice.fact.expiresAt! > notice.fact.createdAt);
});

// -- corroboration ------------------------------------------------------------

test('a second goal saying the same thing corroborates the claim rather than filing a copy of it', () => {
  const { store } = build();
  const first = store.proposeFact(proposal(), seenOn('issue:41'));
  assert.ok(first.outcome !== 'barred');
  // Worded differently, and with the qualifier a restatement adds — one claim.
  const second = store.proposeFact(
    proposal({ claim: 'Knip runs every rule at error, so an unimported export turns check red on CI.' }),
    seenOn('issue:88'),
  );
  assert.equal(second.outcome, 'corroborated');
  assert.equal(second.fact.id, first.fact.id);
  assert.equal(second.corroborations, 2);
  assert.equal(store.listFacts().length, 1);
  // Two goals is exactly as far as agents can carry a claim by agreeing.
  assert.equal(store.getFact(first.fact.id)?.reach, 'lookup');
});

test('two origins on one goal are one observation, not two', () => {
  const { store } = build();
  store.proposeFact(proposal(), seenOn(corroborationGoal('pr:412:ci')));
  const again = store.proposeFact(proposal(), seenOn(corroborationGoal('pr:412:comments')));
  assert.ok(again.outcome !== 'barred');
  // `pr:412:ci` and `pr:412:comments` are two origins and one confusion: two parts
  // of one goal hitting one wall is one observation.
  assert.equal(again.corroborations, 1);
  assert.equal(again.fact.reach, 'proposal');
});

test('an agent that inherited a conversation cannot corroborate its own predecessor', () => {
  const { store } = build();
  store.proposeFact(proposal(), seenOn('issue:41', { sessionId: 'sess_a' }));
  // A re-dispatch inherits the conversation through spawn's resumeSessionId, so
  // the same agent comes back — on a *different* origin, which is exactly why the
  // goal alone cannot see it.
  const resumed = store.proposeFact(proposal(), seenOn('issue:41:part:reader', { sessionId: 'sess_a' }));
  assert.ok(resumed.outcome !== 'barred');
  assert.equal(resumed.corroborations, 1);
  assert.equal(resumed.fact.reach, 'proposal');
});

test('corroboration carries a claim to lookup and never one step further', () => {
  const { store } = build();
  const filed = store.proposeFact(proposal(), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  for (const goal of ['issue:88', 'issue:99', 'pr:7']) store.proposeFact(proposal(), seenOn(goal));
  // Four goals agreeing is still not an operator. `injected` is in front of every
  // agent before it reads any code, and nothing but a person (or a notice, whose
  // blast radius is capped by its own clock) puts a claim there.
  assert.equal(store.getFact(filed.fact.id)?.reach, 'lookup');
});

test('the same sentence about one check and about the fleet are two claims', () => {
  const { store } = build();
  const fleet = store.proposeFact(proposal(), seenOn('issue:41'));
  const check = store.proposeFact(proposal({ scope: 'check:test (windows)' }), seenOn('issue:88'));
  assert.ok(fleet.outcome !== 'barred' && check.outcome !== 'barred');
  assert.notEqual(fleet.fact.id, check.fact.id);
  assert.equal(check.outcome, 'filed');
});

// -- the rejection bar, and the one thing exempt from it ----------------------

test('a rejected claim is barred from coming back, by re-proposal or by corroboration', () => {
  const { store } = build();
  const filed = store.proposeFact(proposal(), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  assert.equal(store.setFactReach(filed.fact.id, 'rejected')?.reach, 'rejected');

  const again = store.proposeFact(proposal(), seenOn('issue:88'));
  assert.equal(again.outcome, 'barred');
  assert.ok(again.outcome === 'barred');
  assert.equal(again.barredBy.id, filed.fact.id);
  // Nothing was written: without the bar, two agents re-propose next week what an
  // operator killed today and corroboration resurrects it on its own.
  assert.equal(store.listFacts().length, 1);
  assert.equal(store.listCorroborations(filed.fact.id).length, 1);
  // And there is no way back out of `rejected` short of an amendment.
  assert.equal(store.setFactReach(filed.fact.id, 'lookup'), null);
});

test('an amendment naming its barred parent is filed, where the same words alone are refused', () => {
  const { store } = build();
  const parent = store.proposeFact(
    proposal({ claim: 'Drop the export keyword rather than deleting the type.' }),
    seenOn('issue:41'),
  );
  assert.ok(parent.outcome !== 'barred');
  store.setFactReach(parent.fact.id, 'rejected');
  // An amended claim usually *contains* its original — that is what amending is —
  // so the bar would swallow its own correction if `supersedes` did not exempt it.
  const amendment = store.proposeFact(
    proposal({
      claim:
        'Drop the export keyword rather than deleting the type — except on a class member, where knip is name-based.',
      supersedes: parent.fact.id,
    }),
    seenOn('issue:88'),
  );
  assert.equal(amendment.outcome, 'filed');
  assert.equal(amendment.fact.supersedes, parent.fact.id);
  // The exemption is that parent's alone: an amendment naming something else is
  // still barred by it.
  const unrelated = store.proposeFact(proposal({ supersedes: 'fact_nothing' }), seenOn('issue:99'));
  assert.equal(unrelated.outcome, 'filed');
});

test('an amendment is its own row, never folded into the claim it sharpens', () => {
  const { store } = build();
  const parent = store.proposeFact(proposal(), seenOn('issue:41'));
  assert.ok(parent.outcome !== 'barred');
  const amendment = store.proposeFact(
    proposal({ claim: `${proposal().claim} A class member is the exception.`, supersedes: parent.fact.id }),
    seenOn('issue:88'),
  );
  assert.ok(amendment.outcome !== 'barred');
  assert.notEqual(amendment.fact.id, parent.fact.id);
  assert.equal(store.listFacts().length, 2);
});

// -- what an ask can reach ----------------------------------------------------

test('an ask reaches nothing that is only one agent’s claim, and nothing that has lapsed', () => {
  const { store } = build();
  store.proposeFact(proposal({ claim: 'One agent said this and nothing has agreed.' }), seenOn('issue:41'));
  const lapsed = store.proposeFact(
    proposal({ claim: 'The runner has been out of disk all afternoon.', lifetime: 'expiring', expiresInHours: 1 }),
    seenOn('issue:41'),
  );
  assert.ok(lapsed.outcome !== 'barred');
  store.proposeFact(proposal({ claim: 'The runner has been out of disk all afternoon.' }), seenOn('issue:88'));
  assert.equal(
    store.askFacts({}).length,
    1,
    'a proposal is not an answer — that would be auto-promotion by the back door',
  );

  // Lapsed by the clock rather than by anybody acting: the row is still there and
  // still says what it said.
  const expired = new Store(':memory:', () => '2999-01-01T00:00:00.000Z');
  expired.proposeFact(proposal({ lifetime: 'expiring', expiresInHours: 1 }), seenOn('issue:41'));
  expired.proposeFact(proposal({ lifetime: 'expiring', expiresInHours: 1 }), seenOn('issue:88'));
  const stale = expired.listFacts()[0]!;
  expired.close();
  // `injected` since phase 4 — a notice is what two goals agreeing *can* inject —
  // and out of every read all the same. That is the point of the pair: the clock
  // is what bounds the tier, not the reach.
  assert.equal(stale.reach, 'injected');
});

test('an ask is answered from the scopes it names, and matched on the words a question shares', () => {
  const { store } = build();
  for (const goal of ['issue:41', 'issue:88']) {
    store.proposeFact(proposal(), seenOn(goal));
    store.proposeFact(
      proposal({ claim: 'The suite wants a built web bundle first.', scope: 'goal:issue:41' }),
      seenOn(goal),
    );
  }
  assert.equal(store.askFacts({ scopes: ['fleet'] }).length, 1);
  assert.equal(store.askFacts({ scopes: ['goal:issue:41'] })[0]?.claim, 'The suite wants a built web bundle first.');
  assert.equal(store.askFacts({ question: 'why does knip fail on an export' })[0]?.scope, 'fleet');
  assert.deepEqual(store.askFacts({ question: 'something nobody has ever written down' }), []);
});

// -- the lessons that came before --------------------------------------------

test('a promoted lesson is adopted as a fleet fact, once, and stops being one when it is retired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-knowledge-db-'));
  const dbPath = join(dir, 'store.db');
  try {
    const first = new Store(dbPath);
    const vouched = first.proposeLesson({ text: 'The suite wants a built web bundle first.', originRef: 'issue:41' });
    first.proposeLesson({ text: 'Nobody ruled on this one.', originRef: 'issue:41' });
    first.promoteLesson(vouched.id);
    first.close();

    // A promoted lesson *is* a fleet-scoped standing claim an operator vouched for,
    // reaching every agent's system prompt — which is `injected`, exactly.
    const second = new Store(dbPath);
    const adopted = second.listFacts();
    assert.equal(adopted.length, 1, 'a proposal an operator has not ruled on is not a fact');
    assert.equal(adopted[0]!.claim, 'The suite wants a built web bundle first.');
    assert.equal(adopted[0]!.reach, 'injected');
    assert.equal(adopted[0]!.scope, 'fleet');
    assert.equal(adopted[0]!.originRef, 'issue:41');
    second.close();

    // Idempotent: the id is derived from the lesson's, so the second boot inserts
    // nothing rather than a second copy of every vouched claim.
    const third = new Store(dbPath);
    assert.equal(third.listFacts().length, 1);
    assert.equal(third.listCorroborations(adopted[0]!.id).length, 1);
    third.retireLesson(vouched.id);
    third.close();

    // Retired on one surface, gone from the other: an adopted row nobody has
    // touched is a mirror of the lesson, and it is not governed here.
    const fourth = new Store(dbPath);
    assert.deepEqual(fourth.listFacts(), []);
    fourth.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an adopted fact an agent has corroborated is a fact in its own right, and survives the retirement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-knowledge-db-'));
  const dbPath = join(dir, 'store.db');
  try {
    const first = new Store(dbPath);
    const lesson = first.proposeLesson({ text: 'The suite wants a built web bundle first.', originRef: 'issue:41' });
    first.promoteLesson(lesson.id);
    first.close();

    const second = new Store(dbPath);
    second.proposeFact(proposal({ claim: 'The suite wants a built web bundle first.' }), seenOn('issue:88'));
    second.retireLesson(lesson.id);
    second.close();

    const third = new Store(dbPath);
    assert.equal(third.listFacts().length, 1);
    assert.equal(third.listFacts()[0]!.reach, 'injected');
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- the pure layer -----------------------------------------------------------

test('a scope is resolved from the credential, never named', () => {
  assert.deepEqual(resolveFactScope('goal', 'issue:41'), { ok: true, scope: 'goal:issue:41' });
  assert.deepEqual(resolveFactScope('fleet', 'issue:41'), { ok: true, scope: 'fleet' });
  assert.deepEqual(resolveFactScope('check:test (windows)', null), { ok: true, scope: 'check:test (windows)' });
  // Refused rather than widened to `fleet`: an agent handed a silent success
  // believes it filed a goal-local note.
  assert.equal(resolveFactScope('goal', null).ok, false);
  assert.equal(resolveFactScope('goal:issue:99', 'issue:41').ok, false);
  assert.equal(resolveFactScope('check:', null).ok, false);
  assert.equal(resolveFactScope('everything', 'issue:41').ok, false);
});

test('a malformed proposal is refused rather than trimmed into one', () => {
  assert.equal(validateFactProposal({ scope: 'fleet', evidence: 'x' }, null).ok, false);
  assert.equal(validateFactProposal({ claim: 'x', scope: 'fleet' }, null).ok, false);
  assert.equal(
    validateFactProposal({ claim: 'x'.repeat(MAX_CLAIM_CHARS + 1), scope: 'fleet', evidence: 'y' }, null).ok,
    false,
  );
  // An expiring fact with no clock is the one shape that would be a permanent
  // fleet-wide claim wearing a lifetime that never ends.
  assert.equal(
    validateFactProposal({ claim: 'x', scope: 'fleet', evidence: 'y', lifetime: 'expiring' }, null).ok,
    false,
  );
  const good = validateFactProposal(
    { claim: ' a claim ', scope: 'fleet', evidence: `${'y'.repeat(MAX_EVIDENCE_CHARS + 10)}` },
    null,
  );
  assert.ok(good.ok);
  assert.equal(good.proposal.claim, 'a claim');
  assert.equal(good.proposal.evidence.length, MAX_EVIDENCE_CHARS);
});

test('the goal behind an origin is the goal, whatever concern the dispatch named', () => {
  assert.equal(corroborationGoal('issue:41:part:reader'), 'issue:41');
  assert.equal(corroborationGoal('pr:412:comment:c_9'), 'pr:412');
  assert.equal(corroborationGoal('job:j_1'), 'job:j_1');
  assert.equal(corroborationGoal(null), null);
});

test('two observations are one corroborator if they share a goal or a session, transitively', () => {
  const rows = [
    { id: 'a', goalRef: 'issue:41', sessionId: 'sess_a' },
    { id: 'b', goalRef: 'issue:88', sessionId: 'sess_a' },
    { id: 'c', goalRef: 'issue:88', sessionId: 'sess_b' },
  ];
  // Two goals, one agent that was re-dispatched across both — and the third row
  // joins through the goal it shares, so the whole chain is one corroborator.
  assert.equal(distinctCorroborators(rows), 1);
  assert.equal(distinctCorroborators([...rows, { id: 'd', goalRef: 'pr:7', sessionId: null }]), 2);
  // A row with no goal and no session is its own corroborator rather than being
  // folded in with every other anonymous one.
  assert.equal(
    distinctCorroborators([
      { id: 'e', goalRef: null, sessionId: null },
      { id: 'f', goalRef: null, sessionId: null },
    ]),
    2,
  );
});

test('a question finds a claim on the words they share, not on containment', () => {
  const claim = 'knip runs every rule at error, so an unimported export turns check red';
  assert.ok(questionScore('why does knip fail on a type I export', claim) > 0);
  assert.equal(questionScore('how do worktrees get reclaimed', claim), 0);
  // Short words are the ones every claim shares, so they carry no signal.
  assert.equal(questionScore('so an at the', claim), 0);
});

test('a contradiction is validated on the amendment it demands, and the amendment inherits the claim’s axes', () => {
  // The amendment *is* the call: a bare objection is a count, and nothing in this
  // store is demoted by one.
  assert.equal(validateContradiction({ factId: 'fact_1', evidence: 'saw it' }).ok, false);
  assert.equal(validateContradiction({ amendment: 'sharper', evidence: 'saw it' }).ok, false);
  assert.equal(validateContradiction({ factId: 'fact_1', amendment: 'sharper' }).ok, false);
  const parsed = validateContradiction({ factId: ' fact_1 ', amendment: ' sharper ', evidence: ' saw it ' });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.contradiction, { factId: 'fact_1', amendment: 'sharper', evidence: 'saw it' });

  // The axes are the original's and never arguments: matching is inside a scope,
  // so an amendment filed in another one would not be an amendment of anything.
  const now = '2026-08-22T12:00:00.000Z';
  const standing: KnowledgeFact = {
    id: 'fact_1',
    claim: 'the original',
    scope: 'check:test (windows)',
    lifetime: 'standing',
    expiresAt: null,
    reach: 'injected',
    supersedes: null,
    originRef: 'issue:41',
    ruledAt: now,
    resolvesWhen: null,
    createdAt: now,
    updatedAt: now,
  };
  const amended = amendmentProposal(standing, parsed.contradiction, now);
  assert.equal(amended.scope, 'check:test (windows)');
  assert.equal(amended.lifetime, 'standing');
  assert.equal(amended.expiresInHours, null);
  assert.equal(amended.supersedes, 'fact_1');
  // An agent never writes a resolution condition, amendment or not.
  assert.equal(amended.resolvesWhen, null);

  // A notice's amendment inherits what is *left* of its clock: a fresh week would
  // outlive the notice it sharpens.
  const notice = {
    ...standing,
    lifetime: 'expiring' as const,
    expiresAt: '2026-08-22T17:30:00.000Z',
  };
  assert.equal(amendmentProposal(notice, parsed.contradiction, now).expiresInHours, 6);
});

test('the contradiction ratio is disputing voices over every voice that has spoken', () => {
  assert.equal(contradictionRatio(2, 1), 1 / 3);
  assert.equal(contradictionRatio(3, 0), 0);
  // A claim nobody has said anything about is not a claim everybody disputes.
  assert.equal(contradictionRatio(0, 0), 0);
});

// -- the tools ----------------------------------------------------------------

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function spawnAgent(system: System, originRef: string): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: `Work ${originRef}`,
    prompt: 'do it',
    branch: 'issue/12',
    originRef,
    originTitle: 'Big thing',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('knowledge_propose files a claim attributed to the caller’s own goal', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:part:reader');
  const res = await callTool(system, agent, 'knowledge_propose', {
    claim: 'A route handler never reads the request; it is wrapped in checked(schemas, handler).',
    scope: 'fleet',
    evidence: 'The structural test over src/server/routes failed until I used the wrapper.',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { fact: { id: string; reach: string }; corroborations: number };
  assert.equal(payload.fact.reach, 'proposal');
  assert.equal(payload.corroborations, 1);
  // Attribution is the credential's: the goal, not the part origin the dispatch used.
  assert.equal(system.store.getFact(payload.fact.id)?.originRef, 'issue:12');
  system.store.close();
});

test('a second agent on a second goal is told its call was corroboration, not a second copy', async () => {
  const system = build();
  const claim = 'A route handler never reads the request; it is wrapped in checked(schemas, handler).';
  const first = spawnAgent(system, 'issue:12');
  await callTool(system, first, 'knowledge_propose', { claim, scope: 'fleet', evidence: 'saw it in routes.' });
  const second = spawnAgent(system, 'issue:44');
  const res = await callTool(system, second, 'knowledge_propose', {
    claim,
    scope: 'fleet',
    evidence: 'again, in mine.',
  });
  const payload = JSON.parse(res.text) as { corroborations: number; note: string };
  assert.equal(payload.corroborations, 2);
  assert.match(payload.note, /corroboration/i);
  assert.equal(system.store.listFacts().length, 1);
  system.store.close();
});

test('a barred proposal is refused by name, with the amendment that is the way back', async () => {
  const system = build();
  const claim = 'The dispatcher reads the lessons table before it ranks anything.';
  const first = spawnAgent(system, 'issue:12');
  await callTool(system, first, 'knowledge_propose', { claim, scope: 'fleet', evidence: 'I assumed so.' });
  const rejected = system.store.listFacts()[0]!;
  system.store.setFactReach(rejected.id, 'rejected');

  const second = spawnAgent(system, 'issue:44');
  const res = await callTool(system, second, 'knowledge_propose', {
    claim,
    scope: 'fleet',
    evidence: 'I assumed so too.',
  });
  assert.equal(res.isError, true);
  // A silent refusal teaches the fleet nothing and it files the claim again
  // tomorrow, so the refusal names the claim, its id and the amendment arm.
  assert.match(res.text, new RegExp(rejected.id));
  assert.match(res.text, /supersedes/);
  system.store.close();
});

test('knowledge_ask answers from the caller’s own scopes and says so when nothing is on record', async () => {
  const system = build();
  const claim = 'The suite wants a built web bundle first.';
  for (const origin of ['issue:12', 'issue:44']) {
    const agent = spawnAgent(system, origin);
    await callTool(system, agent, 'knowledge_propose', { claim, scope: 'fleet', evidence: 'the suite failed cold.' });
  }
  const asker = spawnAgent(system, 'issue:77');
  const answered = await callTool(system, asker, 'knowledge_ask', {});
  const payload = JSON.parse(answered.text) as { scopes: string[]; facts: { claim: string; corroborations: number }[] };
  assert.deepEqual(payload.scopes, ['fleet', 'goal:issue:77']);
  assert.equal(payload.facts[0]?.claim, claim);
  assert.equal(payload.facts[0]?.corroborations, 2);

  const empty = await callTool(system, asker, 'knowledge_ask', { question: 'how are worktree slots leased' });
  const none = JSON.parse(empty.text) as { facts: unknown[]; note: string };
  assert.deepEqual(none.facts, []);
  assert.match(none.note, /knowledge_propose/);
  system.store.close();
});

// -- the operator's arm: the routes and the page (phase 2) --------------------

/**
 * The reach transitions are the whole write surface the cockpit has on this
 * store, and the properties worth asserting are again the negative ones: nothing
 * here files a claim, nothing carries one past where an operator put it, and a
 * rejection does not come back.
 */

async function serve(system: System): Promise<FastifyInstance> {
  const { app } = await buildApp(system);
  return app;
}

/** One reach request, as the status and whatever refusal came with it. */
async function ask(app: FastifyInstance, id: string, reach: string): Promise<{ status: number; error: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/knowledge/facts/${id}/reach`, payload: { reach } });
  return { status: res.statusCode, error: (res.json() as { error?: string }).error ?? '' };
}

test('an operator moves a claim as far as they say, and a rejection is terminal', async () => {
  const system = build();
  const app = await serve(system);
  const filed = system.store.proposeFact(proposal(), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  const id = filed.fact.id;

  // Straight to `injected` from one voice if the operator already knows: nothing
  // auto-promotes, and the reason it does not is that this decision is theirs.
  const injected = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${id}/reach`,
    payload: { reach: 'injected' },
  });
  assert.equal(injected.statusCode, 200);
  assert.equal(injected.json().fact.reach, 'injected');
  assert.ok(injected.json().fact.ruledAt, 'a move an operator made is stamped as ruled');

  const demoted = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${id}/reach`,
    payload: { reach: 'lookup' },
  });
  assert.equal(demoted.json().fact.reach, 'lookup');

  const rejected = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${id}/reach`,
    payload: { reach: 'rejected' },
  });
  assert.equal(rejected.statusCode, 200);
  // Terminal, and refused in the words that say what the way back is: there is no
  // un-reject route, because that would lift the bar without the amendment that
  // should have lifted it.
  const again = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${id}/reach`,
    payload: { reach: 'lookup' },
  });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /amendment/);

  await app.close();
  system.store.close();
});

test('saying a corroborated claim belongs where it is rules on it, and takes it out of Needs you', async () => {
  const system = build();
  const app = await serve(system);
  store2Goals(system);
  const fact = system.store.listFacts()[0]!;
  assert.equal(fact.reach, 'lookup');
  assert.equal(fact.ruledAt, null, 'two agents agreeing is not an operator ruling');

  // The one control that looks like a no-op and is not. Without it the page's
  // Needs you section asks forever, and the only way to empty it is a decision
  // the operator does not agree with.
  const kept = await app.inject({
    method: 'POST',
    url: `/api/knowledge/facts/${fact.id}/reach`,
    payload: { reach: 'lookup' },
  });
  assert.equal(kept.statusCode, 200);
  assert.ok(kept.json().fact.ruledAt);
  assert.equal(kept.json().fact.reach, 'lookup');

  await app.close();
  system.store.close();
});

test('the reach routes refuse an unknown fact and an unknown reach by name', async () => {
  const system = build();
  const app = await serve(system);
  const missing = await app.inject({
    method: 'POST',
    url: '/api/knowledge/facts/fact_nothing/reach',
    payload: { reach: 'injected' },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/knowledge/facts/fact_nothing' })).statusCode, 404);

  const filed = system.store.proposeFact(proposal(), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  // `proposal` and `committed` are absent from the body on purpose: nothing
  // restores "nobody has agreed with this", and a fact leaves for the repository
  // through a documentation pull request that does not exist yet.
  for (const reach of ['proposal', 'committed', 'everywhere']) {
    const refused = await ask(app, filed.fact.id, reach);
    assert.equal(refused.status, 400, reach);
    assert.match(refused.error, /reach must be one of/);
  }

  await app.close();
  system.store.close();
});

test('one fact’s route answers the observers’ own words, counted the way the store counts them', async () => {
  const system = build();
  const app = await serve(system);
  const filed = system.store.proposeFact(
    proposal(),
    seenOn('issue:41', { words: 'check went red on an unused export.' }),
  );
  assert.ok(filed.outcome !== 'barred');
  // Two rows, one corroborator: the same goal seen twice is one observation, and
  // the count on the payload has to be that rather than the number of rows.
  system.store.proposeFact(proposal(), seenOn('issue:41', { words: 'and again on the same goal.' }));
  const read = await app.inject({ method: 'GET', url: `/api/knowledge/facts/${filed.fact.id}` });
  assert.equal(read.statusCode, 200);
  const payload = read.json() as { fact: { corroborations: number }; corroborations: { words: string }[] };
  assert.equal(payload.corroborations.length, 2);
  assert.equal(payload.fact.corroborations, 1);
  assert.equal(payload.corroborations[0]?.words, 'check went red on an unused export.');

  await app.close();
  system.store.close();
});

test('the snapshot carries every fact, the rejected ones included, with the count that promotes', async () => {
  const system = build();
  const app = await serve(system);
  store2Goals(system);
  const killed = system.store.proposeFact(proposal({ claim: 'A claim nobody should act on.' }), seenOn('issue:9'));
  assert.ok(killed.outcome !== 'barred');
  system.store.setFactReach(killed.fact.id, 'rejected');

  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json() as AppState;
  const rejected = state.knowledge.find((f) => f.id === killed.fact.id);
  // The page is the governance, so it draws what it stopped: a surface showing
  // only what it let through cannot show that a claim was killed, and the bar is
  // invisible everywhere else.
  assert.ok(rejected, 'a rejected claim is on the snapshot, or nothing can show it was rejected');
  assert.equal(rejected.reach, 'rejected');
  assert.equal(state.knowledge.find((f) => f.reach === 'lookup')?.corroborations, 2);

  await app.close();
  system.store.close();
});

test('the cockpit hears a proposal when it is filed, not on the next pulse', async () => {
  const system = build();
  const heard: { filed: boolean; claim: string }[] = [];
  system.agents.on('fact', (e) => heard.push({ filed: e.filed, claim: e.fact.claim }));
  const first = spawnAgent(system, 'issue:12');
  const claim = 'A route handler never reads the request; it is wrapped in checked(schemas, handler).';
  await callTool(system, first, 'knowledge_propose', { claim, scope: 'fleet', evidence: 'saw it in routes.' });
  const second = spawnAgent(system, 'issue:44');
  await callTool(system, second, 'knowledge_propose', { claim, scope: 'fleet', evidence: 'again, in mine.' });
  assert.deepEqual(
    heard.map((h) => h.filed),
    [true, false],
    'the second call is agreement with a standing claim, not a second claim',
  );

  // A barred proposal wrote nothing, so it says nothing: an event there would put
  // a claim an operator killed back in front of them as though it had just arrived.
  const killed = system.store.listFacts()[0]!;
  system.store.setFactReach(killed.id, 'rejected');
  const third = spawnAgent(system, 'issue:77');
  await callTool(system, third, 'knowledge_propose', { claim, scope: 'fleet', evidence: 'me too.' });
  assert.equal(heard.length, 2);
  system.store.close();
});

/** Two goals agreeing on one claim — the corroborated proposal the page asks about. */
function store2Goals(system: System): void {
  for (const goal of ['issue:41', 'issue:88']) system.store.proposeFact(proposal(), seenOn(goal));
}

// -- the page -----------------------------------------------------------------

test('the knowledge page and the claim it has open are places, not component state', () => {
  const place = { ...NOWHERE, panel: 'knowledge' as const, fact: 'fact_abc' };
  // A row held open in a `useState` works right up until the back button steps
  // over it, and a panel name `readPlace` does not know is parsed back to null —
  // which is a control that opens nothing at all, with nothing red.
  assert.deepEqual(readPlace(placeQuery(place)), place);
  assert.equal(readPlace('?panel=knowledge&fact=').fact, null);
});

test('the Knowledge reading counts the corroborated claims nobody has ruled on', () => {
  const facts = [
    { id: 'a', reach: 'lookup', ruledAt: null },
    { id: 'b', reach: 'lookup', ruledAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', reach: 'proposal', ruledAt: null },
    { id: 'd', reach: 'injected', ruledAt: '2026-01-01T00:00:00.000Z' },
  ];
  const view = buildViewModel({
    state: {
      knowledge: facts,
      agents: [],
      escalations: [],
      world: { issues: [], pullRequests: [] },
      config: { heartbeatIntervalMs: 60_000 },
      control: { cap: 1, paused: false },
      tasks: [],
      parkedOnLimit: [],
      stallParks: [],
    } as unknown as AppState,
    now: 1_000_000,
    connected: true,
    demo: false,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: 1_000_000,
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    viewingFact: 'fact_abc',
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal: null,
    consolePanel: 'knowledge',
    tab: 'overview',
  });
  // What wants the operator is the claim two agents already agreed on. A count
  // that included one agent's unseconded note would never come down, and one that
  // included what the operator already ruled on would climb on their own click.
  assert.equal(view.factsNeedingYou, 1);
  // The second leg of the round trip: a place the hook forwards nowhere draws its
  // default however right the URL is.
  assert.equal(view.viewingFact, 'fact_abc');
});

/**
 * The page as the shell mounts it, over the demo fixtures.
 *
 * Rendered rather than asserted about, because the two failures worth catching
 * here cannot be seen in a view model: a claim drawn under the wrong heading, and
 * a `<Ref>` outside `RefLinks`, which throws rather than quietly drawing a number
 * with no way there. `test/console.test.ts`'s shape, including the `React` global
 * — `tsx` compiles JSX with the classic runtime while the bundle uses the
 * automatic one.
 */
test('the page draws every reach, the rejected tail included', async () => {
  const React = await import('react');
  (globalThis as { React?: unknown }).React = React;
  const { createElement } = React;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { buildDemoState } = await import('../web/src/demo/fixtures.js');
  const { KnowledgePanel } = await import('../web/src/components/KnowledgePanel.js');
  const { RefLinks } = await import('../web/src/components/refs.js');

  const state = buildDemoState().state;
  const html = renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: state.refUrls,
      openGoal: () => undefined,
      hasGoal: () => true,
      children: createElement(KnowledgePanel, {
        facts: state.knowledge,
        graduations: state.knowledgeGraduations,
        delivery: state.knowledgeDelivery,
        now: Date.now(),
        refUrls: state.refUrls,
        viewingFact: null,
        onReach: () => undefined,
        onCommit: () => undefined,
        onSettleGraduation: () => undefined,
        onDetail: () => Promise.resolve({ corroborations: [], contradictions: [] }),
        onResolveContradiction: () => undefined,
        onViewFact: () => undefined,
      }),
    }),
  );

  for (const heading of [
    'Live notices',
    'Needs you',
    'Injected',
    'On lookup',
    'One voice',
    'Committed to the repository',
    'Superseded',
    'Rejected',
  ]) {
    assert.ok(html.includes(heading), `the page draws no ${heading} section`);
  }
  // The claim an operator killed is on the page. A governance surface that drew
  // only what it let through could not show that anything was stopped, and the
  // bar that keeps it from being re-proposed is invisible everywhere else.
  assert.ok(html.includes('The dispatcher reads the lessons table'), 'a rejected claim is not drawn');
  // A scope is a place a reader can go, not a label.
  assert.ok(html.includes('goal <'), 'a goal scope is not drawn as a reference');
  // A disputed claim is drawn where its reach puts it, carrying the reading and
  // not a demotion: nothing here is moved by a count, so a contradicted claim
  // lifted out of Injected would draw something that did not happen.
  assert.ok(html.includes('1 dispute'), 'the contradiction count is not drawn');
  assert.ok(html.includes('25%'), 'the contradiction ratio is not drawn');
  assert.ok(html.includes('1 to answer'), 'an unanswered dispute is not drawn');
  // Where a claim went, and where one is going: both drawn as references rather
  // than as text, because a row that names a pull request and offers no way there
  // is a dead end that reads correctly (#27 phase 6).
  assert.ok(html.includes('committed to the document that owns it'), 'a committed row does not say where it went');
  assert.ok(html.includes('/pull/409'), 'a committed row does not link to the pull request that put it there');
  assert.ok(html.includes('/pull/411'), 'a graduating row does not link to its open pull request');
  // And the claim being written up is still on lookup, still delivered: nothing
  // moved when the operator clicked.
  assert.ok(html.includes('being written up'), 'a graduation in flight is not drawn');
  // And the one thing an operator must not be able to do from here.
  assert.ok(!/>File a claim</.test(html), 'nothing on this page files a claim');
});

// -- delivery (phase 3) -------------------------------------------------------

/** A launched agent that says nothing and exits when killed — the argv is the subject here. */
class FakeStreamChild extends EventEmitter implements StreamChild {
  readonly pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

/**
 * A real dispatch, and what it launched and was told with — the `buildSystem`
 * seam rather than a hand-built call, because the thing most likely to break is
 * the wiring. `src/system.ts` is the only module on the launch path that knows
 * this store exists, and a builder that accepts the block and forgets to forward
 * it type-checks clean and drops it in silence.
 */
async function dispatchFor(
  issue: number,
  seed: (system: System) => void,
): Promise<{ launch: string[]; prompt: string }> {
  const launches: string[][] = [];
  const system = buildSystem(
    { ...testConfig(), agentMode: 'stream' },
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      streamSpawner: (_command, args) => {
        launches.push(args);
        return new FakeStreamChild();
      },
      errorMirror: () => {},
    },
  );
  seed(system);
  system.connector.inject({ kind: 'new_issue', number: issue, title: `Add login ${issue}` });
  failPlanningOpen(system.store, issue);
  await system.harness.runCycle('manual');
  const task = system.store.listTasks().find((t) => t.originRef?.startsWith(`issue:${issue}`));
  assert.ok(task, 'nothing was dispatched, so there is no prompt to read');
  const prompt = system.store.getTask(task.id)?.prompt ?? '';
  system.store.close();
  assert.equal(launches.length, 1, `expected one launch, saw ${launches.length}`);
  return { launch: launches[0]!, prompt };
}

/** Carry a claim to `lookup` the way the fleet does — two agents, two goals. */
function corroborated(system: System, over: Partial<FactProposal>): string {
  const filed = system.store.proposeFact(proposal(over), seenOn('issue:900'));
  assert.ok(filed.outcome !== 'barred');
  system.store.proposeFact(proposal(over), seenOn('issue:901'));
  return filed.fact.id;
}

test('an injected fleet claim rides the system prompt, and a corroborated one does not', async () => {
  const { launch } = await dispatchFor(801, (system) => {
    const vouched = corroborated(system, { claim: 'The suite wants a built web bundle before it runs.' });
    system.store.setFactReach(vouched, 'injected');
    // Two agents agreeing is exactly as far as agreement carries a claim. A block
    // that delivered a `lookup` fact would make corroboration an auto-promotion to
    // every agent's context — the one thing the reach machine exists to stop.
    corroborated(system, { claim: 'The seed script leaves two orphan catalog rows behind.' });
    // And one voice is not evidence at all.
    system.store.proposeFact(proposal({ claim: 'Nothing has agreed with this claim yet.' }), seenOn('issue:902'));
  });
  const block = launch[launch.indexOf('--append-system-prompt') + 1] ?? '';
  assert.match(block, /The suite wants a built web bundle before it runs\./);
  assert.match(block, /first seen on issue:900/, 'provenance is what lets an agent discount a stale claim');
  assert.doesNotMatch(block, /orphan catalog rows/, 'a lookup claim is not injected everywhere');
  assert.doesNotMatch(block, /Nothing has agreed/, 'a proposal reaches nobody');
});

test('a claim scoped to the goal rides that goal’s task prompt, and no system prompt', async () => {
  const { launch, prompt } = await dispatchFor(802, (system) => {
    corroborated(system, {
      scope: 'goal:issue:802',
      claim: 'The login form posts to the old endpoint on this branch.',
    });
    corroborated(system, { scope: 'goal:issue:999', claim: 'A claim about somebody else’s goal entirely.' });
  });
  // `lookup` means *not injected everywhere*, not *never injected*: a claim about
  // the goal in front of an agent is in front of it without anyone asking, and
  // costs nothing on a dispatch about anything else.
  assert.match(prompt, /The login form posts to the old endpoint on this branch\./);
  assert.doesNotMatch(prompt, /somebody else’s goal/);
  // And it stays out of the cached prefix: what varies per dispatch may not enter
  // the system prompt, whatever its reach.
  assert.doesNotMatch(launch[launch.indexOf('--append-system-prompt') + 1] ?? '', /login form posts/);
});

test('the page is told what is actually sent, from the renderers that send it', async () => {
  const system = build();
  const vouched = corroborated(system, { claim: 'A ticket naming only a symptom is under-specified every time.' });
  system.store.setFactReach(vouched, 'injected');
  corroborated(system, { scope: 'check:test (windows)', claim: 'The install step times out under four minutes.' });

  const { app } = await buildApp(system);
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeDelivery: {
      block: string;
      limit: number;
      rendered: string[];
      dropped: string[];
      scoped: { scope: string; text: string }[];
    };
  };
  const delivery = snap.knowledgeDelivery;
  // The text itself, not a description of it: what an operator reads here has to
  // be the bytes the launch carries, or the surface is a second opinion about
  // delivery and nothing is red when the two disagree.
  assert.deepEqual(delivery.rendered, [vouched]);
  assert.deepEqual(delivery.dropped, []);
  assert.equal(delivery.limit, system.config.knowledgeBlockChars);
  assert.match(delivery.block, /under-specified every time/);
  assert.deepEqual(
    delivery.scoped.map((s) => s.scope),
    ['check:test (windows)'],
  );
  assert.match(delivery.scoped[0]!.text, /times out under four minutes/);
  await app.close();
});

test('a promoted lesson still reaches agents, as the fact it is mirrored into', async () => {
  // Delivery moved in phase 3 and the lessons table stopped being rendered in its
  // own right — so this is the crossing that must not break silently: a lesson
  // vouched for is a claim that reaches agents, and one that quietly stopped
  // would look exactly like one nobody promoted.
  const system = build();
  const lesson = system.store.proposeLesson({ text: 'Take the devops lock before deploying.', originRef: 'issue:41' });
  system.store.promoteLesson(lesson.id);

  const { app } = await buildApp(system);
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeDelivery: { block: string };
    lessons: { id: string; rendered: boolean }[];
  };
  assert.match(snap.knowledgeDelivery.block, /Take the devops lock before deploying\./);
  // And the Lessons panel's chip is that same answer read back, never a second
  // rendering of the lessons table — one block ships, so both panels have to be
  // describing it.
  assert.equal(snap.lessons.find((l) => l.id === lesson.id)?.rendered, true);
  await app.close();
});

// -- contradiction and amendment (phase 5) ------------------------------------

/**
 * The properties here are again the negative ones, and the sharpest is that a
 * contradiction moves **nothing**. A claim that is right in general and wrong at
 * one edge attracts contradictions *because it is being used*, so the store's most
 * valuable claims are the first a count would kill — the whole design is that
 * disagreement produces a sharper claim rather than one fewer claim.
 */

/** One contradiction through the tool, as the caller sees it. */
async function contradict(system: System, agent: Agent, args: Record<string, unknown>) {
  return callTool(system, agent, 'knowledge_contradict', args);
}

/** Resolve one contradiction through the route, as an operator does. */
async function answer(app: FastifyInstance, id: string, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: `/api/knowledge/contradictions/${id}/resolve`, payload: body });
  return { status: res.statusCode, error: (res.json() as { error?: string }).error ?? '' };
}

/** An injected fleet claim with the corroborations behind it, ready to be disputed. */
function injectedClaim(system: System, claim: string): string {
  const filed = system.store.proposeFact(proposal({ claim }), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  system.store.proposeFact(proposal({ claim }), seenOn('issue:42'));
  system.store.setFactReach(filed.fact.id, 'injected');
  return filed.fact.id;
}

const EDGE_CLAIM = 'Drop the export keyword rather than deleting the declaration when knip reports it unused.';
const EDGE_AMENDMENT =
  'Drop the export keyword rather than deleting the declaration when knip reports it unused — except on a class ' +
  'member, where the analysis is name-based and the member itself has to go.';

test('a contradiction files the amendment it demands, and moves the claim nowhere', async () => {
  const system = build();
  const id = injectedClaim(system, EDGE_CLAIM);
  const agent = spawnAgent(system, 'issue:77');
  const res = await contradict(system, agent, {
    factId: id,
    amendment: EDGE_AMENDMENT,
    evidence: 'knip stayed red on a class member until I deleted the method.',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as {
    amendment: { id: string; scope: string; reach: string };
    contradicted: { reach: string };
    note: string;
  };
  // The amendment is a claim of its own, on the original's axes, naming it.
  const amendment = system.store.getFact(payload.amendment.id);
  assert.equal(amendment?.supersedes, id);
  assert.equal(amendment?.scope, 'fleet');
  assert.equal(amendment?.reach, 'proposal');
  // And the claim it disputes has not moved — not demoted, not lapsed, not gone.
  const original = system.store.getFact(id);
  assert.equal(original?.reach, 'injected');
  assert.equal(original?.expiresAt, null);
  assert.equal(payload.contradicted.reach, 'injected');
  // Said in the response, because an agent that believes it has just taken a stale
  // claim off the fleet stops looking at it.
  assert.match(payload.note, /has not moved/i);
  system.store.close();
});

test('a contradiction is not a corroboration, and never reaches the count that promotes', async () => {
  const system = build();
  const filed = system.store.proposeFact(proposal({ claim: EDGE_CLAIM }), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  const id = filed.fact.id;
  assert.equal(system.store.getFact(id)?.reach, 'proposal');
  system.store.setFactReach(id, 'injected');

  // Two goals dispute it — the same shape and the same number that carries a
  // proposal to lookup, on the other table.
  for (const [i, origin] of ['issue:77', 'issue:88'].entries()) {
    const agent = spawnAgent(system, origin);
    await contradict(system, agent, {
      factId: id,
      amendment: `${EDGE_AMENDMENT} (${i})`,
      evidence: 'the analysis is name-based here.',
    });
  }
  // The funniest possible failure, and an entirely silent one: a dispute counted
  // as agreement promotes the claim it disputes.
  assert.equal(system.store.listCorroborations(id).length, 1);
  const counts = system.store.factCounts().get(id);
  assert.equal(counts?.corroborations, 1);
  assert.equal(counts?.contradictions, 2);
  assert.equal(counts?.openContradictions, 2);
  assert.equal(counts?.contradictionRatio, 2 / 3);
  system.store.close();
});

test('the second agent to hit the edge corroborates the amendment rather than filing a second one', async () => {
  const system = build();
  const id = injectedClaim(system, EDGE_CLAIM);
  for (const origin of ['issue:77', 'issue:88']) {
    const agent = spawnAgent(system, origin);
    await contradict(system, agent, { factId: id, amendment: EDGE_AMENDMENT, evidence: `saw it on ${origin}.` });
  }
  const amendments = system.store.listFacts().filter((f) => f.supersedes === id);
  // Three agents hitting one edge must *sharpen* the claim. Filing each identical
  // amendment as its own one-voice proposal carries nothing anywhere, and looks
  // exactly like the design working.
  assert.equal(amendments.length, 1);
  assert.equal(system.store.factCounts().get(amendments[0]!.id)?.corroborations, 2);
  assert.equal(amendments[0]!.reach, 'lookup');
  system.store.close();
});

test('a contradiction with no amendment is refused by name, and so is one of a rejected claim', async () => {
  const system = build();
  const id = injectedClaim(system, EDGE_CLAIM);
  const agent = spawnAgent(system, 'issue:77');
  const bare = await contradict(system, agent, { factId: id, evidence: 'it did not hold here.' });
  assert.equal(bare.isError, true);
  assert.match(bare.text, /amendment is required/);
  // The reason, not only the refusal: nothing is demoted by count, so a bare
  // objection changes nothing and the agent has to be told that.
  assert.match(bare.text, /demoted by count/i);

  const killed = system.store.proposeFact(proposal({ claim: 'The seed script is idempotent.' }), seenOn('issue:41'));
  assert.ok(killed.outcome !== 'barred');
  system.store.setFactReach(killed.fact.id, 'rejected');
  const dead = await contradict(system, agent, {
    factId: killed.fact.id,
    amendment: 'The seed script is idempotent only after the migration has run.',
    evidence: 'it left two rows behind.',
  });
  assert.equal(dead.isError, true);
  // An operator has already answered it and it reaches nobody, so there is nothing
  // to correct — and the way to file the sharper claim in its own right is named.
  assert.match(dead.text, /knowledge_propose/);
  assert.match(dead.text, /supersedes/);

  const unknown = await contradict(system, agent, {
    factId: 'fact_nope',
    amendment: EDGE_AMENDMENT,
    evidence: 'saw it.',
  });
  assert.equal(unknown.isError, true);
  system.store.close();
});

test('adopting an amendment is one call: it takes the reach and the claim is superseded together', async () => {
  const system = build();
  const app = await serve(system);
  const id = injectedClaim(system, EDGE_CLAIM);
  const agent = spawnAgent(system, 'issue:77');
  await contradict(system, agent, { factId: id, amendment: EDGE_AMENDMENT, evidence: 'on a class member.' });
  const contradiction = system.store.listContradictions(id)[0]!;

  assert.deepEqual(await answer(app, contradiction.id, { resolution: 'amended' }), { status: 200, error: '' });
  // Two calls could half-land, and the half-landed state is the amendment injected
  // beside the blunter claim it was written to replace — both in one block, saying
  // different things. One call, so it cannot exist.
  assert.equal(system.store.getFact(id)?.reach, 'superseded');
  assert.equal(system.store.getFact(contradiction.amendmentId)?.reach, 'injected');
  const block = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeDelivery: { block: string };
  };
  assert.ok(block.knowledgeDelivery.block.includes('except on a class member'));
  assert.equal(block.knowledgeDelivery.block.includes(EDGE_CLAIM), false);
  // Superseded and not rejected, which is the load-bearing half: an amendment
  // *contains* the claim it sharpens, so a rejection would bar its own words.
  assert.equal(system.store.listContradictions(id)[0]?.resolution, 'amended');
  // And it is terminal in both directions — a claim with a sharper version standing
  // does not come back into the block beside it.
  assert.equal(system.store.setFactReach(id, 'injected'), null);
  await app.close();
});

test('a superseded claim does not bar the amendment’s own words from being restated', async () => {
  const system = build();
  const app = await serve(system);
  const id = injectedClaim(system, EDGE_CLAIM);
  const first = spawnAgent(system, 'issue:77');
  await contradict(system, first, { factId: id, amendment: EDGE_AMENDMENT, evidence: 'on a class member.' });
  await answer(app, system.store.listContradictions(id)[0]!.id, { resolution: 'amended' });

  // A third agent hits the same edge and writes the sharper claim, with no id to
  // name. It has to land as agreement: refusing it by the name of a claim nobody
  // is being told is the bar leaking through exactly the containment that makes an
  // amendment an amendment.
  const later = spawnAgent(system, 'issue:99');
  const res = await callTool(system, later, 'knowledge_propose', {
    claim: EDGE_AMENDMENT,
    scope: 'fleet',
    evidence: 'knip stayed red until the method went.',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { corroborations: number; note: string };
  assert.match(payload.note, /corroboration/i);
  assert.equal(payload.corroborations, 2);
  await app.close();
});

test('narrowing rewrites the claim in place and supersedes the amendments it answered', async () => {
  const system = build();
  const app = await serve(system);
  const id = injectedClaim(system, EDGE_CLAIM);
  const agent = spawnAgent(system, 'issue:77');
  await contradict(system, agent, { factId: id, amendment: EDGE_AMENDMENT, evidence: 'on a class member.' });
  const contradiction = system.store.listContradictions(id)[0]!;

  const narrowed = 'Drop the export keyword for a type or a helper; a class member knip reports unused has to go.';
  assert.equal((await answer(app, contradiction.id, { resolution: 'narrowed', claim: narrowed })).status, 200);
  const fact = system.store.getFact(id);
  assert.equal(fact?.claim, narrowed);
  // Still injected, and still the same row — the operator sharpened it rather than
  // replacing it, so nothing about delivery changed but the sentence.
  assert.equal(fact?.reach, 'injected');
  assert.notEqual(fact?.ruledAt, null);
  assert.equal(system.store.getFact(contradiction.amendmentId)?.reach, 'superseded');
  assert.equal(system.store.listContradictions(id)[0]?.resolution, 'narrowed');
  // A narrowing with nothing to narrow to is the one shape of this call that could
  // silently do nothing, so the route refuses it.
  const agent2 = spawnAgent(system, 'issue:88');
  await contradict(system, agent2, { factId: id, amendment: `${narrowed} Except on a generic.`, evidence: 'again.' });
  const second = system.store.listContradictions(id).find((c) => c.resolution === null)!;
  assert.equal((await answer(app, second.id, { resolution: 'narrowed', claim: '  ' })).status, 400);
  await app.close();
});

test('dismissing a contradiction is the only move that leaves the fact where it was', async () => {
  const system = build();
  const app = await serve(system);
  const id = injectedClaim(system, EDGE_CLAIM);
  const agent = spawnAgent(system, 'issue:77');
  await contradict(system, agent, { factId: id, amendment: EDGE_AMENDMENT, evidence: 'on a class member.' });
  const contradiction = system.store.listContradictions(id)[0]!;

  assert.equal((await answer(app, contradiction.id, { resolution: 'dismissed' })).status, 200);
  const fact = system.store.getFact(id);
  assert.equal(fact?.reach, 'injected');
  assert.equal(fact?.claim, EDGE_CLAIM);
  // The amendment is left exactly where it is rather than rejected. Rejecting it
  // would look tidy and would bar the claim it sharpens — an amendment contains its
  // original, and `claimsMatch` is containment — so the next agent to corroborate
  // the standing claim would be refused by the name of the amendment.
  assert.equal(system.store.getFact(contradiction.amendmentId)?.reach, 'proposal');
  assert.equal(system.store.listContradictions(id)[0]?.resolution, 'dismissed');
  // Answered once and not twice: an already-answered dispute is a decision nobody
  // can still make.
  assert.equal((await answer(app, contradiction.id, { resolution: 'amended' })).status, 409);
  assert.equal((await answer(app, 'knx_nothing', { resolution: 'dismissed' })).status, 404);
  await app.close();
});

test('the contradiction ratio is the server’s, and rides the row', async () => {
  const system = build();
  const app = await serve(system);
  const id = injectedClaim(system, EDGE_CLAIM);
  const agent = spawnAgent(system, 'issue:77');
  await contradict(system, agent, { factId: id, amendment: EDGE_AMENDMENT, evidence: 'on a class member.' });

  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledge: { id: string; corroborations: number; contradictions: number; contradictionRatio: number }[];
  };
  const row = snap.knowledge.find((f) => f.id === id);
  // Two goals agree and one disputes, so a third of what has been said about the
  // claim disputes it — the division taken beside the rows it counts, because two
  // counts of *voices* divided in the browser would be arithmetic over numbers
  // whose rule the view layer does not know.
  assert.equal(row?.corroborations, 2);
  assert.equal(row?.contradictions, 1);
  assert.equal(row?.contradictionRatio, 1 / 3);

  // And the words behind both sides come back together, because the decision is
  // between them.
  const detail = (await app.inject({ method: 'GET', url: `/api/knowledge/facts/${id}` })).json() as {
    corroborations: { id: string }[];
    contradictions: { words: string; amendment: { claim: string } | null }[];
  };
  assert.equal(detail.corroborations.length, 2);
  assert.equal(detail.contradictions.length, 1);
  assert.equal(detail.contradictions[0]?.amendment?.claim, EDGE_AMENDMENT);
  await app.close();
});

// -- what nothing does --------------------------------------------------------

test('no rule, desk or gate reads a fact', () => {
  // The stance `src/remedies/remedies.ts` already takes, and the one thing about
  // this subsystem that a reviewer cannot check by reading one file: a fact feeds
  // prompts and a panel, and nothing is dispatched, held or ranked because of one.
  // If this fails, fix the file it names rather than the assertion.
  //
  // The **writers** are matched too, and for the same reason a reader is: a desk
  // that raises a notice or ends a graduation lives outside the dispatcher because
  // what it writes reaches a prompt, and a rule that wrote one would be deciding
  // something on a fact by another name. A new store method belongs in this regex.
  const readers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith('.ts') &&
        /\b(askFacts|listFacts|proposeFact|setFactReach|contradictFact|listContradictions|resolveContradiction|factCounts|commitFact|listGraduations|openGraduations|settleGraduation)\b/.test(
          readFileSync(path, 'utf8'),
        )
      )
        readers.push(path);
    }
  };
  walk('src/dispatcher');
  assert.deepEqual(readers, []);
});
