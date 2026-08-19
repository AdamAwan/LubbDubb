import type Database from 'better-sqlite3';

/**
 * Columns a table gained *after* its original `CREATE`, as `table -> column -> type`.
 *
 * Declared by the domain module that owns the table rather than centrally, so
 * "did this table's new column get an entry?" is a question you can answer
 * without leaving the file you added the column's reader to. `CREATE TABLE IF NOT
 * EXISTS` never alters an existing table, so a column without an entry here is
 * invisible on every database created by an older build.
 */
export type ColumnMigrations = Record<string, Record<string, string>>;

/**
 * Additive and idempotent, so it is safe to run on every boot — and it runs
 * *before* any domain module is constructed, because a module reading a migrated
 * column on a database that predates it would read `undefined`.
 */
/**
 * A table whose **key** changed, declared by the module that owns it — the same
 * rule {@link ColumnMigrations} follows, for the same reason: the question "did
 * this table's new shape get a migration?" must be answerable without leaving the
 * file the new shape was written in.
 *
 * A key change is not additive, so `ALTER TABLE ADD COLUMN` cannot express it and
 * SQLite has no `ALTER COLUMN`. The only honest answer is a rebuild: create the
 * new shape, copy the rows across resolving the old key into the new one, drop
 * the old table, and put the new one in its place — all inside one transaction,
 * so a crash halfway leaves the old table exactly as it was rather than a half
 * copy nothing knows is half.
 */
export interface TableRebuild {
  table: string;
  /**
   * The column whose **presence** means this database still carries the old
   * shape. This is the whole of the detection: a fresh database gets the new
   * shape from `SCHEMA` and is never rebuilt, and a rebuilt one no longer has
   * the column, so a second run is a no-op rather than a second copy.
   */
  keyedOn: string;
  /**
   * `INSERT INTO <table> (…) SELECT …` copying the renamed old table's rows into
   * the new one, resolving the old key into the new. Every column is named
   * explicitly: `SELECT *` would bind by position and silently shift a row's
   * columns along the day either shape gains a field.
   */
  copy: (old: string) => string;
}

/**
 * Rebuild every table whose key changed, then create anything still missing.
 *
 * `createTables` is the schema's own `CREATE TABLE IF NOT EXISTS` pass, taken as
 * an argument rather than duplicated here: a rebuild renames the old table out of
 * the way *first*, so the schema's own definition is what creates the new shape.
 * A second copy of the DDL in a migration is a copy free to drift from the one
 * every fresh database gets, with nothing to catch it.
 */
export function rebuildTables(
  db: Database.Database,
  rebuilds: readonly TableRebuild[],
  createTables: () => void,
): void {
  const stale = rebuilds.filter((r) => hasColumn(db, r.table, r.keyedOn));
  if (stale.length === 0) {
    createTables();
    return;
  }
  db.transaction(() => {
    for (const r of stale) db.exec(`ALTER TABLE ${r.table} RENAME TO ${r.table}__old`);
    createTables();
    for (const r of stale) db.exec(r.copy(`${r.table}__old`));
    for (const r of stale) db.exec(`DROP TABLE ${r.table}__old`);
  })();
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return info.some((c) => c.name === column);
}

/**
 * Returns the columns it actually added, as `table.column`.
 *
 * The return value is for the one kind of column a plain `ALTER TABLE` gets
 * wrong: one whose **null means something** on the rows that predate it. A new
 * `opened_at` is null on every pet in an existing vivarium, and null spells *still
 * an egg* — so a collection raised over months would go back to being shells. The
 * fix is a backfill, and a backfill is only correct **on the boot the column
 * arrives**: run unconditionally on every boot it opens every egg the operator
 * has not got to yet, which is the same silence in the other direction.
 *
 * So this reports, and the composition root gates the backfill on the report.
 */
export function ensureColumns(db: Database.Database, migrations: ColumnMigrations): string[] {
  const added: string[] = [];
  for (const [table, columns] of Object.entries(migrations)) {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      added.push(`${table}.${name}`);
    }
  }
  return added;
}
