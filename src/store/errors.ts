import { nanoid } from 'nanoid';
import type { ErrorLogEntry, ErrorLogInput } from '../types.js';
import type { StoreContext } from './context.js';

/** The `error_events` table: a list an operator reads and clears, nothing decides on. */
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

  listErrors(limit = 100): ErrorLogEntry[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM error_events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as ErrorEventRow[];
    return rows.map(rowToErrorEntry);
  }

  /**
   * Drop the whole error log, returning how many rows went.
   *
   * A delete rather than an acknowledged-up-to watermark: the log is a list an
   * operator reads and clears, not a record anything decides on — nothing in the
   * harness reads `error_events` back, so a row nobody has read is the only thing
   * it can lose. All of it, never a slice: "clear the faults I can see" is a
   * different sentence on a list the server truncates at 100, and the second
   * cockpit watching would disagree with the first about which those were.
   */
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
