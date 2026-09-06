import type { AccountRateLimits, RateLimitWindow } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class RateLimitStore {
  constructor(private readonly ctx: StoreContext) {}

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

function window(usedPercentage: number | null, resetsAt: string | null): RateLimitWindow | null {
  return usedPercentage === null ? null : { usedPercentage, resetsAt };
}
