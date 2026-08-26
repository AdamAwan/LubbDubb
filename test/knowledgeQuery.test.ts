import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupFor,
  inQueueFold,
  inShow,
  KNOWLEDGE_GROUPS,
  nextSort,
  QUEUE_FOLDS,
  queueNext,
  queueOrder,
  queueStanding,
  sortFacts,
  waitingOn,
} from '../web/src/cockpit/knowledgeQuery.js';
import type { KnowledgeFactView, KnowledgeGraduationView } from '../src/wire.js';

/**
 * How the Knowledge page groups, narrows and orders what the store ships.
 *
 * The panel is a `.tsx` no test can import, so the arithmetic lives beside
 * `place.ts`'s and is asserted here. What is worth pinning is not that a filter
 * filters — it is the one invariant the page's shape could break silently:
 * **a reading narrows the page and never moves a claim**, because a disputed
 * claim lifted out of Injected would draw a demotion that did not happen.
 * → docs/spec/27-knowledge.md#in-the-cockpit
 */

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

function fact(over: Partial<KnowledgeFactView> = {}): KnowledgeFactView {
  return {
    id: 'fact-1',
    claim: 'A claim.',
    scope: 'fleet',
    lifetime: 'standing',
    expiresAt: null,
    reach: 'proposal',
    supersedes: null,
    project: null,
    keepLocal: false,
    originRef: 'issue:1',
    ruledAt: null,
    resolvesWhen: null,
    aboutRef: null,
    where: null,
    createdAt: ago(24),
    updatedAt: ago(24),
    corroborations: 1,
    contradictions: 0,
    contradictionRatio: 0,
    openContradictions: 0,
    asks: 0,
    lastAskedAt: null,
    scopeStale: false,
    scopeLastMatchedAt: null,
    cold: false,
    ...over,
  };
}

const graduation = (reading: KnowledgeGraduationView['reading']): KnowledgeGraduationView => ({
  id: 'grad-1',
  factId: 'fact-1',
  exit: 'docs',
  target: 'spec',
  bar: null,
  prRef: 'pr:9',
  ticketRef: null,
  jobId: 'job-1',
  outcome: null,
  settledAt: null,
  reading,
  createdAt: ago(48),
});

test('every reach a fact can carry has a heading to sit under', () => {
  const reaches: KnowledgeFactView['reach'][] = [
    'proposal',
    'lookup',
    'injected',
    'graduated',
    'superseded',
    'retired',
    'rejected',
  ];
  for (const reach of reaches) {
    const id = groupFor(fact({ reach, ruledAt: ago(1) }), NOW);
    assert.ok(
      KNOWLEDGE_GROUPS.some((group) => group.id === id),
      `a ${reach} claim lands in ${id}, which is no heading on the page`,
    );
  }
});

test('a live notice is a notice; a lapsed one falls back to its reach', () => {
  const live = fact({ lifetime: 'expiring', expiresAt: new Date(NOW + 3_600_000).toISOString(), reach: 'injected' });
  assert.equal(groupFor(live, NOW), 'notices');
  // Out of every read once it lapses, but the row still says what it said — so it
  // falls through to the group its reach puts it in rather than vanishing.
  assert.equal(groupFor({ ...live, expiresAt: ago(1) }, NOW), 'injected');
});

test('a corroborated claim nobody has ruled on is Needs you, and a ruled one is not', () => {
  assert.equal(groupFor(fact({ reach: 'lookup', ruledAt: null }), NOW), 'needsYou');
  assert.equal(groupFor(fact({ reach: 'lookup', ruledAt: ago(2) }), NOW), 'lookup');
});

test('waiting on you gathers four readings across three reach states', () => {
  const none = new Set<string>();
  assert.match(
    waitingOn(fact({ reach: 'lookup', ruledAt: null, corroborations: 2 }), null, none) ?? '',
    /as far as agreement can carry/,
  );
  assert.match(waitingOn(fact({ reach: 'injected', openContradictions: 2 }), null, none) ?? '', /2 disputes are/);
  assert.match(waitingOn(fact({ reach: 'injected' }), null, new Set(['fact-1'])) ?? '', /character cap/);
  assert.match(waitingOn(fact({ reach: 'lookup', ruledAt: ago(2), scopeStale: true }), null, none) ?? '', /scope/);
  assert.match(waitingOn(fact({ reach: 'injected' }), graduation('unknown'), none) ?? '', /seen closed/);
  // A graduation the harness *did* read is not a question for anybody.
  assert.equal(waitingOn(fact({ reach: 'injected' }), graduation('waiting'), none), null);
  assert.equal(waitingOn(fact({ reach: 'injected' }), null, none), null);
});

test('a terminal claim asks nothing, however it is marked', () => {
  const none = new Set<string>();
  // A rejection is barred from coming back and a superseded wording has a sharper
  // claim standing in its place, so a dispute against either is not actionable —
  // and a retired claim was pruned rather than judged.
  for (const reach of ['rejected', 'superseded', 'retired'] as const) {
    assert.equal(waitingOn(fact({ reach, openContradictions: 3, scopeStale: true }), null, none), null, reach);
  }
});

test('the filter narrows the page and moves nothing', () => {
  const disputed = fact({ reach: 'injected', openContradictions: 1 });
  const why = waitingOn(disputed, null, new Set());
  assert.ok(why !== null);
  // It is in the *waiting* filter…
  assert.equal(inShow('waiting', disputed, why), true);
  assert.equal(inShow('reaching', disputed, why), true);
  assert.equal(inShow('settled', disputed, why), false);
  // …and still under the heading its reach puts it in, which is the whole of the
  // invariant: lifting it out would draw a demotion that did not happen.
  assert.equal(groupFor(disputed, NOW), 'injected');
});

test('every claim is in All, and the three narrowings partition nothing away by accident', () => {
  const rows = [
    fact({ id: 'a', reach: 'proposal' }),
    fact({ id: 'b', reach: 'lookup', ruledAt: null }),
    fact({ id: 'c', reach: 'injected' }),
    fact({ id: 'd', reach: 'graduated' }),
    fact({ id: 'e', reach: 'rejected' }),
  ];
  assert.equal(rows.filter((f) => inShow('all', f, null)).length, rows.length);
  assert.deepEqual(
    rows.filter((f) => inShow('reaching', f, null)).map((f) => f.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    rows.filter((f) => inShow('settled', f, null)).map((f) => f.id),
    ['d', 'e'],
  );
});

test('the table orders by any reading, and ties fall to the newest', () => {
  const rows = [
    fact({ id: 'old', asks: 3, createdAt: ago(100) }),
    fact({ id: 'new', asks: 3, createdAt: ago(2) }),
    fact({ id: 'most', asks: 11, createdAt: ago(50) }),
  ];
  assert.deepEqual(
    sortFacts(rows, NOW, 'asks', true).map((f) => f.id),
    ['most', 'new', 'old'],
  );
  assert.deepEqual(
    sortFacts(rows, NOW, 'asks', false).map((f) => f.id),
    ['new', 'old', 'most'],
  );
  // The tie-break is the same at both ends: `old` and `new` read 3 either way, and
  // a direction that reversed them too would shuffle equal rows on every click.
  // Reach order is the page's own heading order, so the table and the list agree
  // about what comes first.
  const byReach = sortFacts(
    [fact({ id: 'rejected', reach: 'rejected' }), fact({ id: 'needs', reach: 'lookup', ruledAt: null })],
    NOW,
    'reach',
    false,
  );
  assert.deepEqual(
    byReach.map((f) => f.id),
    ['needs', 'rejected'],
  );
});

test('sorting never drops or invents a row', () => {
  const rows = [fact({ id: 'a' }), fact({ id: 'b', asks: 4 }), fact({ id: 'c', corroborations: 9 })];
  for (const key of ['reach', 'claim', 'scope', 'observers', 'disputes', 'asks', 'age'] as const) {
    const out = sortFacts(rows, NOW, key, false);
    assert.deepEqual(out.map((f) => f.id).sort(), ['a', 'b', 'c'], `sorting by ${key} changed the store`);
  }
});

test('a count column opens on the end worth reading, and clicking it again flips it', () => {
  // Ascending on a page where most rows read zero is a screen of zeroes.
  assert.deepEqual(nextSort('reach', false, 'asks'), { knowledgeSort: 'asks', knowledgeDesc: true });
  assert.deepEqual(nextSort('reach', false, 'claim'), { knowledgeSort: 'claim', knowledgeDesc: false });
  assert.deepEqual(nextSort('asks', true, 'asks'), { knowledgeSort: 'asks', knowledgeDesc: false });
  assert.deepEqual(nextSort('asks', false, 'asks'), { knowledgeSort: 'asks', knowledgeDesc: true });
});

test('only the tails may be folded, and nothing that reaches an agent may be', () => {
  // A page that can hide what the fleet is being told is not a governance surface,
  // so these three carry no fold at all — and the tails that do start open.
  const fixed = KNOWLEDGE_GROUPS.filter((group) => !group.tail).map((group) => group.id);
  assert.deepEqual(fixed, ['notices', 'needsYou', 'injected']);
  // Every heading carries the paragraph it used to say out loud: the words are the
  // page's only statement of several of these invariants, and a tooltip with
  // nothing in it is how they would be lost.
  for (const group of KNOWLEDGE_GROUPS) {
    assert.ok(group.blurb.length > 80, `${group.id} has no blurb to put in its tooltip`);
  }
});

test('the queue is the filter, oldest first', () => {
  // One predicate, three readings of it: the card that is drawn, the count on the
  // heading and the reason on the row. A queue built from a second copy of
  // `waitingOn` is a queue that says four and holds three.
  const old = fact({ id: 'old', reach: 'lookup', createdAt: ago(24 * 9) });
  const recent = fact({ id: 'recent', reach: 'lookup', createdAt: ago(2) });
  const settled = fact({ id: 'settled', reach: 'retired', createdAt: ago(24 * 30) });
  const facts = [recent, settled, old];
  const waiting = new Map<string, string>();
  for (const f of facts) {
    const why = waitingOn(f, null, new Set());
    if (why !== null) waiting.set(f.id, why);
  }
  const order = queueOrder(facts, waiting);
  // Oldest first: a queue whose top is the same claim every morning is a queue an
  // operator stops opening, and the one they keep skipping has to come back up.
  assert.deepEqual(
    order.map((f) => f.id),
    ['old', 'recent'],
  );
  // A retired claim asks nothing however it is marked, so it is not in the queue —
  // and it is not moved by being left out of one, which is the same rule the filter
  // keeps: this narrows, it never re-homes.
  assert.equal(groupFor(settled, NOW), 'retired');
});

test('the queue stands where the address bar says, and falls forward when that claim is dealt with', () => {
  const first = fact({ id: 'a', reach: 'lookup', createdAt: ago(48) });
  const second = fact({ id: 'b', reach: 'lookup', createdAt: ago(24) });
  const order = [first, second];
  assert.equal(queueStanding(order, null)?.id, 'a', 'a bare link opens on the oldest');
  assert.equal(queueStanding(order, 'b')?.id, 'b', '?q= is where the operator is standing');
  // The ordinary case, and why a stale id is not an error worth a screen: the moment
  // a claim is ruled on it stops being waited on, so `?q=` names a card that is no
  // longer in the queue and the next one is what should be in front of them.
  assert.equal(queueStanding([second], 'a')?.id, 'b');
  assert.equal(queueStanding([], 'a'), null);
  // Later advances and writes nothing — it steps through the queue's own order.
  assert.equal(queueNext(order, first)?.id, 'b');
  assert.equal(queueNext(order, second), null);
});

test('the queue folds hold the cold, the settled and the store — and never what reaches an agent', () => {
  assert.deepEqual(
    QUEUE_FOLDS.map((fold) => fold.id),
    ['cold', 'settled', 'store'],
  );
  for (const fold of QUEUE_FOLDS) {
    assert.ok(fold.blurb.length > 80, `${fold.id} has no blurb to put in its tooltip`);
  }
  const cold = fact({ id: 'cold', reach: 'proposal', cold: true });
  const injected = fact({ id: 'hot', reach: 'injected' });
  assert.ok(inQueueFold('cold', cold));
  assert.ok(!inQueueFold('cold', injected));
  assert.ok(!inQueueFold('settled', injected));
  assert.ok(inQueueFold('settled', fact({ reach: 'rejected' })));
  // The whole store is the whole store: the table behind the third fold is not a
  // second narrowing of the page.
  assert.ok(inQueueFold('store', injected) && inQueueFold('store', cold));
  // Cold is read off the row and never taken here: an age against a configured
  // window computed in the browser is free to disagree with the count on the fold.
  assert.ok(!inQueueFold('cold', fact({ id: 'old', reach: 'proposal', createdAt: ago(24 * 400), cold: false })));
});
