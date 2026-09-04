import type { SurfaceReach, SurfaceReachInput } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `surface_reach` table: what an operator looked at, and what they did there.
 *
 * A brand-new table, so no `ColumnMigrations` entry — but being new *once* does
 * not keep it exempt, and a column added to it later needs one
 * (`docs/spec/14-persistence.md#migrations`).
 *
 * Built to `src/store/mcpCalls.ts`' three properties, none of them optional:
 *
 * 1. **Nothing gates on it.** No dispatch rule, desk or tool reads this store;
 *    the only reader is `buildSurfaceReach`. That is what makes recording safe to
 *    do on the path it observes.
 * 2. **The write is called for its effect and its return is discarded.** A
 *    telemetry write that can turn a working navigation into a failed one is
 *    worse than no telemetry, so {@link recordSurfaceReach} refuses rather than
 *    throws, and its count is for the caller that wants to log it.
 * 3. **Retention is stated and bounded** — {@link RETENTION_DAYS}, matching the
 *    digest's, dropped from the back. An unbounded table on a deployment that has
 *    been running for two years is a slow reading nobody sees coming.
 *
 * → `docs/spec/33-usage-metrics.md#the-one-new-table`
 */
export class SurfaceReachStore {
  /**
   * When the retention sweep last ran, as ms since epoch, or null if it has not
   * this process.
   *
   * In memory rather than on a row for `McpCallStore`'s reason: it is a rate limit
   * and not a fact, the sweep is idempotent, and the worst a lost value can do is
   * run it once more on the next boot.
   */
  private lastPrunedAt: number | null = null;

  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record a batch, stamped as it lands, and answer how many rows went in.
   *
   * **The whole batch is one transaction**, which is what makes a flush either
   * present or absent rather than half-present: a coalesced navigation is several
   * rows that describe one stretch, and half of them is a reading nobody can tell
   * from a quiet operator.
   *
   * The return is discarded by the route. It exists for a caller that wants to
   * log it, exactly as `compactMcpCallArgs`' does.
   */
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

  /**
   * Every row at or after `since`, oldest first — the ordering every other
   * windowed read in this store uses.
   */
  listSurfaceReachSince(since: string): SurfaceReach[] {
    const rows = this.ctx.db
      .prepare(`SELECT subject, verb, place, at, arrival FROM surface_reach WHERE at >= ? ORDER BY at ASC, rowid ASC`)
      .all(since) as SurfaceReachRow[];
    return rows.map(rowToReach);
  }

  /**
   * Which subjects have ever been reached by a **link**, over all time.
   *
   * Deliberately *not* windowed, and it is the one read here that is not — for
   * `lastMcpCallByTool`'s reason exactly. `never-linked` is a claim about the
   * cockpit's own navigation rather than about this week's operator: a subject the
   * product has drawn a link to at some point is reachable, and a window that
   * happens not to contain that navigation does not make it unreachable. Scoped to
   * the window, the verdict would flip between "no link to this exists" and "a
   * link exists and nobody took it" on the window control alone.
   */
  linkedSubjectsEverReached(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT DISTINCT subject FROM surface_reach WHERE arrival = 'linked'`).all() as {
      subject: string;
    }[];
    return new Set(rows.map((r) => r.subject));
  }

  /**
   * Drop everything older than {@link RETENTION_DAYS}, at most hourly.
   *
   * Called from the write path and from boot. From the write path because a fleet
   * whose operator is using the cockpit is the only one accumulating rows, so the
   * sweep costs nothing on an idle harness; from boot as well because an idle
   * harness would otherwise hold rows past their window with nothing to trigger
   * the sweep — a retention promise kept only while busy is not one.
   *
   * Returns how many rows it dropped.
   */
  pruneSurfaceReach(force = false): number {
    const nowMs = Date.parse(this.ctx.now());
    if (!force && this.lastPrunedAt !== null && nowMs - this.lastPrunedAt < PRUNE_INTERVAL_MS) return 0;
    this.lastPrunedAt = nowMs;
    const cutoff = new Date(nowMs - RETENTION_DAYS * DAY_MS).toISOString();
    return this.ctx.db.prepare(`DELETE FROM surface_reach WHERE at < ?`).run(cutoff).changes;
  }
}

/**
 * Ninety days, which is the digest's retention and not a second opinion about it
 * ([28](../../docs/spec/28-cross-fleet-pool.md)). A table that outlived what is
 * published from it would be holding rows nothing can ever read.
 */
const RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shortest gap between two retention sweeps — hourly, well under ninety days. */
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
