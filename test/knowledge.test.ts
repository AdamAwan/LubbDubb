import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { knowledgeBlockCost, KNOWLEDGE_CHARS_PER_TOKEN } from '../src/knowledge/cost.js';
import { checkScopeDrift, checkSightings } from '../src/knowledge/drift.js';
import { resolveWindow } from '../src/insightsWindow.js';
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
    selfUpdate: { enabled: false } as never,
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
    aboutRef: null,
    where: null,
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

/**
 * The writer honours the lapse too, and it is the half that decides whether the
 * fleet is ever told the thing again.
 *
 * A notice that ran out its clock is out of every read, so joining a re-raise to
 * it buries the second occurrence on a row nothing answers — wearing the first
 * one's date and a clock already spent, while the agent is told its call landed
 * as agreement. That is `retired`'s rule, for `retired`'s reason.
 */
test('a re-raise after a notice lapsed files a fresh one, and a rejection still bars however old it is', () => {
  let now = '2026-08-22T09:00:00.000Z';
  const store = new Store(':memory:', () => now);
  const notice = {
    claim: 'The runner is out of disk this afternoon.',
    lifetime: 'expiring',
    expiresInHours: 1,
  } as const;

  const first = store.proposeFact(proposal(notice), seenOn('issue:41'));
  assert.equal(first.outcome, 'filed');

  now = '2026-08-29T09:00:00.000Z'; // a week later; the notice lapsed six days ago
  assert.equal(store.askFacts({ limit: 50 }).length, 0, 'the lapsed row is out of every read');
  const second = store.proposeFact(proposal(notice), seenOn('issue:88'));
  assert.equal(second.outcome, 'filed', 'a second sighting is news again, not agreement with a dead row');
  assert.notEqual(second.fact.id, first.fact.id);
  assert.equal(store.listFacts().length, 2);
  assert.deepEqual(
    store.askFacts({ limit: 50 }).map((f) => f.id),
    [],
    'and the fresh one carries its own clock — one voice, so it is nobody’s yet',
  );
  const third = store.proposeFact(proposal(notice), seenOn('issue:99'));
  assert.equal(third.outcome, 'corroborated', 'the live row is the one a third sighting joins');
  assert.equal(third.fact.id, second.fact.id);

  // The bar is not filtered the same way: a rejection is a ruling with no clock
  // on it, so it bars the claim by name however long ago its row was written.
  const ruled = store.proposeFact(proposal({ claim: 'The staging key is rotated weekly.' }), seenOn('issue:41'));
  assert.ok(ruled.outcome !== 'barred');
  store.setFactReach(ruled.fact.id, 'rejected');
  now = '2027-08-29T09:00:00.000Z';
  assert.equal(store.proposeFact(proposal({ claim: 'The staging key is rotated weekly.' }), seenOn('issue:88')).outcome, 'barred'); // prettier-ignore
  store.close();
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
    aboutRef: null,
    where: null,
    createdAt: now,
    project: null,
    keepLocal: false,
    supersededBy: null,
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

test('a raised claim is attributed to the caller’s own goal', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:part:reader');
  const res = await callTool(system, agent, 'raise', {
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
  await callTool(system, first, 'raise', { claim, scope: 'fleet', evidence: 'saw it in routes.' });
  const second = spawnAgent(system, 'issue:44');
  const res = await callTool(system, second, 'raise', {
    claim,
    scope: 'fleet',
    evidence: 'again, in mine.',
  });
  const payload = JSON.parse(res.text) as { corroborations: number; note: string };
  assert.equal(payload.corroborations, 2);
  assert.match(payload.note, /agreeing with a claim already raised/i);
  assert.equal(system.store.listFacts().length, 1);
  system.store.close();
});

test('agreeWith is a corroboration made on purpose, and the gate is untouched by it', async () => {
  const system = build();
  const first = spawnAgent(system, 'issue:12');
  const filed = await callTool(system, first, 'raise', {
    claim: 'knip runs every rule at error, so an unimported export turns check red.',
    scope: 'fleet',
    evidence: 'check went red on a type nothing named.',
  });
  const id = (JSON.parse(filed.text) as { fact: { id: string } }).fact.id;

  // The one thing that moved nothing: agreement from the goal that raised it. Two
  // *different* goals are what carry a claim to lookup, so an agent agreeing with
  // its own earlier claim is one voice however it spells the call.
  const itself = await callTool(system, first, 'raise', { agreeWith: id, evidence: 'saw it again on my own run.' });
  assert.equal(itself.isError, false);
  assert.equal((JSON.parse(itself.text) as { corroborations: number }).corroborations, 1);
  assert.equal(system.store.getFact(id)?.reach, 'proposal');

  // And the call the agent had no way to make before: it read the claim in its own
  // prompt, hit exactly that wall, and said so — with the matcher not consulted at
  // all, because there was nothing left for it to guess.
  const second = spawnAgent(system, 'issue:44');
  const agreed = await callTool(system, second, 'raise', {
    agreeWith: id,
    evidence: 'my own check failed the same way on an unused type.',
  });
  assert.equal(agreed.isError, false);
  const payload = JSON.parse(agreed.text) as { corroborations: number; agreedWith: { id: string } };
  assert.equal(payload.corroborations, 2);
  assert.equal(payload.agreedWith.id, id);
  // The gate is the gate: two goals carry a claim as far as lookup, and no further.
  assert.equal(system.store.getFact(id)?.reach, 'lookup');
  // A corroboration and never a second row.
  assert.equal(system.store.listFacts().length, 1);
  // The observer's own words, which is what an operator reads to decide whether the
  // claim should have carried — never the claim restated.
  const words = system.store.listCorroborations(id).map((c) => c.words);
  assert.ok(words.some((w) => w.includes('unused type')));
  system.store.close();
});

test('agreeWith is refused where raising the same words would be, and refused by name', async () => {
  const system = build();
  const first = spawnAgent(system, 'issue:12');
  const filed = await callTool(system, first, 'raise', {
    claim: 'The dispatcher reads the lessons table before it ranks anything.',
    scope: 'fleet',
    evidence: 'I assumed so.',
  });
  const id = (JSON.parse(filed.text) as { fact: { id: string } }).fact.id;
  system.store.setFactReach(id, 'rejected');

  const second = spawnAgent(system, 'issue:44');
  const refused = await callTool(system, second, 'raise', { agreeWith: id, evidence: 'I assumed so too.' });
  assert.equal(refused.isError, true);
  // The bar is about the claim and never about the spelling of the call that
  // reaches for it, so the refusal is the same one and carries the same way back.
  assert.match(refused.text, new RegExp(id));
  assert.match(refused.text, /contradicts/);

  // Two rulings on one row is not a call anybody can make, and the refusal says so
  // rather than picking one.
  const both = await callTool(system, second, 'raise', {
    claim: 'It does not.',
    agreeWith: id,
    contradicts: id,
    evidence: 'saw both.',
  });
  assert.equal(both.isError, true);
  assert.match(both.text, /cannot both be present/i);

  // An id that names nothing is a typo the agent can fix this turn, so it comes
  // back as an error rather than a success it would believe.
  const nobody = await callTool(system, second, 'raise', { agreeWith: 'fact-nope', evidence: 'saw it.' });
  assert.equal(nobody.isError, true);
  assert.match(nobody.text, /No claim has that id/);
  system.store.close();
});

test('a barred proposal is refused by name, with the amendment that is the way back', async () => {
  const system = build();
  const claim = 'The dispatcher reads the lessons table before it ranks anything.';
  const first = spawnAgent(system, 'issue:12');
  await callTool(system, first, 'raise', { claim, scope: 'fleet', evidence: 'I assumed so.' });
  const rejected = system.store.listFacts()[0]!;
  system.store.setFactReach(rejected.id, 'rejected');

  const second = spawnAgent(system, 'issue:44');
  const res = await callTool(system, second, 'raise', {
    claim,
    scope: 'fleet',
    evidence: 'I assumed so too.',
  });
  assert.equal(res.isError, true);
  // A silent refusal teaches the fleet nothing and it files the claim again
  // tomorrow, so the refusal names the claim, its id and the amendment arm.
  assert.match(res.text, new RegExp(rejected.id));
  assert.match(res.text, /contradicts/);
  system.store.close();
});

test('knowledge_ask answers from the caller’s own scopes and says so when nothing is on record', async () => {
  const system = build();
  const claim = 'The suite wants a built web bundle first.';
  for (const origin of ['issue:12', 'issue:44']) {
    const agent = spawnAgent(system, origin);
    await callTool(system, agent, 'raise', { claim, scope: 'fleet', evidence: 'the suite failed cold.' });
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
  assert.match(none.note, /raise it/);
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
  await callTool(system, first, 'raise', { claim, scope: 'fleet', evidence: 'saw it in routes.' });
  const second = spawnAgent(system, 'issue:44');
  await callTool(system, second, 'raise', { claim, scope: 'fleet', evidence: 'again, in mine.' });
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
  await callTool(system, third, 'raise', { claim, scope: 'fleet', evidence: 'me too.' });
  assert.equal(heard.length, 2);
  system.store.close();
});

/** Two goals agreeing on one claim — the corroborated proposal the page asks about. */
function store2Goals(system: System): void {
  for (const goal of ['issue:41', 'issue:88']) system.store.proposeFact(proposal(), seenOn(goal));
}

// -- the page -----------------------------------------------------------------

test('the knowledge page and the claim it has open are places, not component state', () => {
  const place = { ...NOWHERE, tab: 'knowledge' as const, fact: 'fact_abc' };
  // A row held open in a `useState` works right up until the back button steps
  // over it, and a tab name `readPlace` does not know is parsed back to the
  // overview — which is a control that opens nothing at all, with nothing red.
  assert.deepEqual(readPlace(placeQuery(place)), place);
  assert.equal(readPlace('?tab=knowledge&fact=').fact, null);

  // Knowledge was a panel until it became a destination, so every link an operator
  // saved to a claim spells `?panel=knowledge`. `knowledge` is not a panel name any
  // more, so without the alias it parses back to null and the link lands on the
  // overview with the fact id still in the URL — a stranded link, and silent.
  const saved = readPlace('?panel=knowledge&fact=fact_abc');
  assert.equal(saved.tab, 'knowledge');
  assert.equal(saved.panel, null);
  assert.equal(saved.fact, 'fact_abc');
  // An explicit tab is the operator saying where they meant to be; an alias for a
  // panel that no longer exists must not overrule one.
  assert.equal(readPlace('?tab=tickets&panel=knowledge').tab, 'tickets');
});

test('the Knowledge badge counts the corroborated claims nobody has ruled on', () => {
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
    consolePanel: null,
    tab: 'knowledge',
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
  const { KNOWLEDGE_GROUPS } = await import('../web/src/cockpit/knowledgeQuery.js');

  const state = buildDemoState().state;
  const draw = (query: {
    view: 'queue' | 'list' | 'table';
    show: 'all' | 'waiting' | 'reaching' | 'settled';
    sort: 'reach' | 'claim' | 'scope' | 'observers' | 'disputes' | 'asks' | 'age';
    desc: boolean;
    fold: string[];
    standing?: string | null;
    open?: string[];
  }): string =>
    renderToStaticMarkup(
      createElement(RefLinks, {
        refUrls: state.refUrls,
        openGoal: () => undefined,
        hasGoal: () => true,
        children: createElement(KnowledgePanel, {
          facts: state.knowledge,
          graduations: state.knowledgeGraduations,
          delivery: state.knowledgeDelivery,
          cost: state.knowledgeCost,
          canFileTickets: state.config.canFileTickets,
          now: Date.now(),
          refUrls: state.refUrls,
          viewingFact: null,
          query: { standing: null, open: [], ...query },
          onQuery: () => undefined,
          onReach: () => undefined,
          onExit: () => undefined,
          onRaise: () => Promise.resolve(undefined),
          onSettleGraduation: () => undefined,
          onDetail: () => Promise.resolve({ corroborations: [], contradictions: [] }),
          onResolveContradiction: () => undefined,
          onViewFact: () => undefined,
          onKeepLocal: () => undefined,
          onMerge: () => undefined,
          similarities: state.knowledgeSimilarities,
        }),
      }),
    );

  // `list`, not the queue a bare URL now means: every assertion below is about the
  // nine headings, which is what `?kn=list` draws and the queue puts behind a click.
  const bare = { view: 'list' as const, show: 'all' as const, sort: 'reach' as const, desc: false };
  // Nothing folded, which is what a bare URL means and what every assertion below
  // is made against: a claim hidden by default would leave no way to tell a list
  // you have finished with from one that lost rows.
  const html = draw({ ...bare, fold: [] });
  // Every tail an operator has collapsed — theirs to do, and never the default.
  const shut = draw({ ...bare, fold: KNOWLEDGE_GROUPS.filter((g) => g.tail).map((g) => g.id) });

  for (const heading of [
    'Live notices',
    'Needs you',
    'Injected',
    'On lookup',
    'One voice',
    'Gone somewhere better',
    'Superseded',
    'Rejected',
  ]) {
    assert.ok(html.includes(heading), `the page draws no ${heading} section`);
    // A tail an operator collapsed still says what it holds: the heading and its
    // count are how the page says a tail is not empty, and a fold must not cost that.
    assert.ok(shut.includes(heading), `a folded tail loses its ${heading} heading`);
  }
  // A tail an operator folded is folded: its rows leave the markup, which is what
  // the fold is for. That it is *their* click and never the page's default is the
  // other half — `test/console.test.ts` asserts the retired claim is on the page as
  // the shell mounts it.
  assert.ok(
    !shut.includes('The dispatcher reads the lessons table'),
    'a folded tail still renders its rows, so the fold buys nothing',
  );
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
  // The three phase 7 readings, all drawn and none of them a control: what the
  // block costs, a check scope that has stopped matching anything, and how often a
  // lookup claim was actually wanted.
  assert.ok(html.includes('a dispatch'), 'the cost per dispatch is not drawn');
  assert.ok(html.includes('scope has drifted'), 'a drifted check scope is not drawn');
  assert.ok(html.includes('asked for 11'), 'the ask count is not drawn');
  assert.ok(html.includes('never asked for'), 'a lookup claim nobody has asked for is not drawn as one');
  // A drifted scope stays exactly where its reach put it. Lifting it out of its
  // section — or into a "stale" one — would draw a demotion that did not happen.
  assert.ok(
    html.indexOf('scope has drifted') > html.indexOf('On lookup'),
    'the drifted claim is not in the section its reach puts it in',
  );
  // An empty heading is drawn on the whole store — that is the page saying a tail
  // is empty rather than missing — and under no narrowing, where it would be eight
  // headings answering a question nobody asked. Narrowed to the settled tail,
  // *Live notices* has nothing in it and is gone entirely: heading and all.
  const settled = draw({ ...bare, show: 'settled', fold: [] });
  assert.ok(!settled.includes('Live notices'), 'a narrowed page draws a heading with nothing under it');
  assert.ok(!settled.includes('Nothing here.'), 'a narrowed page draws an empty section');
  assert.ok(settled.includes('Gone somewhere better'), 'the settled filter drops the tail it is about');
  // What every agent receives is a page-level reading now that the page has a
  // filter, so it survives one: an operator narrowed to the settled tail must not
  // have to un-narrow to find out what the block is costing them.
  assert.ok(settled.includes('a dispatch'), 'the block budget disappears when the page is narrowed');
  // Where a claim went, and where one is going: both drawn as references rather
  // than as text, because a row that names a pull request and offers no way there
  // is a dead end that reads correctly (#27 phase 6).
  assert.ok(html.includes('committed to the document that owns it'), 'a graduated row does not say where it went');
  assert.ok(html.includes('/pull/409'), 'a graduated row does not link to the pull request that put it there');
  assert.ok(html.includes('/pull/411'), 'a graduating row does not link to its open pull request');
  // All three exits, because "three ways a claim leaves" is the page's whole claim
  // and one chip that only ever says "committed" demonstrates a third of it. The
  // job hangs off a **proposal**, which is the case the merge turns on: one agent's
  // report is exactly what every finding was, and queueing work for one asserts
  // nothing.
  assert.ok(html.includes('being worked now'), 'a claim queued as a job is not drawn as one');
  assert.ok(html.includes('filed in the tracker'), 'a claim filed as a ticket is not drawn as one');
  // And a filed one draws the **item**, not a pull request: a `ticket` exit lands
  // on `link_ticket` rather than on the sweep, so there is no pull request to
  // link. It is a `<Ref>` like every other, so with a goal in the world it is the
  // goal button and without one it links out to the tracker — both keyed, which is
  // the whole of what stops the row being a dead end.
  assert.ok(html.includes('>#352<'), 'a filed claim does not draw the ticket it became as a reference');
  // And the claim being written up is still on lookup, still delivered: nothing
  // moved when the operator clicked.
  assert.ok(html.includes('being written up'), 'a graduation in flight is not drawn');
  // The one write here that is not a ruling, and the sentence that keeps it from
  // being a bypass: an operator's own claim lands as one voice, exactly as an
  // agent's does, and a second decision is what puts either in front of the fleet.
  assert.ok(html.includes('Write it down'), 'the operator cannot write a claim down');
  // The page renders `<b>one voice</b>`, so the assertion is on the two runs around
  // it rather than on a string markdown split into elements.
  assert.ok(html.includes('It lands as ') && html.includes('one voice'), 'the composer does not say what it lands as');
  // And the thing no control here may do: nothing files a claim on an agent's
  // behalf, and nothing promotes without somebody saying so.
  assert.ok(!/>File a claim</.test(html), 'nothing on this page files a claim for an agent');

  // The table draws the same store, and draws it whole: a view that quietly held
  // rows back would be a second answer to what the fleet knows.
  const table = draw({ ...bare, view: 'table', fold: [] });
  assert.ok(table.includes('<table'), 'the table view draws no table');
  for (const claim of ['The dispatcher reads the lessons table', 'The seed script leaves two orphaned catalog rows']) {
    assert.ok(table.includes(claim), `the table drops ${claim}`);
  }
  // The composer is above the filter, so it survives every narrowing: writing a
  // claim down is not a thing the page's narrowing has an opinion about.
  assert.ok(settled.includes('Write it down'), 'the composer disappears when the page is narrowed');
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

test('a claim an operator writes down lands as one voice, never in front of the fleet', async () => {
  // The one write on this page that is not a ruling, and the arm `POST /api/lessons`
  // used to be. What made a lesson safe was the gate, so the merged surface must not
  // become one gate and a bypass for whoever happens to be at the keyboard.
  const system = build();
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: '/api/knowledge/facts',
    payload: { claim: 'Take the devops lock before deploying.', originRef: 'issue:41' },
  });
  assert.equal(res.statusCode, 200);

  const [fact] = system.store.listFacts();
  assert.equal(fact?.reach, 'proposal', 'an operator typing a claim is not an operator vouching for one');
  assert.equal(fact?.scope, 'fleet');
  // The provenance a reader dates the claim by, and the one thing about this row
  // that is not true of an agent's: a person asserted it, and the corroboration says
  // so rather than pretending an agent saw something.
  assert.equal(fact?.originRef, 'issue:41');
  assert.match(system.store.listCorroborations(fact!.id)[0]!.words, /An operator wrote this down/);
  assert.equal(system.store.listCorroborations(fact!.id)[0]!.agentId, null);

  // And it reaches nobody until they say so — the block is the whole check, because
  // that is where a claim in front of the fleet would show up.
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeDelivery: { block: string };
  };
  assert.doesNotMatch(snap.knowledgeDelivery.block, /devops lock/);

  // Promoted, it is delivered like any other — the crossing that must not break
  // silently, since a claim that quietly stopped reaching agents looks exactly like
  // one nobody promoted.
  system.store.setFactReach(fact!.id, 'injected');
  const after = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeDelivery: { block: string };
  };
  assert.match(after.knowledgeDelivery.block, /Take the devops lock before deploying\./);
  await app.close();
});

test('the operator arm is bounded by the same rule the intake is, and the bar holds for them too', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const tooLong = await app.inject({
    method: 'POST',
    url: '/api/knowledge/facts',
    payload: { claim: 'x'.repeat(3_000) },
  });
  // One bound, in one place: whichever writer is looser decides what an operator
  // ends up being asked to read, which is why `validateClaimText` has three callers
  // and no copies.
  assert.equal(tooLong.statusCode, 400);
  assert.match((tooLong.json() as { error: string }).error, /2000 characters or fewer/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/knowledge/facts', payload: {} })).statusCode, 400);

  const filed = system.store.proposeFact(proposal({ claim: 'Not actually true.' }), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  system.store.setFactReach(filed.fact.id, 'rejected');
  const barred = await app.inject({
    method: 'POST',
    url: '/api/knowledge/facts',
    payload: { claim: 'Not actually true.' },
  });
  // A rejection is terminal for the person who made it as much as for the fleet:
  // the way back is an amendment naming the claim, not typing it again.
  assert.equal(barred.statusCode, 409);
  assert.match((barred.json() as { error: string }).error, /rejection is terminal/);
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

/**
 * One contradiction through the tool, as the caller sees it.
 *
 * `raise` since the intake: `contradicts` is the discriminator that makes a claim
 * an amendment, and the claim itself is what the old tool called the amendment.
 * The mapping lives here rather than at each call site because the *properties*
 * being asserted below are about contradiction, not about argument names — and
 * `raise` hands both straight to `validateContradiction`, so the refusals the
 * tests match on are the same words as before.
 */
async function contradict(system: System, agent: Agent, args: Record<string, unknown>) {
  const { factId, amendment, ...rest } = args;
  return callTool(system, agent, 'raise', {
    ...rest,
    contradicts: factId,
    ...(amendment === undefined ? {} : { claim: amendment }),
  });
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
    amendment: { id: string; reach: string };
    disputed: { id: string; claim: string };
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
  assert.equal(payload.disputed.id, id);
  // Said in the response, because an agent that believes it has just taken a stale
  // claim off the fleet stops looking at it.
  assert.match(payload.note, /Nothing moved/i);
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
  assert.match(dead.text, /raise it with contradicts/);
  assert.match(dead.text, /contradicts/);

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
  const res = await callTool(system, later, 'raise', {
    claim: EDGE_AMENDMENT,
    scope: 'fleet',
    evidence: 'knip stayed red until the method went.',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { corroborations: number; note: string };
  assert.match(payload.note, /agreeing with a claim already raised/i);
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
        /\b(askFacts|listFacts|listFactsForGoal|getFact|factLabels|proposeFact|setFactReach|contradictFact|listContradictions|resolveContradiction|factCounts|recordFactAsks|exitFact|listGraduations|openGraduations|settleGraduation|findGraduationByJobId|linkGraduationTicket)\b/.test(
          readFileSync(path, 'utf8'),
        )
      )
        readers.push(path);
    }
  };
  walk('src/dispatcher');
  assert.deepEqual(readers, []);
});

/** Every `.ts` under a directory, so a structural assertion cannot miss a file somebody added. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Every way a module could touch this store, so the assertion below can say which
 * of them the tool channel is allowed.
 *
 * Named methods rather than the word "fact", which is a word prompts legitimately
 * use: a prompt that tells an agent the channel exists is the dispatcher describing
 * a tool, not a rule consulting the table, and the thing that would actually break
 * the property is a call.
 */
const FACT_RULINGS = ['setFactReach', 'exitFact', 'resolveContradiction', 'settleGraduation', 'listFacts'];

test('the tool channel may raise and ask, and never rule', () => {
  // The half neither merged store's own rule relaxed, and the one that has to
  // survive there being one store. Raising a claim is a claim an operator still has
  // to read; **ruling** on one would be the gate deciding for the person it exists
  // for, and reading the whole list back would hand an agent the fleet's claims
  // through a side door beside the capped, spec'd block the launch renders.
  //
  // `askFacts` is deliberately absent from the list: answering an agent's ask is
  // what this store is *for*, and it answers only what has reached `lookup`.
  for (const dir of ['src/mcp', 'src/agents']) {
    for (const file of srcFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      for (const method of FACT_RULINGS) {
        assert.equal(source.includes(method), false, `${file} calls ${method}; the channel may raise, never rule`);
      }
    }
  }
  // And the writes it *is* allowed are really there, so this cannot pass by the
  // whole feature having been deleted.
  const channel = srcFiles('src/mcp').map((f) => readFileSync(f, 'utf8'));
  assert.ok(
    channel.some((s) => s.includes('proposeFact')),
    'the intake still raises a claim',
  );
  assert.ok(
    channel.some((s) => s.includes('askKnowledge')),
    'the channel can still be asked',
  );
});

// -- what it costs, and what has drifted (phase 7) ----------------------------

/**
 * Phase 7's row: dollars per dispatch, stale `check:` scopes, and lookup
 * ask-counts. Every one of them is a **reading and never a trigger**, which is
 * what most of what follows asserts — nothing is demoted, lapsed or dropped from
 * a prompt by any of it.
 */

const PRICING_NOW = Date.parse('2026-08-22T12:00:00.000Z');

function run(overrides: Partial<Parameters<typeof knowledgeBlockCost>[0][number]> = {}) {
  return {
    startedAt: '2026-08-22T09:00:00.000Z',
    costUsd: 10,
    inputTokens: 1_000_000,
    cacheReadTokens: 900_000,
    numTurns: 40,
    ...overrides,
  };
}

test('the block is priced at the fleet’s own rate, on every turn rather than once per launch', () => {
  const window = resolveWindow('7d', PRICING_NOW, null);
  const cost = knowledgeBlockCost([run({ numTurns: 40 }), run({ numTurns: 60 })], 4_000, window);
  assert.equal(cost.blockTokens, 4_000 / KNOWLEDGE_CHARS_PER_TOKEN);
  assert.equal(cost.launches, 2);
  assert.equal(cost.turns, 100);
  // 1,000 tokens sent on each of 100 turns, out of 2,000,000 input tokens.
  assert.equal(cost.shareOfInput, 0.05);
  // 5% of the $20 those two runs reported. No price list is consulted: the rate is
  // the fleet's own dollars per input token, and because `inputTokens` is the
  // gross figure it already carries whatever the cache saved.
  assert.equal(cost.windowCostUsd, 1);
  assert.equal(cost.perDispatchUsd, 0.5);
  // Counted once per *launch* instead — which is what "the block is a cached
  // prefix, paid once" reads as — the same block prices at a fiftieth of this,
  // because a session re-sends its system prompt on every turn. The arithmetic
  // looks identical and the answer is off by the fleet's average turn count.
  assert.equal((cost.blockTokens * cost.launches) / cost.inputTokens, 0.001);
});

test('a run outside the window is not counted, and one that reported nothing is unmeasured rather than free', () => {
  const window = resolveWindow('24h', PRICING_NOW, null);
  const cost = knowledgeBlockCost(
    [
      run(),
      // A fortnight ago: it paid for a block, but not for this window's.
      run({ startedAt: '2026-08-08T09:00:00.000Z' }),
      // A PTY run: it carried the same block and reported no usage at all.
      run({ costUsd: null, inputTokens: null, cacheReadTokens: null, numTurns: null }),
    ],
    4_000,
    window,
  );
  assert.equal(cost.launches, 1);
  assert.equal(cost.unmeasured, 1);
  assert.equal(cost.inputTokens, 1_000_000);
});

test('a window nothing measured cannot be priced, and answers null rather than zero', () => {
  const window = resolveWindow('6h', PRICING_NOW, null);
  const cost = knowledgeBlockCost([run({ costUsd: null, inputTokens: null, numTurns: null })], 4_000, window);
  // Null is unmeasured and never free — `Agent.costUsd`'s own convention. A `$0.00`
  // here would be the one figure on the page that is a lie, and it would read as
  // the feature costing nothing.
  assert.equal(cost.perDispatchUsd, null);
  assert.equal(cost.windowCostUsd, null);
  assert.equal(cost.shareOfInput, null);
  assert.equal(cost.unmeasured, 1);
});

test('a check scope is stale only when nothing has matched it and the provider is not reporting it', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number): string => new Date(now - daysAgo * day).toISOString();
  const sightings = checkSightings(
    [
      // A dispatch that carried two checks, seven days ago.
      { originRef: 'pr:412:ci', ciChecks: ['test (windows)', 'lint'], createdAt: at(7) },
      // And one that carried a third, long ago.
      { originRef: 'pr:377:ci', ciChecks: ['test (windows-2019)'], createdAt: at(60) },
    ],
    // The provider is reporting a check nothing has had to be dispatched about —
    // green checks are the normal case, and this half is what stops the reading
    // calling almost every scope stale within a week.
    [{ ciChecks: [{ name: 'build', aliases: ['Build / build'] }] }],
  );
  const opts = { now, staleDays: 30 };
  const fact = (scope: string, daysOld: number) => ({ scope, createdAt: at(daysOld) });

  assert.equal(checkScopeDrift(fact('check:test (windows)', 40), sightings, opts)?.stale, false);
  // Renamed when the matrix moved: no dispatch in sixty days, and the provider
  // reports nothing by that name. The claim is simply not being delivered, and
  // nothing errored when it stopped.
  const drifted = checkScopeDrift(fact('check:test (windows-2019)', 60), sightings, opts);
  assert.equal(drifted?.stale, true);
  assert.equal(drifted?.lastMatchedAt, at(60));
  // Green and running, so not gone — however long since a dispatch answered it.
  assert.equal(checkScopeDrift(fact('check:build', 90), sightings, opts)?.stale, false);
  // An alias is the same check under the name the provider also shows.
  assert.equal(checkScopeDrift(fact('check:Build / build', 90), sightings, opts)?.stale, false);
  // A claim younger than the window cannot be stale: there has not been time.
  assert.equal(checkScopeDrift(fact('check:nightly', 3), sightings, opts)?.stale, false);
  // Zero turns the reading off without demoting anything to achieve it.
  assert.equal(checkScopeDrift(fact('check:nightly', 90), sightings, { now, staleDays: 0 })?.stale, false);
  // And the two scopes that have no such failure are not given a verdict at all.
  assert.equal(checkScopeDrift(fact('fleet', 90), sightings, opts), null);
  assert.equal(checkScopeDrift(fact('goal:issue:41', 90), sightings, opts), null);
});

test('an ask is recorded from the tool, and the cockpit’s own reads of the same store are not asks', async () => {
  const system = build();
  const claim = 'The suite wants a built web bundle first.';
  for (const origin of ['issue:12', 'issue:44']) {
    const agent = spawnAgent(system, origin);
    await callTool(system, agent, 'raise', { claim, scope: 'fleet', evidence: 'the suite failed cold.' });
  }
  const id = system.store.listFacts()[0]!.id;
  assert.equal(system.store.getFact(id)?.reach, 'lookup');
  assert.equal(system.store.factCounts().get(id)?.asks, 0);

  const asker = spawnAgent(system, 'issue:77');
  await callTool(system, asker, 'knowledge_ask', {});
  assert.equal(system.store.factCounts().get(id)?.asks, 1);
  assert.ok(system.store.factCounts().get(id)?.lastAskedAt);

  // The cockpit polls the same store, and `stateSnapshot` reads `askFacts` twice
  // on every poll to project the delivery view. A counter inside that read would
  // count the operator's browser as fleet demand — growing fastest while nobody
  // was looking at the page, and fastest of all on the claims nobody asks for.
  const app = await serve(system);
  for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: '/api/state' });
  system.store.askFacts({ limit: 10 });
  assert.equal(system.store.factCounts().get(id)?.asks, 1);

  // And a second explicit ask *is* demand, even from the same goal: this counts how
  // often the claim was wanted, not how many independent parties will vouch for it.
  await callTool(system, asker, 'knowledge_ask', {});
  assert.equal(system.store.factCounts().get(id)?.asks, 2);
  await app.close();
  system.store.close();
});

test('the snapshot ships the ask count, the drift verdict and the block’s price', async () => {
  const system = build();
  const app = await serve(system);
  // A claim on a check no dispatch has ever carried and no provider is reporting,
  // filed long enough ago for the window to have something to say about it.
  const stale = system.store.proposeFact(
    proposal({ scope: 'check:test (windows-2019)', claim: 'The Windows leg needs npm ci before the rebuild.' }),
    seenOn('pr:377'),
  );
  assert.ok(stale.outcome !== 'barred');
  system.store.setFactReach(stale.fact.id, 'lookup');
  system.store.recordFactAsks([stale.fact.id], {
    agentId: 'agent_1',
    taskId: 'task_1',
    goalRef: 'issue:41',
    sessionId: null,
  });

  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledge: { id: string; asks: number; scopeStale: boolean; scopeLastMatchedAt: string | null }[];
    knowledgeCost: { blockChars: number; charsPerToken: number; perDispatchUsd: number | null; windowLabel: string };
  };
  const row = snap.knowledge.find((f) => f.id === stale.fact.id);
  assert.equal(row?.asks, 1);
  // Filed this instant, so the window has nothing to say yet — a claim younger
  // than `knowledgeScopeStaleDays` cannot be stale, and a page that said otherwise
  // would flag every check claim the day it was written.
  assert.equal(row?.scopeStale, false);
  assert.equal(row?.scopeLastMatchedAt, null);
  // The reading rides the polled snapshot rather than a route of its own: both
  // halves of it are folds over rows the snapshot already holds.
  assert.equal(snap.knowledgeCost.charsPerToken, KNOWLEDGE_CHARS_PER_TOKEN);
  assert.equal(snap.knowledgeCost.windowLabel, '7d');
  // Nothing has been dispatched, so nothing reported usage — and the price is
  // "cannot say" rather than a zero.
  assert.equal(snap.knowledgeCost.perDispatchUsd, null);
  await app.close();
  system.store.close();
});

test('nothing is demoted, lapsed or dropped by a reading', async () => {
  const system = build();
  // A claim on a check nothing runs any more, that nobody has ever asked for.
  const filed = system.store.proposeFact(proposal({ scope: 'check:gone' }), seenOn('issue:41'));
  assert.ok(filed.outcome !== 'barred');
  system.store.setFactReach(filed.fact.id, 'injected');
  const before = system.store.getFact(filed.fact.id);

  const app = await serve(system);
  for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: '/api/state' });

  // Same reach, same clock, still in the block. The cost of a claim, the silence
  // of its scope and the absence of demand are all things to read and none of them
  // is a thing that acts: a claim nobody asked for this month may be the one that
  // saves the next agent a day, and a check that matched nothing may be one that
  // simply is not running this week.
  const after = system.store.getFact(filed.fact.id);
  assert.deepEqual(after, before);
  const snap = (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
    knowledgeDelivery: { rendered: string[] };
  };
  assert.ok(snap.knowledgeDelivery.rendered.includes(filed.fact.id), 'a claim was dropped from the block by a reading');
  await app.close();
  system.store.close();
});
