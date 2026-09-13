import type { GoalPause } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PauseStore {
  constructor(private readonly ctx: StoreContext) {}

  setGoalPause(originRef: string, paused: boolean): void {
    if (!paused) {
      this.ctx.prep(`DELETE FROM goal_pauses WHERE origin=?`).run(originRef);
      return;
    }
    this.ctx
      .prep(`INSERT INTO goal_pauses (origin, created_at) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING`)
      .run(originRef, this.ctx.now());
  }

  listGoalPauses(): GoalPause[] {
    const rows = this.ctx.prep(`SELECT origin, created_at FROM goal_pauses ORDER BY created_at ASC`).all() as {
      origin: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ originRef: r.origin, since: r.created_at }));
  }
}
