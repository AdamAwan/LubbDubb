import { nanoid } from 'nanoid';
import type { ErrorLogEntry, ErrorLogInput } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class ErrorStore {
  constructor(private readonly ctx: StoreContext) {}

  recordError(input: ErrorLogInput): ErrorLogEntry {
    const entry: ErrorLogEntry = {
      id: `err_${nanoid(10)}`,
      createdAt: this.ctx.now(),
      source: input.source,
      message: input.message,
      detail: input.detail ?? null,
    };
    this.ctx.db
      .prepare(`INSERT INTO error_events (id, source, message, detail, created_at) VALUES (?,?,?,?,?)`)
      .run(entry.id, entry.source, entry.message, entry.detail, entry.createdAt);
    return entry;
  }

  listErrorsSince(since: string): ErrorLogEntry[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM error_events WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as ErrorEventRow[];
    return rows.map(rowToErrorEntry);
  }

  listErrors(limit = 100): ErrorLogEntry[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM error_events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as ErrorEventRow[];
    return rows.map(rowToErrorEntry);
  }

  clearErrors(): number {
    return this.ctx.db.prepare(`DELETE FROM error_events`).run().changes;
  }
}

interface ErrorEventRow {
  id: string;
  source: string;
  message: string;
  detail: string | null;
  created_at: string;
}

function rowToErrorEntry(r: ErrorEventRow): ErrorLogEntry {
  return {
    id: r.id,
    source: r.source as ErrorLogEntry['source'],
    message: r.message,
    detail: r.detail,
    createdAt: r.created_at,
  };
}
