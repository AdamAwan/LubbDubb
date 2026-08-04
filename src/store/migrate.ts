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
export function ensureColumns(db: Database.Database, migrations: ColumnMigrations): void {
  for (const [table, columns] of Object.entries(migrations)) {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}
