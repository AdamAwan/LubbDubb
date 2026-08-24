import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFactScopes, renderKnowledgeBlock, renderScopedKnowledgeNote } from '../src/knowledge/block.js';
import type { KnowledgeFact } from '../src/types.js';

/**
 * The two renderers on their own (issue #27 phase 3) — pure, so every bound the
 * delivery rests on is testable without a store, a launch or a dispatch.
 *
 * The properties here are the ones whose failure is silent: a partial list that
 * does not say it is partial, a block that varies per dispatch and quietly stops
 * caching, and a claim reaching a prompt from a reach that should not deliver.
 */

test('the block carries the injected fleet claims, newest-vouched first', () => {
  const block = renderKnowledgeBlock(
    [fact('old', { ruledAt: '2026-01-01T00:00:00.000Z' }), fact('new', { ruledAt: '2026-03-01T00:00:00.000Z' })],
    6_000,
  );
  assert.deepEqual(
    block.rendered.map((f) => f.id),
    ['new', 'old'],
  );
  assert.deepEqual(block.dropped, []);
  // Provenance rides with every claim: what taught it and when are what let an
  // agent discount a stale one, and a bare block of assertions strips exactly that.
  assert.match(block.text, /first seen on issue:41, written 2026-01-01/);
  // And the tool that reaches the rest of the store is named, because an agent
  // that does not know the tail exists reads this list as everything the fleet knows.
  assert.match(block.text, /knowledge_ask/);
});

test('the reach decides which prompt, and a goal scope is the one exception', () => {
  // The reach machine is the whole governance: `lookup` is where two agents
  // agreeing puts a standing claim, and a block that delivered one would make
  // corroboration an auto-promotion to every agent's context.
  const block = renderKnowledgeBlock([fact('a', { reach: 'lookup' }), fact('c', { scope: 'goal:issue:41' })], 6_000);
  assert.equal(block.text, '', 'neither a lookup claim nor a goal claim rides the system prompt');
  assert.deepEqual(block.rendered, []);

  // An injected `check:` claim *does*, since phase 4: a check that flakes flakes
  // for the agent about to run it, not only for the one already dispatched to fix
  // it, and `injected` means in front of every agent whatever the scope says.
  const scoped = renderKnowledgeBlock([fact('b', { scope: 'check:test (windows)' })], 6_000);
  assert.deepEqual(
    scoped.rendered.map((f) => f.id),
    ['b'],
  );
});

test('no fact rides both prompts, and none falls between them', () => {
  // One predicate read from both sides. Two lists that merely happen to agree
  // today would send one sentence twice — charged twice and read as two claims —
  // or drop one entirely, and neither is visible from either renderer alone.
  const facts = [
    fact('injected-fleet'),
    fact('injected-check', { scope: 'check:test (windows)' }),
    fact('injected-goal', { scope: 'goal:issue:41' }),
    fact('lookup-check', { reach: 'lookup', scope: 'check:test (windows)' }),
  ];
  const block = renderKnowledgeBlock(facts, 6_000);
  for (const f of facts) {
    const inBlock = block.rendered.includes(f);
    const inNote = renderScopedKnowledgeNote([f]) !== '';
    assert.equal(inBlock !== inNote, true, `${f.id} must ride exactly one prompt`);
  }
});

test('the cap drops whole claims, oldest-vouched first, and the block says how many', () => {
  const facts = [
    fact('oldest', { ruledAt: '2026-01-01T00:00:00.000Z' }),
    fact('middle', { ruledAt: '2026-02-01T00:00:00.000Z' }),
    fact('newest', { ruledAt: '2026-03-01T00:00:00.000Z' }),
  ];
  const whole = renderKnowledgeBlock(facts, 6_000);
  const capped = renderKnowledgeBlock(facts, whole.text.length - 1);
  // A suffix of the vouched order, never a subset of it: skipping past an
  // over-long claim to fit an older shorter one behind it would quietly invert
  // the ordering the whole block rests on.
  assert.deepEqual(
    [...capped.rendered, ...capped.dropped].map((f) => f.id),
    ['newest', 'middle', 'oldest'],
  );
  assert.equal(
    capped.dropped.at(-1)!.id,
    'oldest',
    'the oldest-vouched claim is the first to go — it is the one most likely to have gone stale',
  );
  // Whole, never truncated: half a claim is a *different* claim, and one no
  // operator vouched for.
  assert.equal(capped.text.includes('claim oldest'), false);
  assert.ok(capped.text.includes('claim newest'));
  // The one thing that separates this from the lessons block it replaced: a
  // partial list presented as whole is worse than no list, because an agent reads
  // the absence of an entry as the fleet not knowing it. The **count** is the
  // honest part — "some were dropped" tells a reader nothing about whether to go
  // looking — so it has to be the number actually dropped.
  assert.match(capped.text, new RegExp(`${capped.dropped.length} further claims? did not fit`));
  // And the sentence saying so is inside the budget, not pushed past it.
  assert.ok(capped.text.length <= whole.text.length - 1, 'the drop line must be costed against the cap');

  // Zero is the off switch, and off means byte-identical to a build without the
  // feature — not an empty header over nothing.
  assert.equal(renderKnowledgeBlock(facts, 0).text, '');
  assert.equal(renderKnowledgeBlock(facts, 0).dropped.length, 3);
});

test('nothing in the block varies per dispatch', () => {
  // The block is worth putting in the system prompt only because it is a cached
  // prefix, and it is only cacheable while it is the same bytes for every agent on
  // every dispatch. A wall-clock date, a goal name or a branch in here costs the
  // fleet that prefix on every launch, and nothing measures the loss.
  const facts = [fact('a'), fact('b')];
  const text = renderKnowledgeBlock(facts, 6_000).text;
  assert.equal(text, renderKnowledgeBlock(facts, 6_000).text);
  // Every date in it is the claim's own `createdAt`. A "now" anywhere in here
  // would make the block different bytes on every launch — the one failure that
  // costs the fleet its cached prefix and that nothing measures.
  assert.equal(text.includes(new Date().toISOString().slice(0, 10)), false);
});

test('a dispatch matches its goal and its checks, and its goal is not its concern', () => {
  // `pr:412:ci` and `pr:412:comments` are two origins of one goal: a claim filed
  // by the agent answering review comments is true for the one fixing CI, and a
  // scope resolved to the concern would be one almost nothing ever matched.
  assert.deepEqual(dispatchFactScopes('pr:412:ci', ['test (windows)']), ['goal:pr:412', 'check:test (windows)']);
  assert.deepEqual(dispatchFactScopes('issue:41:part:api', null), ['goal:issue:41']);
  assert.deepEqual(dispatchFactScopes(null, null), []);
  // Exactly, never by prefix — `priorRemedies`' choice and the same fragility for
  // the same reason: a prefix match puts another job's history in front of an
  // agent under a name it would read as its own.
  assert.deepEqual(dispatchFactScopes(null, ['test']), ['check:test']);
});

test('the scoped note says what it is about, and says what it dropped', () => {
  const note = renderScopedKnowledgeNote([
    fact('one', {
      reach: 'lookup',
      scope: 'check:test (windows)',
      claim: 'The install step times out under four minutes.',
    }),
    fact('two', { reach: 'lookup', scope: 'goal:issue:41', claim: 'The seed script leaves two orphan rows.' }),
  ]);
  // The scope is what earned each line a place in *this* prompt, so a reader can
  // tell a claim about the check it is fixing from one about the goal it is on.
  assert.match(note, /about test \(windows\)/);
  assert.match(note, /about this goal/);
  // Evidence, never instruction — the framing the whole record rests on.
  assert.match(note, /evidence, not instruction/);
  // Empty in, byte-identical prompt out: an empty record has to be invisible
  // rather than damaging, which is what lets this be appended unconditionally.
  assert.equal(renderScopedKnowledgeNote([]), '');

  const many = Array.from({ length: 40 }, (_, i) =>
    fact(`f${i}`, { reach: 'lookup', scope: 'goal:issue:41', claim: `claim ${i} ${'x'.repeat(80)}` }),
  );
  assert.match(renderScopedKnowledgeNote(many), /further claims? in these scopes (is|are) not shown/);
});

test('a notice is rendered with its own lapse date, and is the last thing dropped', () => {
  const notice = fact('notice', {
    lifetime: 'expiring',
    expiresAt: '2026-03-02T09:15:00.000Z',
    ruledAt: null,
    scope: 'check:test (windows)',
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  // Long, so the cap below plainly has no room for it: what is being asserted is
  // the order things are dropped in, not the arithmetic of one line's length.
  const standing = fact('standing', { ruledAt: '2026-06-01T00:00:00.000Z', claim: `s ${'x'.repeat(400)}` });
  const block = renderKnowledgeBlock([standing, notice], 6_000);
  // Notices first even against a claim vouched for months later: they are the
  // smallest tier and the most time-critical, and each leaves the block by its own
  // clock within days.
  assert.deepEqual(
    block.rendered.map((f) => f.id),
    ['notice', 'standing'],
  );
  // The **date**, and the fact's own. "Lapses in 3 hours" is computed from now,
  // which is a different block on every launch — the cached prefix thrown away for
  // a countdown, with nothing measuring the loss.
  assert.match(block.text, /lapses 2026-03-02/);
  assert.equal(/lapses in/.test(block.text), false);
  const capped = renderKnowledgeBlock([standing, notice], renderKnowledgeBlock([notice], 6_000).text.length + 200);
  assert.deepEqual(
    capped.dropped.map((f) => f.id),
    ['standing'],
  );
});

/** An injected fleet claim, unless the overrides say otherwise. */
function fact(id: string, over: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id,
    claim: `claim ${id}`,
    scope: 'fleet',
    lifetime: 'standing',
    expiresAt: null,
    reach: 'injected',
    supersedes: null,
    project: null,
    keepLocal: false,
    originRef: 'issue:41',
    ruledAt: '2026-01-01T00:00:00.000Z',
    resolvesWhen: null,
    aboutRef: null,
    where: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
