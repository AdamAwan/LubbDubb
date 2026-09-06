import { IDLE_INTENT } from '../selfUpdate/upgradePlan.js';
import type { UpgradeIntent, UpgradeState } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class UpgradeStore {
  constructor(private readonly ctx: StoreContext) {}

  readUpgradeIntent(): UpgradeIntent {
    const row = this.ctx.db
      .prepare(`SELECT state, target_sha, requested_at, paused_by_drain FROM upgrade_intent WHERE id = 1`)
      .get() as UpgradeRow | undefined;
    if (!row) return IDLE_INTENT;
    return {
      state: row.state as UpgradeState,
      targetSha: row.target_sha,
      requestedAt: row.requested_at,
      pausedByDrain: row.paused_by_drain === 1,
    };
  }

  writeUpgradeIntent(intent: UpgradeIntent): UpgradeIntent {
    this.ctx.db
      .prepare(
        `INSERT INTO upgrade_intent (id, state, target_sha, requested_at, paused_by_drain, updated_at)
         VALUES (1, @state, @targetSha, @requestedAt, @pausedByDrain, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           target_sha = excluded.target_sha,
           requested_at = excluded.requested_at,
           paused_by_drain = excluded.paused_by_drain,
           updated_at = excluded.updated_at`,
      )
      .run({
        state: intent.state,
        targetSha: intent.targetSha,
        requestedAt: intent.requestedAt,
        pausedByDrain: intent.pausedByDrain ? 1 : 0,
        updatedAt: this.ctx.now(),
      });
    return intent;
  }
}

interface UpgradeRow {
  state: string;
  target_sha: string | null;
  requested_at: string | null;
  paused_by_drain: number;
}
