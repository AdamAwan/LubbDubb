import type Database from 'better-sqlite3';

// → docs/spec/14-persistence.md

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export interface StoreContext {
  readonly db: Database.Database;
  readonly now: Clock;
}
