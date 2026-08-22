import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRaise, validateRaisedContradiction } from '../src/knowledge/knowledge.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent } from '../src/types.js';

/**
 * The unified intake's pure layer.
 *
 * What is worth asserting here is not that the fields parse — `validateFactProposal`
 * already has that covered and this delegates to it — but the three places `raise`
 * *removes* a decision the caller used to have to make, and the one place it
 * refuses rather than guessing. Each of those is a silent failure if it goes the
 * other way: a claim buried on the goal that learned it, a standing fleet-wide
 * claim filed by an agent that meant to file a notice, an amendment recorded as an
 * undisputed refinement, or a claim filed against the wrong `#41`.
 *
 * → `docs/spec/27-knowledge.md`
 */

const GOAL = 'issue:41';

test('scope defaults to fleet rather than to the goal that happened to learn it', () => {
  const parsed = validateRaise({ claim: 'knip runs every rule at error', evidence: 'check went red' }, GOAL);
  assert.ok(parsed.ok);
  assert.equal(parsed.proposal.scope, 'fleet');
  // The default is a default and not a ceiling: an agent that has thought about it
  // still says so, and a goal scope resolves from the credential rather than an
  // argument — which is what stops one agent scoping a claim to another's goal.
  const scoped = validateRaise({ claim: 'the fixture needs a built bundle', evidence: 'saw it', scope: 'goal' }, GOAL);
  assert.ok(scoped.ok);
  assert.equal(scoped.proposal.scope, `goal:${GOAL}`);
});

test('an agent with no goal behind it is refused the goal scope rather than widened to fleet', () => {
  // The silent widening this refusal exists to prevent: an agent handed a success
  // believes it filed a note about one goal, and what it filed reaches every agent.
  const parsed = validateRaise({ claim: 'a claim', evidence: 'saw it', scope: 'goal' }, null);
  assert.equal(parsed.ok, false);
});

test('the presence of `until` is the whole of the lifetime decision', () => {
  const standing = validateRaise({ claim: 'a standing claim', evidence: 'saw it' }, GOAL);
  assert.ok(standing.ok);
  assert.equal(standing.proposal.lifetime, 'standing');
  assert.equal(standing.proposal.expiresInHours, null);

  const notice = validateRaise({ claim: 'the registry is refusing installs', evidence: 'saw it', until: 6 }, GOAL);
  assert.ok(notice.ok);
  assert.equal(notice.proposal.lifetime, 'expiring');
  assert.equal(notice.proposal.expiresInHours, 6);
});

test('a clock outside the notice bound is refused, so a standing claim cannot be filed wearing one', () => {
  // A notice reaches every agent on agreement alone, and what makes that safe is
  // that it ends by itself. A clock long enough to outlive the condition is a
  // standing fleet-wide claim that nobody vouched for.
  assert.equal(validateRaise({ claim: 'c', evidence: 'e', until: 10_000 }, GOAL).ok, false);
  assert.equal(validateRaise({ claim: 'c', evidence: 'e', until: 0 }, GOAL).ok, false);
  assert.equal(validateRaise({ claim: 'c', evidence: 'e', until: 'soon' }, GOAL).ok, false);
});

test('a ref names a world item in the closed vocabulary, and a bare number is refused', () => {
  const parsed = validateRaise({ claim: 'this duplicates the other one', evidence: 'read both', ref: 'PR:412' }, GOAL);
  assert.ok(parsed.ok);
  assert.equal(parsed.proposal.aboutRef, 'pr:412');

  // Suffix-tolerant, so a dispatch origin passes back verbatim.
  const origin = validateRaise({ claim: 'c', evidence: 'e', ref: 'pr:412:ci' }, GOAL);
  assert.ok(origin.ok);
  assert.equal(origin.proposal.aboutRef, 'pr:412');

  // Refused rather than guessed: there is nothing here to tell issue #41 from
  // pull request #41, and a claim filed against the wrong one is worse than one
  // filed against neither.
  assert.equal(validateRaise({ claim: 'c', evidence: 'e', ref: '41' }, GOAL).ok, false);
  assert.equal(validateRaise({ claim: 'c', evidence: 'e', ref: 'the other one' }, GOAL).ok, false);
});

test('the claim is what it is about, never the origin the raiser happened to be on', () => {
  // The defect `findingJobRequest` already refuses by carrying `finding.ref`: an
  // agent on issue:41 that says pr:412 duplicates pr:398 is talking about neither
  // of its own origin. Nothing in the parsed proposal takes the caller's origin.
  const parsed = validateRaise({ claim: 'pr:412 duplicates pr:398', evidence: 'read both', ref: 'pr:412' }, GOAL);
  assert.ok(parsed.ok);
  assert.equal(parsed.proposal.aboutRef, 'pr:412');
  assert.notEqual(parsed.proposal.aboutRef, GOAL);
});

test('a locator is optional and bounded, so nothing arrives as "N/A" or as a second claim', () => {
  const none = validateRaise({ claim: 'c', evidence: 'e' }, GOAL);
  assert.ok(none.ok);
  assert.equal(none.proposal.where, null);

  const located = validateRaise({ claim: 'c', evidence: 'e', where: '  src/store/store.ts:311  ' }, GOAL);
  assert.ok(located.ok);
  assert.equal(located.proposal.where, 'src/store/store.ts:311');

  assert.equal(validateRaise({ claim: 'c', evidence: 'e', where: 'x'.repeat(201) }, GOAL).ok, false);
});

test('`contradicts` reads the raised claim as the amendment, and refuses a bare objection', () => {
  const parsed = validateRaisedContradiction({
    claim: 'knip runs every rule at error EXCEPT in test files',
    evidence: 'an unimported export in test/ passed check',
    contradicts: 'fact_1',
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.contradiction, {
    factId: 'fact_1',
    amendment: 'knip runs every rule at error EXCEPT in test files',
    evidence: 'an unimported export in test/ passed check',
  });

  // A contradiction with no claim behind it is a bare objection, and nothing here
  // is demoted by count — so it is refused rather than recorded as a vote.
  assert.equal(validateRaisedContradiction({ evidence: 'it is wrong', contradicts: 'fact_1' }).ok, false);
});

test('evidence is required, because a claim with no observation behind it is a guess', () => {
  assert.equal(validateRaise({ claim: 'a claim with nothing behind it' }, GOAL).ok, false);
  assert.equal(validateRaise({ evidence: 'saw something, said nothing' }, GOAL).ok, false);
});

// -- through the real tool channel -------------------------------------------

/**
 * The routing, asserted at the seam an agent actually reaches it through. The
 * pure layer above says what each field means; these say that a single call lands
 * in the right place without the caller having chosen one.
 */

test('a raised claim lands as a proposal attributed to the caller’s own goal', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12:part:reader');
  const res = await callTool(system, agent, 'raise', {
    claim: 'A route handler never reads the request; it is wrapped in checked(schemas, handler).',
    evidence: 'The structural test over src/server/routes failed until I used the wrapper.',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { fact: { id: string; reach: string; scope: string; lifetime: string } };
  assert.equal(payload.fact.reach, 'proposal');
  assert.equal(payload.fact.scope, 'fleet');
  assert.equal(payload.fact.lifetime, 'standing');
  // Attribution is the credential's, and it is the *goal* rather than the part
  // origin the dispatch used — the same collapse every other write in the channel
  // gets, and the reason `raise` takes no author argument to be wrong about.
  assert.equal(system.store.getFact(payload.fact.id)?.originRef, 'issue:12');
  system.store.close();
});

test('a raised claim carrying `until` lands as a notice, without the agent naming a lifetime', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'raise', {
    claim: 'test (windows) has been timing out at the install step all afternoon.',
    evidence: 'Four runs on three commits, each dying at npm ci after 6 minutes.',
    scope: 'check:test (windows)',
    until: 8,
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { fact: { id: string; lifetime: string } };
  assert.equal(payload.fact.lifetime, 'expiring');
  const fact = system.store.getFact(payload.fact.id);
  assert.ok(fact?.expiresAt, 'an expiring fact carries the moment it lapses');
  // The condition stays the harness's: an agent naming one would be naming a thing
  // nothing watches, and the notice would be a clock claiming to be a mechanism.
  assert.equal(fact?.resolvesWhen, null);
  system.store.close();
});

test('the locators land on the fact, so a claim about another item is not filed under the raiser’s goal', async () => {
  const system = build();
  const agent = spawnAgent(system, 'issue:12');
  const res = await callTool(system, agent, 'raise', {
    claim: 'pr:412 is the same work as pr:398 — both rewrite the worktree lease.',
    evidence: 'Read both diffs; they touch the same three functions.',
    ref: 'pr:412',
    where: 'src/worktree/worktreeManager.ts',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { fact: { id: string } };
  const fact = system.store.getFact(payload.fact.id);
  assert.equal(fact?.aboutRef, 'pr:412');
  assert.equal(fact?.where, 'src/worktree/worktreeManager.ts');
  // The two are different questions, and this is the case where the answers differ.
  assert.equal(fact?.originRef, 'issue:12');
  system.store.close();
});

test('a second agent on a second goal is told it agreed rather than filed', async () => {
  const system = build();
  const claim = 'The suite wants a built web bundle before it will run.';
  await callTool(system, spawnAgent(system, 'issue:12'), 'raise', { claim, evidence: 'It failed cold.' });
  const res = await callTool(system, spawnAgent(system, 'issue:13'), 'raise', {
    claim,
    evidence: 'Same here, on a clean checkout.',
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { corroborations: number; note: string };
  assert.equal(payload.corroborations, 2);
  // Said in the response, not only in the description: an agent that reads a
  // returned id as proof it filed something new says the same thing again, louder.
  assert.match(payload.note, /agreeing/i);
  system.store.close();
});

test('`contradicts` routes to a contradiction, and moves nothing', async () => {
  const system = build();
  const claim = 'knip runs every rule at error.';
  const filed = await callTool(system, spawnAgent(system, 'issue:12'), 'raise', {
    claim,
    evidence: 'An unimported export turned check red.',
  });
  const { fact } = JSON.parse(filed.text) as { fact: { id: string } };
  // Carried to `lookup` first, because a proposal cannot be contradicted: one
  // agent said it, nothing has agreed, it rides no prompt and is answered to
  // nobody — so there is nothing to take off the fleet.
  await callTool(system, spawnAgent(system, 'issue:14'), 'raise', { claim, evidence: 'Again, in mine.' });
  assert.equal(system.store.getFact(fact.id)?.reach, 'lookup');

  const res = await callTool(system, spawnAgent(system, 'issue:13'), 'raise', {
    claim: 'knip runs every rule at error, except that a type reached structurally reads as unused.',
    evidence: 'The method was called through a seam and knip still flagged it.',
    contradicts: fact.id,
  });
  assert.equal(res.isError, false);
  const payload = JSON.parse(res.text) as { disputed: { id: string }; amendment: { id: string } };
  assert.equal(payload.disputed.id, fact.id);
  assert.notEqual(payload.amendment.id, fact.id);
  // A contradiction neither deletes, lapses nor demotes what it names: the only
  // things that end a fact are its own clock and an operator.
  assert.equal(system.store.getFact(fact.id)?.reach, 'lookup');
  // And the amendment is its own row rather than a corroboration of its parent —
  // folding it in would discard the correction and leave the blunter claim
  // standing with one more voice behind it.
  assert.equal(system.store.getFact(payload.amendment.id)?.supersedes, fact.id);
  system.store.close();
});

test('an id that names nothing comes back as a fixable error rather than a silent success', async () => {
  const system = build();
  const res = await callTool(system, spawnAgent(system, 'issue:12'), 'raise', {
    claim: 'a sharper version',
    evidence: 'saw it',
    contradicts: 'fact_nothing',
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /knowledge_ask/);
  system.store.close();
});

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * `test/knowledge.test.ts`'s build, verbatim and for its reasons: an in-memory
 * database, every seam faked, and a heartbeat long enough not to run — a pulse
 * inside a tool test is a second writer nothing here is asserting about, and it
 * keeps the process alive after the assertions are done.
 *
 * `worktrees` is a fake rather than an omission: `config.repoRoot` defaults to
 * `process.cwd()`, so a test that spawns an agent without one cuts a real branch
 * in whatever checkout the suite is running in.
 * → `docs/spec/19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager`
 */
function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-raise-'));
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
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
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

// -- retiring is a prune, rejecting is a bar ---------------------------------

/**
 * The two used to be one word.
 *
 * `lessons` called its prune `retired` and allowed the claim to be written again;
 * `knowledge_facts` called its terminal ruling `rejected` and barred it by name.
 * Merged onto one surface with one set of buttons, an operator tidying a claim
 * nobody had vouched for would have barred it forever — including the agent that
 * hits the same wall next quarter and is refused for saying something true.
 *
 * → `docs/spec/27-knowledge.md#retiring-is-not-rejecting`
 */

test('a retired claim may be raised again, and the re-raise is a fresh row with a fresh date', async () => {
  const system = build();
  const claim = 'The fixture server has to be started before the integration suite.';
  const filed = await callTool(system, spawnAgent(system, 'issue:12'), 'raise', { claim, evidence: 'It hung.' });
  const first = (JSON.parse(filed.text) as { fact: { id: string } }).fact.id;
  system.store.setFactReach(first, 'retired');
  assert.equal(system.store.getFact(first)?.reach, 'retired');

  const again = await callTool(system, spawnAgent(system, 'issue:13'), 'raise', {
    claim,
    evidence: 'Hung for me too, on a clean checkout.',
  });
  assert.equal(again.isError, false, 'a prune is not a bar');
  const second = (JSON.parse(again.text) as { fact: { id: string } }).fact.id;
  // A fresh row rather than the retired one brought back to life: a claim worth
  // returning is worth reading first, and it returns with its own evidence and its
  // own date rather than a judgement nobody has revisited.
  assert.notEqual(second, first);
  assert.equal(system.store.getFact(first)?.reach, 'retired', 'and the retired row stays where it was');
  system.store.close();
});

test('a rejected claim is still refused by name, with the way back', async () => {
  const system = build();
  const claim = 'Every route handler should read the request body itself.';
  const filed = await callTool(system, spawnAgent(system, 'issue:12'), 'raise', { claim, evidence: 'I assumed so.' });
  const id = (JSON.parse(filed.text) as { fact: { id: string } }).fact.id;
  system.store.setFactReach(id, 'rejected');

  const again = await callTool(system, spawnAgent(system, 'issue:13'), 'raise', { claim, evidence: 'Me too.' });
  assert.equal(again.isError, true);
  assert.match(again.text, /rejected/i);
  // Refused by name and with the way back, so the fleet does not raise it again
  // tomorrow having learned nothing from the refusal.
  assert.ok(again.text.includes(id));
  assert.match(again.text, /contradicts/);
  system.store.close();
});

test('a retired claim is out of every read, and reaches nobody', async () => {
  const system = build();
  const claim = 'knip runs every rule at error.';
  const filed = await callTool(system, spawnAgent(system, 'issue:12'), 'raise', { claim, evidence: 'Saw it.' });
  const id = (JSON.parse(filed.text) as { fact: { id: string } }).fact.id;
  system.store.setFactReach(id, 'injected');
  assert.ok(
    system.store.askFacts({ question: null }).some((f) => f.id === id),
    'an injected claim is answerable',
  );

  system.store.setFactReach(id, 'retired');
  assert.equal(
    system.store.askFacts({ question: null }).some((f) => f.id === id),
    false,
    'a retired one is out of every read — the row stays, saying what it said',
  );
  system.store.close();
});

test('retiring is reversible where rejecting is not', async () => {
  const system = build();
  const filed = await callTool(system, spawnAgent(system, 'issue:12'), 'raise', {
    claim: 'The suite wants a built bundle first.',
    evidence: 'It failed cold.',
  });
  const id = (JSON.parse(filed.text) as { fact: { id: string } }).fact.id;

  system.store.setFactReach(id, 'retired');
  // A prune has to be the cheap act: an operator who has to be sure before tidying
  // is an operator who does not tidy, and a store nobody prunes is the failure the
  // whole design fears.
  assert.equal(system.store.setFactReach(id, 'lookup')?.reach, 'lookup');

  system.store.setFactReach(id, 'rejected');
  assert.equal(system.store.setFactReach(id, 'lookup'), null, 'a bar is not lifted by a click');
  system.store.close();
});
