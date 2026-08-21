import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import {
  corroborationGoal,
  distinctCorroborators,
  MAX_CLAIM_CHARS,
  MAX_EVIDENCE_CHARS,
  questionScore,
  resolveFactScope,
  validateFactProposal,
  type FactProposal,
} from '../src/knowledge/knowledge.js';
import type { Agent, FactObservation } from '../src/types.js';

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
  assert.equal(stale.reach, 'lookup');
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

// -- what nothing does --------------------------------------------------------

test('no rule, desk or gate reads a fact', () => {
  // The stance `src/remedies/remedies.ts` already takes, and the one thing about
  // this subsystem that a reviewer cannot check by reading one file: a fact feeds
  // prompts and a panel, and nothing is dispatched, held or ranked because of one.
  // If this fails, fix the file it names rather than the assertion.
  const readers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith('.ts') &&
        /\b(askFacts|listFacts|proposeFact|setFactReach)\b/.test(readFileSync(path, 'utf8'))
      )
        readers.push(path);
    }
  };
  walk('src/dispatcher');
  assert.deepEqual(readers, []);
});
