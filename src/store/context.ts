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

const LABEL_SOURCES = {
  escalations: { table: 'escalations', column: 'prompt' },
  human_tasks: { table: 'human_tasks', column: 'title' },
  jobs: { table: 'jobs', column: 'title' },
  plans: { table: 'plans', column: 'title' },
  stack_landings: { table: 'stack_landings', column: 'ref' },
} as const satisfies Record<string, { readonly table: string; readonly column: string }>;

export function labelsById(
  ctx: StoreContext,
  source: keyof typeof LABEL_SOURCES,
  ids: readonly string[],
): Map<string, string> {
  if (ids.length === 0) return new Map();
  const { table, column } = LABEL_SOURCES[source];
  const holes = ids.map(() => '?').join(',');
  // A variable-length `IN` list is not memoised: → 14-persistence.md#compiled-statements-are-memoised-per-connection
  const rows = ctx.db.prepare(`SELECT id, ${column} AS label FROM ${table} WHERE id IN (${holes})`).all(...ids) as {
    id: string;
    label: string;
  }[];
  return new Map(rows.map((r) => [r.id, r.label]));
}
