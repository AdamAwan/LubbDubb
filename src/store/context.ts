import type Database from 'better-sqlite3';

// → docs/spec/14-persistence.md

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export function createPrepare(db: Database.Database): (sql: string) => Database.Statement {
  const cache = new Map<string, Database.Statement>();
  return (sql) => {
    let statement = cache.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };
}

export interface StoreContext {
  readonly db: Database.Database;
  readonly now: Clock;
  readonly prep: (sql: string) => Database.Statement;
}
