import type { AccountRateLimits, RateLimitWindow } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `account_rate_limits` table: the freshest reading of the account's Claude
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
