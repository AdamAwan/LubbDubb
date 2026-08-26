import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCold } from '../src/knowledge/cold.js';
import type { KnowledgeFact } from '../src/types.js';

/**
 * What has gone cold — the reading that lets an operator drain a store whose only
 * exit is a person (`docs/spec/27-knowledge.md#what-has-gone-cold`).
 *
 * What is worth pinning is not that a date comparison compares dates. It is the
 * narrowness the reading is safe *because of*: cold is defined over `proposal`
 * alone, so there is no prompt it can take a claim out of and no reach it can
 * move. A version of this that answered true for a `lookup` or an `injected` claim
 * would be a demotion by a clock the claim never carried, and the page would fold
 * away what the fleet is being told.
 */

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

function fact(over: Partial<KnowledgeFact> = {}): Pick<KnowledgeFact, 'reach' | 'createdAt' | 'ruledAt'> {
  return { reach: 'proposal', createdAt: ago(90), ruledAt: null, ...over };
}

const alone = { corroborations: 1, asks: 0 };
const opts = { now: NOW, coldDays: 30 };

test('cold is a proposal nobody agreed with, nobody asked for and nobody ruled on', () => {
  assert.ok(isCold(fact(), alone, opts));
  // Younger than the window: nothing here is about how *good* a claim is, only
  // about how long it has sat with nothing happening to it.
  assert.ok(!isCold(fact({ createdAt: ago(29) }), alone, opts));
  // Agreement is what moves a proposal, so a second voice is the whole answer —
  // and the case that matters most is a corroboration arriving through a merge:
  // four cold singletons are one warm claim with four voices.
  assert.ok(!isCold(fact(), { corroborations: 2, asks: 0 }, opts));
  // An agent went looking for it, which is the other thing that makes a claim
  // wanted. Nothing is demoted for want of demand and nothing is folded despite it.
  assert.ok(!isCold(fact(), { corroborations: 1, asks: 1 }, opts));
  // An operator who has read this claim and left it where it is has ruled on it;
  // folding it away would hide the one proposal a person has actually looked at.
  assert.ok(!isCold(fact({ ruledAt: ago(60) }), alone, opts));
});

test('cold answers only for a proposal, which is what makes it act on nothing', () => {
  // Every other reach reaches somebody: `lookup` answers an ask and rides the
  // dispatches its scope matches, `injected` is in every prompt, and the four
  // settled ones are a record. A fold over any of them would hide what the fleet is
  // being told or what it was told — so the reading refuses them by construction
  // rather than by the page remembering to.
  for (const reach of ['lookup', 'injected', 'graduated', 'superseded', 'retired', 'rejected'] as const) {
    assert.ok(!isCold(fact({ reach }), alone, opts), `${reach} must never read as cold`);
  }
});

test('zero turns the reading off, and nothing folds the store away', () => {
  assert.ok(!isCold(fact(), alone, { now: NOW, coldDays: 0 }));
  // A negative number is the same instruction spelled by an operator who typed
  // one — never a window so wide it swallows everything ever filed.
  assert.ok(!isCold(fact(), alone, { now: NOW, coldDays: -1 }));
});
