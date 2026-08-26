import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimKey, claimsMatch, claimsSimilar } from '../src/claims.js';
import { KnowledgeClusterDesk, similarPairs } from '../src/knowledge/cluster.js';
import { Store } from '../src/store/store.js';
import type { KnowledgeFact } from '../src/types.js';

/**
 * The advisory matcher and the pass that writes its suggestions down
 * (`docs/spec/27-knowledge.md#one-claim-written-two-ways`).
 *
 * The invariant worth pinning is the separation, not the arithmetic: **one matcher
 * doing both is the version of this that must not be built**. Loosening
 * `claimsMatch` would widen the rejection bar by exactly what it gained in
 * agreement — a claim nobody has rejected refused by name, the agent unable to
 * argue, the operator told nothing — so the strict one is asserted here to be
 * unmoved by everything the advisory one now says yes to.
 */

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

function fact(over: Partial<KnowledgeFact> & { id: string; claim: string }): KnowledgeFact {
  return {
    scope: 'fleet',
    lifetime: 'standing',
    expiresAt: null,
    reach: 'proposal',
    supersedes: null,
    supersededBy: null,
    originRef: 'issue:1',
    ruledAt: null,
    resolvesWhen: null,
    aboutRef: null,
    where: null,
    project: null,
    keepLocal: false,
    createdAt: ago(10),
    updatedAt: ago(10),
    ...over,
  };
}

const ONE =
  'The staging seed script writes its fixtures before the migrations run, so a fresh database comes up with the old column names.';
const OTHER =
  'Fixtures in the staging seed script are written before migrations run, so the column names in a fresh database are the old ones.';

test('the advisory matcher says yes where the strict one says no, and the strict one does not move', () => {
  // The whole cost of prose containment, in two sentences: one wall, two agents,
  // two wordings — and the second call filed a copy instead of becoming the voice
  // that would have carried the first.
  assert.ok(!claimsMatch(claimKey(ONE), claimKey(OTHER)), 'the strict matcher must still refuse this pair');
  assert.ok(claimsSimilar(claimKey(ONE), claimKey(OTHER)), 'and the advisory one must suggest it');
  // Two claims about different things are not a cluster, however much English they
  // share: a page of clusters that are not clusters is a page an operator stops
  // reading, which is the failure this floor is set high to avoid.
  assert.ok(
    !claimsSimilar(claimKey(ONE), claimKey('The worktree pool leases a slot to a branch and wipes it on hand-over.')),
  );
  // And the one thing this must never become: `claimsMatch` is equality or
  // containment, and nothing here has widened it.
  assert.ok(claimsMatch(claimKey('a'), claimKey('a')));
  assert.ok(!claimsMatch(claimKey('rate limit'), claimKey('the rate limiter is wrong on large uploads')));
});

test('the pass suggests within a scope, over proposals, and never what already matches', () => {
  const pairs = similarPairs([
    fact({ id: 'a', claim: ONE, createdAt: ago(30) }),
    fact({ id: 'b', claim: OTHER, createdAt: ago(12) }),
    // Same sentence, another scope. Scope is part of the match everywhere else
    // here: the same claim about one check and about the fleet carry different
    // costs to be wrong and reach different agents.
    fact({ id: 'c', claim: OTHER, scope: 'check:test (windows)' }),
    // Already reaching agents. Offering to fold this into another claim is
    // offering to take what the fleet is being told and hide it inside something
    // else, so the pass does not look at it.
    fact({ id: 'd', claim: OTHER, reach: 'injected' }),
  ]);
  assert.deepEqual(
    pairs.map((p) => [p.leftId, p.rightId]),
    [['a', 'b']],
  );
  // The older id first, so one likeness is one row however the set was walked.
  assert.ok(pairs[0]!.score > 0.6);
});

test('a merge rides superseded, moves the voices, and promotes by the ordinary rule', () => {
  const store = new Store(':memory:');
  const observe = (goal: string, words: string) => ({
    agentId: null,
    taskId: null,
    goalRef: goal,
    sessionId: null,
    words,
  });
  const first = store.proposeFact(
    {
      claim: ONE,
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'saw it',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    observe('issue:1', 'the seed ran first'),
  );
  const second = store.proposeFact(
    {
      claim: OTHER,
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'saw it too',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    observe('issue:2', 'mine came up with the old names'),
  );
  assert.equal(first.outcome, 'filed');
  // The whole problem: the second call was a copy, not a voice — both at proposal,
  // both reaching nobody.
  assert.equal(second.outcome, 'filed');
  assert.ok(first.outcome === 'filed' && second.outcome === 'filed');
  // And the near-match answer the intake gives instead of staying quiet.
  assert.deepEqual(
    second.nearby.map((n) => n.id),
    [first.fact.id],
  );

  // The pass writes the suggestion down, and it decides nothing.
  const desk = new KnowledgeClusterDesk({ store });
  desk.run();
  const suggested = store.listSimilarities();
  assert.equal(suggested.length, 1);
  assert.equal(store.getFact(second.fact.id)?.reach, 'proposal', 'a suggestion must not have moved anything');

  const merged = store.mergeFacts(first.fact.id, [second.fact.id]);
  assert.equal(merged.outcome, 'merged');
  // Superseded and never retired or deleted: four phrasings of one wall are the
  // evidence it was hit four times, and the row goes on saying what it said.
  const member = store.getFact(second.fact.id);
  assert.equal(member?.reach, 'superseded');
  assert.equal(member?.supersededBy, first.fact.id);
  assert.equal(member?.claim, OTHER);
  // The voices moved, and the promotion is the ordinary one on the ordinary rule:
  // two goals carry a claim to lookup, and the merge only let them be counted.
  assert.ok(merged.outcome === 'merged' && merged.corroborations === 2);
  assert.equal(store.getFact(first.fact.id)?.reach, 'lookup');
  // The spent suggestion is gone rather than left offering the same merge again.
  assert.equal(store.listSimilarities().length, 0);
  store.close();
});

test('a merge never crosses a scope, and never folds a claim into a settled one', () => {
  const store = new Store(':memory:');
  const observe = (goal: string) => ({ agentId: null, taskId: null, goalRef: goal, sessionId: null, words: 'saw it' });
  const file = (claim: string, scope: string, goal: string) =>
    store.proposeFact(
      {
        claim,
        scope: scope as KnowledgeFact['scope'],
        lifetime: 'standing',
        expiresInHours: null,
        evidence: 'saw it',
        supersedes: null,
        resolvesWhen: null,
        aboutRef: null,
        where: null,
      },
      observe(goal),
    );
  const fleet = file(ONE, 'fleet', 'issue:1');
  const check = file(OTHER, 'check:test (windows)', 'issue:2');
  assert.ok(fleet.outcome === 'filed' && check.outcome === 'filed');
  const crossed = store.mergeFacts(fleet.fact.id, [check.fact.id]);
  assert.equal(crossed.outcome, 'refused');
  assert.ok(crossed.outcome === 'refused' && /scoped/.test(crossed.error));
  // And both are exactly where they were: a refusal writes nothing.
  assert.equal(store.getFact(check.fact.id)?.reach, 'proposal');

  store.setFactReach(check.fact.id, 'rejected');
  const settled = store.mergeFacts(fleet.fact.id, [check.fact.id]);
  assert.equal(settled.outcome, 'refused');
  assert.equal(store.mergeFacts('fact-nope', [fleet.fact.id]).outcome, 'unknown');
  store.close();
});
