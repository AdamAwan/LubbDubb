import type { GoalPriority, PriorityOverride } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PriorityStore {
  constructor(private readonly ctx: StoreContext) {}

  setPriorityOverrides(origins: string[]): void {
    const ts = this.ctx.now();
    const tx = this.ctx.db.transaction((rows: string[]) => {
      this.ctx.prep(`DELETE FROM priority_overrides`).run();
      const insert = this.ctx.prep(
        `INSERT INTO priority_overrides (origin, rank, updated_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      );
      rows.forEach((origin, rank) => insert.run(origin, rank, ts, ts));
    });
    tx(origins);
  }

  listPriorityOverrides(): PriorityOverride[] {
    const rows = this.ctx
      .prep(`SELECT origin, rank FROM priority_overrides ORDER BY rank ASC`)
      .all() as PriorityOverride[];
    return rows.map((r) => ({ origin: r.origin, rank: r.rank }));
  }

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
        this.ctx.prep(`DELETE FROM priority_overrides WHERE last_seen_at < ?`).run(cutoff);
      }
    });
    tx();
  }

  setGoalPriority(originRef: string, priority: boolean): void {
    if (!priority) {
      this.ctx.prep(`DELETE FROM goal_priorities WHERE origin=?`).run(originRef);
      return;
    }
    this.ctx
      .prep(`INSERT INTO goal_priorities (origin, created_at) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING`)
      .run(originRef, this.ctx.now());
  }

  listGoalPriorities(): GoalPriority[] {
    const rows = this.ctx.prep(`SELECT origin, created_at FROM goal_priorities ORDER BY created_at ASC`).all() as {
      origin: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ originRef: r.origin, since: r.created_at }));
  }
}
