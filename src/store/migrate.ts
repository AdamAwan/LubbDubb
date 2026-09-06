import type Database from 'better-sqlite3';

// → docs/spec/14-persistence.md

export type ColumnMigrations = Record<string, Record<string, string>>;

export type TableRename = { from: string; to: string };

export function renameTables(db: Database.Database, renames: readonly TableRename[]): void {
  for (const { from, to } of renames) {
    if (!tableExists(db, from) || tableExists(db, to)) continue;
    db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  }
}

export function dropRetiredTables(db: Database.Database, tables: readonly string[]): void {
  for (const table of tables) {
    if (!tableExists(db, table)) continue;
    db.exec(`DROP TABLE ${table}`);
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) !== undefined;
}

export type TableRebuild = {
  table: string;
  copy: (old: string, db: Database.Database) => string;
} & (
  | {
      keyedOn: string;
      detect?: undefined;
    }
  | {
      detect: (db: Database.Database) => boolean;
      keyedOn?: undefined;
    }
);

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

function tableColumns(db: Database.Database, table: string): { name: string; notnull: number }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
}

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
