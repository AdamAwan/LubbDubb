import type Database from 'better-sqlite3';

/** Injectable clock so tests are deterministic. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

/**
 * What a domain module is handed, and the whole of it.
 *
 * Every method in the old single class was `this.db.prepare(...)` plus `this.now()`
 * — no domain reached another through class state — which is what makes the split
 * a move rather than a redesign. Keeping the context this small is what preserves
 * that: a module that needed a *sibling module* would be a cross-domain read
 * hiding inside the persistence layer, and belongs above it in the caller that
 * already has both.
 */
export interface StoreContext {
  readonly db: Database.Database;
  readonly now: Clock;
}
