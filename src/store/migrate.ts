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
 * A table that was **renamed**, declared by the module that owns it — the same rule
 * {@link ColumnMigrations} follows, for the same reason.
 *
 * Distinct from a {@link TableRebuild}: the shape is unchanged and the rows are
 * already right, so there is nothing to copy and nothing to resolve. What makes it
 * a migration at all is that `SCHEMA` creates tables by name, so on a database from
 * before the rename the new name is simply absent — and `CREATE TABLE IF NOT
 * EXISTS` would then make it, empty, beside a full table under the old name that
 * nothing reads any more. Nothing errors; every row that predates the rename is
 * just gone from the harness's point of view.
 *
 * Which is why {@link renameTables} runs **before** the schema pass rather than
 * beside the other migrations: after it, the rename is a no-op forever, because the
 * empty new table already exists.
 *
 * It needs nothing recorded to say it has run. The old name is what says the
 * rename is outstanding, and the rename is what removes it — so a second boot
 * finds nothing to do without having to remember that the first one ran.
 */
export type TableRename = { from: string; to: string };

/**
 * `ALTER TABLE … RENAME TO`, for every declared rename still outstanding.
 *
 * Both names existing is a state nothing can produce — a fresh database has only
 * the new one, a migrated one has only the new one, and an old one has only the
 * old — so it is left alone rather than merged: there is no honest merge, and the
 * untouched old table is the evidence somebody would need.
 */
export function renameTables(db: Database.Database, renames: readonly TableRename[]): void {
  for (const { from, to } of renames) {
    if (!tableExists(db, from) || tableExists(db, to)) continue;
    db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  }
}

/**
 * A table left behind by an arm that was **retired**, declared by the module that
 * owned it — the same rule {@link ColumnMigrations} follows, for the same reason.
 *
 * Deleting `CREATE TABLE IF NOT EXISTS` stops a table being made; it never removes
 * one. So a database from before the retirement keeps the table and its rows for
 * ever, holding disk and answering `.schema` with an arm nobody is running — while
 * a database made afterwards has never heard of it. Two shapes in the field for one
 * build is exactly what the migrations exist to close.
 *
 * **A name goes here only when its rows are re-derivable or worthless**, because
 * unlike a rename this is not reversible and there is no old table left as
 * evidence. `pool_claims` qualifies twice over: it was a mirror of other fleets'
 * documents, rewritten whole on every poll, and nothing has read it since the arm
 * went.
 *
 * **A retired name is never given to a new table.** This runs on every boot — it
 * has to, since a database that has not booted since the retirement is the one
 * still holding the table — so a name re-used later would have its rows dropped on
 * every start, silently, by a migration written years before it.
 * → `docs/spec/14-persistence.md#retiring-a-table`
 */
export function dropRetiredTables(db: Database.Database, tables: readonly string[]): void {
  for (const table of tables) {
    if (!tableExists(db, table)) continue;
    db.exec(`DROP TABLE ${table}`);
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) !== undefined;
}

/**
 * A table whose shape changed in a way `ALTER TABLE` cannot express, declared by
 * the module that owns it — the same rule {@link ColumnMigrations} follows, for
 * the same reason: the question "did this table's new shape get a migration?"
 * must be answerable without leaving the file the new shape was written in.
 *
 * Two kinds reach here, and they are the same problem. A **key** change is not
 * additive. Neither is a **constraint** change: relaxing a `NOT NULL` to nullable,
 * or tightening the other way, is invisible to `ALTER TABLE ADD COLUMN`, and
 * SQLite has no `ALTER COLUMN` at all — so a column declared nullable in `SCHEMA`
 * stays `NOT NULL` forever on every database created before the relaxation, and
 * every writer that means null by it is refused. The only honest answer to either
 * is a rebuild: create the new shape, copy the rows across resolving the old shape
 * into the new one, drop the old table, and put the new one in its place — all
 * inside one transaction, so a crash halfway leaves the old table exactly as it
 * was rather than a half copy nothing knows is half.
 */
export type TableRebuild = {
  table: string;
  /**
   * `INSERT INTO <table> (…) SELECT …` copying the renamed old table's rows into
   * the new one, resolving the old shape into the new. Every column is named
   * explicitly: `SELECT *` would bind by position and silently shift a row's
   * columns along the day either shape gains a field. The database is passed so a
   * copy can ask what the old table actually has — a table that gained an
   * `ALTER TABLE` column between the two shapes carries it on some databases and
   * not others, and naming it unconditionally throws on exactly the oldest ones.
   */
  copy: (old: string, db: Database.Database) => string;
} & (
  | {
      /**
       * The column whose **presence** means this database still carries the old
       * shape. A fresh database gets the new shape from `SCHEMA` and is never
       * rebuilt, and a rebuilt one no longer has the column, so a second run is a
       * no-op rather than a second copy.
       */
      keyedOn: string;
      detect?: undefined;
    }
  | {
      /**
       * What the old shape looks like when no column's presence can say so — a
       * constraint reads off `PRAGMA table_info`, not off a name. It must be false
       * once the rebuild has run, which is what keeps a second boot a no-op; one of
       * the two must be given, which is why they are a union rather than two
       * optional fields that can both be forgotten.
       */
      detect: (db: Database.Database) => boolean;
      keyedOn?: undefined;
    }
);

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
  const stale = rebuilds.filter((r) => (r.detect ? r.detect(db) : hasColumn(db, r.table, r.keyedOn)));
  if (stale.length === 0) {
    createTables();
    return;
  }
  db.transaction(() => {
    for (const r of stale) db.exec(`ALTER TABLE ${r.table} RENAME TO ${r.table}__old`);
    createTables();
    for (const r of stale) db.exec(r.copy(`${r.table}__old`, db));
    for (const r of stale) db.exec(`DROP TABLE ${r.table}__old`);
  })();
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return tableColumns(db, table).some((c) => c.name === column);
}

/**
 * `PRAGMA table_info`, as the two things a rebuild ever asks of it: which columns
 * a table has, and whether one of them is `NOT NULL`.
 */
function tableColumns(db: Database.Database, table: string): { name: string; notnull: number }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
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
