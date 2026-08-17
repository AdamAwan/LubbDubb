import type { GoalPriority, PriorityOverride } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The two operator priority statements, both keyed on origin — the same stable key
 * every dispatch rule and gate already uses, because the queue itself is a per-pulse
 * projection recomputed from the world and there is nothing there to mutate durably.
 *
 * `priority_overrides` arranges one pulse's queue, origin by origin (issue #128).
 * `goal_priorities` marks a whole goal, and covers every origin its work takes.
 * They are one module because they are one question asked at two grains, and the
 * dispatcher reads them together.
 */
export class PriorityStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Replace the operator's whole "Up next" priority order with `origins`, ranked
   * `0..n-1` in the given order (`0` = "do this next"). Replace-all is the point:
   * an origin the operator drops from the list has its override cleared, and an
   * empty list clears every override. Idempotent, and cheap — the set is tiny.
   */
  setPriorityOverrides(origins: string[]): void {
    const ts = this.ctx.now();
    const tx = this.ctx.db.transaction((rows: string[]) => {
      this.ctx.db.prepare(`DELETE FROM priority_overrides`).run();
      const insert = this.ctx.db.prepare(
        `INSERT INTO priority_overrides (origin, rank, updated_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      );
      rows.forEach((origin, rank) => insert.run(origin, rank, ts, ts));
    });
    tx(origins);
  }

  /** The current overrides, lowest rank (highest priority) first. */
  listPriorityOverrides(): PriorityOverride[] {
    const rows = this.ctx.db
      .prepare(`SELECT origin, rank FROM priority_overrides ORDER BY rank ASC`)
      .all() as PriorityOverride[];
    return rows.map((r) => ({ origin: r.origin, rank: r.rank }));
  }

  /**
   * Keep the override set from lingering forever (issue #128): bump `last_seen_at`
   * for every origin the harness still tracks this pulse, then drop any override
   * whose origin has been untracked for longer than `ttlMs`. `ttlMs <= 0` disables
   * pruning entirely (a supported configuration). Called once per pulse.
   */
  reconcilePriorityOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    const now = this.ctx.now();
    const tx = this.ctx.db.transaction(() => {
      if (trackedOrigins.length > 0) {
        const placeholders = trackedOrigins.map(() => '?').join(',');
        this.ctx.db
          .prepare(`UPDATE priority_overrides SET last_seen_at=? WHERE origin IN (${placeholders})`)
          .run(now, ...trackedOrigins);
      }
      if (ttlMs > 0) {
        const cutoff = new Date(Date.parse(now) - ttlMs).toISOString();
        this.ctx.db.prepare(`DELETE FROM priority_overrides WHERE last_seen_at < ?`).run(cutoff);
      }
    });
    tx();
  }

  /**
   * Mark a goal a priority, or clear the mark. Idempotent both ways, and the
   * re-flag of an already-flagged goal keeps the original `created_at`: the row
   * records when the operator decided, and a second click on a button that is
   * already on decided nothing new.
   */
  setGoalPriority(originRef: string, priority: boolean): void {
    if (!priority) {
      this.ctx.db.prepare(`DELETE FROM goal_priorities WHERE origin=?`).run(originRef);
      return;
    }
    this.ctx.db
      .prepare(`INSERT INTO goal_priorities (origin, created_at) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING`)
      .run(originRef, this.ctx.now());
  }

  /** Every flagged goal, oldest decision first. */
  listGoalPriorities(): GoalPriority[] {
    const rows = this.ctx.db
      .prepare(`SELECT origin, created_at FROM goal_priorities ORDER BY created_at ASC`)
      .all() as { origin: string; created_at: string }[];
    return rows.map((r) => ({ originRef: r.origin, since: r.created_at }));
  }
}
