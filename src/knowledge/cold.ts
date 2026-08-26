import type { KnowledgeFact } from '../types.js';

/**
 * What has gone cold: a `proposal` nobody agreed with, nobody asked for, and
 * nobody has ruled on since it was filed (`docs/spec/27-knowledge.md#what-has-gone-cold`).
 *
 * **Derived, never recorded**, for `scopeStale`'s reason exactly: a recorder is a
 * second record that has to be kept true, and one that quietly stopped writing
 * would reproduce the silence it exists to reveal.
 *
 * **It is a reading and it acts on nothing.** Cold is defined only over
 * `proposal` — the one reach that reaches nobody — so there is no prompt it can
 * take a claim out of and no reach it can move. What it changes is what the page
 * draws: a cold claim goes behind a counted fold rather than out of the store, and
 * the row goes on saying exactly what it said. Pointed at any live reach it would
 * be a demotion by a clock the claim never carried, which is the thing this store
 * refuses everywhere else.
 *
 * Pure — no I/O, no clock, no store.
 */
export function isCold(
  fact: Pick<KnowledgeFact, 'reach' | 'createdAt' | 'ruledAt'>,
  counts: { corroborations: number; asks: number },
  opts: { now: number; coldDays: number },
): boolean {
  // `0` turns the reading off, and a negative number is the same instruction
  // spelled by an operator who typed one — never a fold that swallows the store.
  if (opts.coldDays <= 0) return false;
  if (fact.reach !== 'proposal') return false;
  // An operator who has already looked at this claim and left it where it is has
  // ruled on it; folding it away would hide the one proposal a person has read.
  if (fact.ruledAt !== null) return false;
  // One voice is its author's. Anything above it is a claim two goals have seen,
  // which the store has already carried out of `proposal` — the guard is here for
  // the row that has agreement but has not been re-read since.
  if (counts.corroborations > 1) return false;
  if (counts.asks > 0) return false;
  const age = opts.now - new Date(fact.createdAt).getTime();
  return age > opts.coldDays * 24 * 60 * 60 * 1_000;
}
