import type { AccountRateLimits, RateLimitWindow } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The account's Claude usage windows: the freshest reading as one row, and every
 * reading as a series.
 *
 * The `account_rate_limits` table is the freshest reading of the account's Claude
 * usage windows, as one row.
 *
 * One row because the reading is about the *account*, not about the agent that
 * happened to observe it — every live agent reports the same windows, and the
 * fleet has exactly one answer to "how much of the five hours is spent". It is
 * persisted rather than held in memory so a reading survives a restart: readings
 * only arrive when an agent takes a turn, so a harness that dropped them on boot
 * would show the cockpit nothing until the next dispatch — which on a paused or
 * idle fleet is indefinitely.
 */
export class RateLimitStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Land a reading, keeping the newest by `capturedAt`.
   *
   * The guard is **not** belt-and-braces around an ordered writer: several agents
   * report interleaved, and a reading emitted behind a slow turn can reach the
   * store after a newer one. Last-write-wins would then show the older windows,
   * which is a chip that goes *backwards* — and being a plausible number, one
   * nothing about the cockpit marks as wrong. Comparison is a string compare on
   * ISO-8601 UTC, which sorts as it reads.
   */
  recordRateLimits(limits: AccountRateLimits): void {
    this.appendReading(limits);
    this.ctx.db
      .prepare(
        `INSERT INTO account_rate_limits (
           id, five_hour_used_percentage, five_hour_resets_at,
           seven_day_used_percentage, seven_day_resets_at, captured_at)
         VALUES (1, @fiveHourUsed, @fiveHourResetsAt, @sevenDayUsed, @sevenDayResetsAt, @capturedAt)
         ON CONFLICT(id) DO UPDATE SET
           five_hour_used_percentage=excluded.five_hour_used_percentage,
           five_hour_resets_at=excluded.five_hour_resets_at,
           seven_day_used_percentage=excluded.seven_day_used_percentage,
           seven_day_resets_at=excluded.seven_day_resets_at,
           captured_at=excluded.captured_at
         WHERE excluded.captured_at > account_rate_limits.captured_at`,
      )
      .run({
        fiveHourUsed: limits.fiveHour?.usedPercentage ?? null,
        fiveHourResetsAt: limits.fiveHour?.resetsAt ?? null,
        sevenDayUsed: limits.sevenDay?.usedPercentage ?? null,
        sevenDayResetsAt: limits.sevenDay?.resetsAt ?? null,
        capturedAt: limits.capturedAt,
      });
  }

  /**
   * Keep the reading as well as land it — the same figures, appended.
   *
   * **This one deliberately has no freshest-wins guard.** The row above is a
   * statement about *now*, so a reading that arrived behind a slow turn must not
   * overwrite a newer one; the series is a statement about *then*, and the late
   * reading describes a moment that happened whatever order it reached the store
   * in. Adding the guard here would silently drop exactly the readings a busy
   * fleet produces most of — the ones from agents whose turns overlap — and the
   * graph would thin out precisely where the account was moving fastest.
   *
   * Two agents reporting the identical `capturedAt` are reporting one reading of
   * one account, which is what the primary key says; the conflict is ignored
   * rather than replaced, since there is nothing to choose between them.
   *
   * Private because a reading is never appended on its own: it is the second half
   * of landing one, and a caller that could do only this would grow a history the
   * chip does not agree with.
   */
  private appendReading(limits: AccountRateLimits): void {
    this.ctx.db
      .prepare(
        `INSERT INTO rate_limit_readings (
           captured_at, five_hour_used_percentage, five_hour_resets_at,
           seven_day_used_percentage, seven_day_resets_at)
         VALUES (@capturedAt, @fiveHourUsed, @fiveHourResetsAt, @sevenDayUsed, @sevenDayResetsAt)
         ON CONFLICT(captured_at) DO NOTHING`,
      )
      .run({
        capturedAt: limits.capturedAt,
        fiveHourUsed: limits.fiveHour?.usedPercentage ?? null,
        fiveHourResetsAt: limits.fiveHour?.resetsAt ?? null,
        sevenDayUsed: limits.sevenDay?.usedPercentage ?? null,
        sevenDayResetsAt: limits.sevenDay?.resetsAt ?? null,
      });
  }

  /**
   * Every reading since an instant, oldest first — the series the allowance
   * graphs are drawn off.
   *
   * Oldest first because every reader of it walks forward: a step line, a gap
   * test and a delta all ask what the *previous* reading was, and a caller that
   * had to reverse the list first is a caller one forgotten `.reverse()` away
   * from a chart that runs backwards and still looks like a chart.
   */
  listRateLimitReadingsSince(since: string): AccountRateLimits[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM rate_limit_readings
         WHERE captured_at >= ?
         ORDER BY captured_at ASC`,
      )
      .all(since) as ReadingRow[];
    return rows.map((row) => ({
      fiveHour: window(row.five_hour_used_percentage, row.five_hour_resets_at),
      sevenDay: window(row.seven_day_used_percentage, row.seven_day_resets_at),
      capturedAt: row.captured_at,
    }));
  }

  /** The freshest reading, or null on a deployment that has never seen one. */
  readRateLimits(): AccountRateLimits | null {
    const row = this.ctx.db.prepare(`SELECT * FROM account_rate_limits WHERE id=1`).get() as RateLimitRow | undefined;
    if (!row) return null;
    return {
      fiveHour: window(row.five_hour_used_percentage, row.five_hour_resets_at),
      sevenDay: window(row.seven_day_used_percentage, row.seven_day_resets_at),
      capturedAt: row.captured_at,
    };
  }
}

/** A `rate_limit_readings` row — the same five columns, keyed by the instant. */
interface ReadingRow {
  captured_at: string;
  five_hour_used_percentage: number | null;
  five_hour_resets_at: string | null;
  seven_day_used_percentage: number | null;
  seven_day_resets_at: string | null;
}

interface RateLimitRow {
  five_hour_used_percentage: number | null;
  five_hour_resets_at: string | null;
  seven_day_used_percentage: number | null;
  seven_day_resets_at: string | null;
  captured_at: string;
}

/** A window is absent, not zero, when the CLI named no percentage for it. */
function window(usedPercentage: number | null, resetsAt: string | null): RateLimitWindow | null {
  return usedPercentage === null ? null : { usedPercentage, resetsAt };
}
