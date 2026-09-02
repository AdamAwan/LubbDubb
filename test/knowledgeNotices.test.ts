import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { KnowledgeNoticeDesk, harnessNotices, noticesSettledBy } from '../src/knowledge/noticeDesk.js';
import { renderKnowledgeBlock } from '../src/knowledge/block.js';
import type { Agent, CiCheck, KnowledgeFact, PullRequest, WorldSnapshot } from '../src/types.js';

/**
 * Notices (issue #27 phase 4, `docs/spec/27-knowledge.md#notices`): the expiring
 * tier, the one thing in this design that reaches every agent without an operator
 * reading it first.
 *
 * The properties asserted here are the ones whose failure is silent. A standing
 * claim that auto-injected would be a false instruction in front of the whole
 * fleet forever; a red→green across a push read as a flake would teach the fleet
 * to disbelieve every check anybody ever fixed; and a notice delivered before it
 * has two voices would let its own delivery manufacture the second.
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-notices-'));
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

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

async function callTool(system: System, agent: Agent, name: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(name, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const FLAKE = 'The install step failed once and passed on the identical commit minutes later.';

// -- the always-injected tier -------------------------------------------------

test('two goals seeing one notice put it in front of every agent; two seeing a standing claim do not', async () => {
  const system = build();
  const first = spawnAgent(system, 'pr:412:ci');
  const filed = await callTool(system, first, 'raise', {
    what: FLAKE,
    scope: 'check:test (windows)',
    why_not_mine: 'Red at 09:02 and green at 09:14 with nothing pushed.',
    until: 8,
  });
  assert.equal(filed.isError, false);
  const one = JSON.parse(filed.text) as { fact: { id: string; reach: string }; corroborations: number };
  // One voice reaches nobody, and that is what stops a notice's own delivery
  // manufacturing its second voice: while it has one corroborator it is a
  // proposal, answered to no ask and riding no prompt, so the second agent to say
  // it cannot have read the first's.
  assert.equal(one.fact.reach, 'proposal');
  assert.equal(system.store.askFacts({ limit: 50 }).length, 0);

  const second = spawnAgent(system, 'pr:517:ci');
  const agreed = await callTool(system, second, 'raise', {
    what: FLAKE,
    scope: 'check:test (windows)',
    why_not_mine: 'Same thing on my pull request an hour later.',
    until: 8,
  });
  const two = JSON.parse(agreed.text) as { fact: { id: string; reach: string }; corroborations: number };
  assert.equal(two.corroborations, 2);
  assert.equal(two.fact.reach, 'injected', 'a notice is injected on corroboration alone — bounded by its clock');
  assert.equal(two.fact.id, one.fact.id);
  // And it is in the block, whatever its scope: a check that flakes flakes for the
  // agent about to run it, not only for the one dispatched to fix it.
  assert.match(renderKnowledgeBlock(system.store.askFacts({ limit: 50 }), 6_000).text, /install step failed once/);

  // The same two goals agreeing about a *standing* claim stop at lookup. Nothing
  // ends a standing claim by itself, so nothing but an operator may put one there.
  const claim = 'A route handler never reads the request; it is wrapped in checked(schemas, handler).';
  await callTool(system, first, 'raise', { what: claim, scope: 'fleet', why_not_mine: 'the wrapper.' });
  const standing = await callTool(system, second, 'raise', { what: claim, scope: 'fleet', why_not_mine: 'me too.' });
  assert.equal((JSON.parse(standing.text) as { fact: { reach: string } }).fact.reach, 'lookup');
  system.store.close();
});

test('the clock is what makes a claim a notice, and without one it is standing', async () => {
  // This asserted a refusal while `knowledge_notice` was its own tool: a notice
  // arriving with no clock would have been a standing fleet-wide claim filed by
  // accident, so the tool refused it. `raise` has no such failure to guard —
  // there is one door and `until` is the discriminator, so the same words with
  // and without it are two different kinds of claim rather than one kind filed
  // wrongly. What still has to hold is that the discriminator *works*: the clock
  // is the entire safety argument for a tier that reaches every agent on
  // agreement alone, so a claim raised without one must not land in it.
  const system = build();
  const agent = spawnAgent(system, 'pr:412:ci');
  const bounded = await callTool(system, agent, 'raise', {
    what: FLAKE,
    scope: 'check:test (windows)',
    why_not_mine: 'saw it.',
    until: 8,
  });
  assert.equal(bounded.isError, false);
  assert.equal((JSON.parse(bounded.text) as { fact: { lifetime: string } }).fact.lifetime, 'expiring');

  const standing = await callTool(system, spawnAgent(system, 'pr:517:ci'), 'raise', {
    what: 'The settings reader resolves paths against repoRoot.',
    scope: 'fleet',
    why_not_mine: 'read it.',
  });
  assert.equal(standing.isError, false);
  assert.equal((JSON.parse(standing.text) as { fact: { lifetime: string } }).fact.lifetime, 'standing');
  system.store.close();
});

// -- what the harness raises for itself ---------------------------------------

function check(name: string, status: CiCheck['status']): CiCheck {
  return { name, status };
}

function pr(over: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    id: `pr_${over.number}`,
    title: `PR ${over.number}`,
    branch: `feat/${over.number}`,
    ciStatus: 'unknown',
    unresolvedComments: [],
    ...over,
  };
}

function world(pullRequests: PullRequest[]): WorldSnapshot {
  return { takenAt: '2026-08-22T09:00:00.000Z', pullRequests, issues: [] };
}

test('a check that went red and green on one commit is an observation; one fixed by a push is not', () => {
  const red = pr({ number: 412, headSha: 'abc1234', ciChecks: [check('test (windows)', 'failing')] });
  const green = pr({ number: 412, headSha: 'abc1234', ciChecks: [check('test (windows)', 'passing')] });
  const [seen] = harnessNotices(world([red]), world([green]));
  assert.ok(seen, 'red then green on the same commit is the reading');
  // The claim names no pull request, which is what lets a second goal's identical
  // sighting corroborate it: `claimsMatch` compares sentences, and a sentence
  // about pr:412 can never be matched by one about pr:517.
  assert.equal(/pr:412/.test(seen.claim), false);
  assert.equal(seen.goalRef, 'pr:412');
  assert.equal(seen.scope, 'check:test (windows)');
  // An observation, never an instruction. There is no "re-run it" here: an agent
  // told to skip a check is an agent that waves a real defect through.
  assert.equal(/re-run|rerun|do not|ignore/i.test(seen.claim), false);

  // A push between the two readings is the ordinary shape of a fix.
  const pushed = pr({ number: 412, headSha: 'def5678', ciChecks: [check('test (windows)', 'passing')] });
  assert.deepEqual(harnessNotices(world([red]), world([pushed])), []);
  // And a provider that reports no commit at all gets silence rather than a guess:
  // absent means the harness cannot say, and a flake claimed on that basis is the
  // notice teaching the fleet to ignore a check that is genuinely broken.
  const nameless = pr({ number: 412, ciChecks: [check('test (windows)', 'passing')] });
  assert.deepEqual(
    harnessNotices(world([pr({ number: 412, ciChecks: [check('test (windows)', 'failing')] })]), world([nameless])),
    [],
  );
  // Nothing at all on the first pulse: every reading here is a comparison.
  assert.deepEqual(harnessNotices(null, world([green])), []);
});

test('a check newly red on a branch other pull requests are based on is raised once, with a way out', () => {
  const baseWas = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'passing')] });
  const baseIs = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'failing')] });
  const rung = pr({ number: 405, baseBranch: 'feat/base' });
  const seen = harnessNotices(world([baseWas, rung]), world([baseIs, rung]));
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.claim, /feat\/base/);
  // The rung, not the base. The count is over goals, so attributing it to the base
  // left the kind with exactly one possible voice for ever: two red bases are two
  // different sentences, and one base going red twice is one goal twice.
  assert.equal(seen[0]!.goalRef, 'pr:405');
  // The condition is the mechanism and the clock the backstop: a base branch that
  // goes green must stop being reported without waiting for a timer, or every
  // agent is told to distrust a check that is now fine.
  assert.deepEqual(seen[0]!.resolvesWhen, { kind: 'ci-check-green', ref: 'pr:404', check: 'check (build)' });
  // Level-triggered would file the same observation on every pulse for as long as
  // the base stayed red — the corroboration table is a record of observations, not
  // a counter.
  assert.deepEqual(harnessNotices(world([baseIs, rung]), world([baseIs, rung])), []);
  // Two rungs on one red base are two voices: each is a separate piece of work the
  // branch is independently holding up, and counting them is the only way this kind
  // ever reaches `injected`.
  const second = pr({ number: 406, baseBranch: 'feat/base' });
  const both = harnessNotices(world([baseWas, rung, second]), world([baseIs, rung, second]));
  assert.equal(both.length, 2);
  assert.deepEqual(
    both.map((o) => o.goalRef).sort(),
    ['pr:405', 'pr:406'],
    'one observation per rung, attributed to that rung',
  );
  assert.equal(both[0]!.claim, both[1]!.claim, 'one sentence, so `claimsMatch` folds them onto one fact');
});

test('two rungs on one red base carry the notice to injected, and the base going green settles it', () => {
  const system = build();
  const desk = new KnowledgeNoticeDesk({ store: system.store });
  const baseGreen = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'passing')] });
  const baseRed = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'failing')] });
  const one = pr({ number: 405, baseBranch: 'feat/base' });
  const two = pr({ number: 406, baseBranch: 'feat/base' });

  desk.run(world([baseGreen, one, two]), world([baseRed, one, two]));
  const [fact] = system.store.listFacts();
  assert.ok(fact);
  assert.equal(
    system.store.listCorroborations(fact.id).length,
    2,
    'each rung the red base holds up is one voice for it',
  );
  // The reason this matters: the resolution condition, the six-hour clock and the
  // cockpit's promise that these reach every agent were all written for a notice
  // that ships. On the base it could never leave `proposal`, which reaches nobody.
  assert.equal(fact.reach, 'injected');
  assert.equal(
    system.store.askFacts({ limit: 50 }).some((f) => f.id === fact.id),
    true,
  );
  // The condition stays anchored to the base — that is where the check goes green.
  assert.deepEqual(fact.resolvesWhen, { kind: 'ci-check-green', ref: 'pr:404', check: 'check (build)' });
  desk.run(world([baseRed, one, two]), world([baseGreen, one, two]));
  assert.equal(
    system.store.askFacts({ limit: 50 }).some((f) => f.id === fact.id),
    false,
    'the base going green ends it without waiting for the clock',
  );
  system.store.close();
});

test('a condition is settled by green, by the check going away, and by the pull request going away', () => {
  const notice = { resolvesWhen: { kind: 'ci-check-green', ref: 'pr:404', check: 'check (build)' } } as KnowledgeFact;
  const still = world([pr({ number: 404, ciChecks: [check('check (build)', 'failing')] })]);
  assert.deepEqual(noticesSettledBy(still, [notice]), []);
  // A re-run in flight is not a green one: resolving on `pending` would drop the
  // notice while what it reported is still true.
  const running = world([pr({ number: 404, ciChecks: [check('check (build)', 'pending')] })]);
  assert.deepEqual(noticesSettledBy(running, [notice]), []);
  const green = world([pr({ number: 404, ciChecks: [check('check (build)', 'passing')] })]);
  assert.deepEqual(noticesSettledBy(green, [notice]), [notice]);
  assert.deepEqual(noticesSettledBy(world([pr({ number: 404 })]), [notice]), [notice]);
  // Merged, so nothing is based on it any more — the commonest way a red base
  // branch stops being anybody's problem.
  assert.deepEqual(noticesSettledBy(world([]), [notice]), [notice]);
});

// -- the desk, against a real store -------------------------------------------

/**
 * The second occurrence is news again.
 *
 * A base branch that goes red, recovers, and goes red again is the case the
 * condition exists for — and the resolved notice must not be the row the second
 * sighting joins. Settling before raising is not what delivers that: resolution
 * writes `expires_at` and nothing else, so a writer matching on scope and reach
 * alone joined the row it had just lapsed, and the fleet was never told the base
 * was red again. The corroboration count went up, the row drew fine, and the
 * harness's own reading landed on a claim nothing answers.
 */
test('a notice resolved and then seen again is raised afresh, not corroborated onto the dead row', () => {
  const system = build();
  const desk = new KnowledgeNoticeDesk({ store: system.store });
  const baseRed = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'failing')] });
  const baseGreen = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'passing')] });
  const rung = pr({ number: 405, baseBranch: 'feat/base' });

  desk.run(world([baseGreen, rung]), world([baseRed, rung]));
  const first = system.store.listFacts().find((f) => f.resolvesWhen !== null)!;
  assert.ok(first);

  desk.run(world([baseRed, rung]), world([baseGreen, rung]));
  const now = new Date().toISOString();
  assert.ok(system.store.getFact(first.id)!.expiresAt! <= now, 'the condition was met, so the notice lapsed');

  desk.run(world([baseGreen, rung]), world([baseRed, rung]));
  assert.equal(system.store.listFacts().length, 2, 'the second red is its own notice, with its own clock');
  assert.equal(system.store.listCorroborations(first.id).length, 1, 'and not a second voice on the lapsed one');
  // One notice anybody could still be told, and it is the new one. The first is
  // still there saying what it said, with its clock spent.
  const live = system.store.listFacts().filter((f) => f.resolvesWhen !== null && f.expiresAt! > now);
  assert.equal(live.length, 1);
  assert.notEqual(live[0]!.id, first.id);
  system.store.close();
});

test('the harness corroborates for itself, and a settled notice leaves every read with its row intact', () => {
  const system = build();
  const desk = new KnowledgeNoticeDesk({ store: system.store });
  const before = (n: number) => pr({ number: n, headSha: 'abc1234', ciChecks: [check('test (windows)', 'failing')] });
  const after = (n: number) => pr({ number: n, headSha: 'abc1234', ciChecks: [check('test (windows)', 'passing')] });

  desk.run(world([before(412)]), world([after(412)]));
  const [fact] = system.store.listFacts();
  assert.ok(fact);
  assert.equal(fact.reach, 'proposal', 'one goal is one corroborator, whoever observed it');
  // The words are the harness's own account, and they are what an operator reads
  // to decide whether the claim should have promoted.
  assert.match(system.store.listCorroborations(fact.id)[0]!.words, /abc1234/);
  assert.equal(system.store.listCorroborations(fact.id)[0]!.agentId, null);

  // The same check on a second goal: a second corroborator, and the harness cannot
  // have been contaminated by the first — which is the whole argument for it
  // corroborating in its own right.
  desk.run(world([before(517)]), world([after(517)]));
  assert.equal(system.store.listFacts().length, 1, 'the same sentence joins the standing claim');
  assert.equal(system.store.getFact(fact.id)?.reach, 'injected');

  // Now the base-branch arm, which has something to wait for.
  const baseRed = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'failing')] });
  const baseGreen = pr({ number: 404, branch: 'feat/base', ciChecks: [check('check (build)', 'passing')] });
  const rung = pr({ number: 405, baseBranch: 'feat/base' });
  desk.run(world([baseGreen, rung]), world([baseRed, rung]));
  const base = system.store.listFacts().find((f) => f.resolvesWhen !== null);
  assert.ok(base, 'the harness notice carries the condition it can settle itself on');

  desk.run(world([baseRed, rung]), world([baseGreen, rung]));
  const settled = system.store.getFact(base.id);
  assert.ok(settled);
  // Lapsed rather than deleted or rejected: out of every read, with the row still
  // saying what it said and when it stopped being said. `rejected` means *not
  // true*, and a notice that was true this morning is not that.
  assert.equal(settled.reach, base.reach);
  assert.ok(settled.expiresAt! <= new Date().toISOString());
  assert.equal(
    system.store.askFacts({ limit: 50 }).some((f) => f.id === base.id),
    false,
  );
  system.store.close();
});
