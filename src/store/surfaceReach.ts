import type { SurfaceReach, SurfaceReachInput } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class SurfaceReachStore {
  private lastPrunedAt: number | null = null;

  constructor(private readonly ctx: StoreContext) {}

  recordSurfaceReach(rows: readonly SurfaceReachInput[]): number {
    if (rows.length === 0) return 0;
    const at = this.ctx.now();
    const insert = this.ctx.db.prepare(
      `INSERT INTO surface_reach (subject, verb, place, at, arrival) VALUES (@subject, @verb, @place, @at, @arrival)`,
    );
    const all = this.ctx.db.transaction((batch: readonly SurfaceReachInput[]) => {
      for (const row of batch) insert.run({ ...row, at });
    });
    all(rows);
    return rows.length;
  }

  listSurfaceReachSince(since: string): SurfaceReach[] {
    const rows = this.ctx.db
      .prepare(`SELECT subject, verb, place, at, arrival FROM surface_reach WHERE at >= ? ORDER BY at ASC, rowid ASC`)
      .all(since) as SurfaceReachRow[];
    return rows.map(rowToReach);
  }

  linkedSubjectsEverReached(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT DISTINCT subject FROM surface_reach WHERE arrival = 'linked'`).all() as {
      subject: string;
    }[];
    return new Set(rows.map((r) => r.subject));
  }

  pruneSurfaceReach(force = false): number {
    const nowMs = Date.parse(this.ctx.now());
    if (!force && this.lastPrunedAt !== null && nowMs - this.lastPrunedAt < PRUNE_INTERVAL_MS) return 0;
    this.lastPrunedAt = nowMs;
    const cutoff = new Date(nowMs - RETENTION_DAYS * DAY_MS).toISOString();
    return this.ctx.db.prepare(`DELETE FROM surface_reach WHERE at < ?`).run(cutoff).changes;
  }
}

const RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

interface SurfaceReachRow {
  subject: string;
  verb: string;
  place: string;
  at: string;
  arrival: string;
}

function rowToReach(r: SurfaceReachRow): SurfaceReach {
  return {
    subject: r.subject as SurfaceReach['subject'],
    verb: r.verb as SurfaceReach['verb'],
    place: r.place as SurfaceReach['place'],
    at: r.at,
    arrival: r.arrival as SurfaceReach['arrival'],
  };
}
