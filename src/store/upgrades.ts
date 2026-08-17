import { IDLE_INTENT } from '../selfUpdate/upgradePlan.js';
import type { UpgradeIntent, UpgradeState } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `upgrade_intent` table: one row, id 1 — what the operator asked the harness
 * to do about its own build.
 *
 * **Why this is persisted when `RuntimeControl` beside it is not.** The pause flag
 * is read only by the process that holds it, so a restart reverting it to config
 * is correct. This row exists precisely to be read by the process *after* the one
 * that wrote it: `applying` is a message from the harness that just went down to
 * the one coming up, saying that the agents it interrupted were interrupted
 * deliberately and their recovery verdict is already decided. Held in memory it
 * would be gone at exactly the moment it is needed, and the whole upgrade would
 * land in the manual recovery panel — which is the friction the marker removes.
 *
 * A drain is worth persisting for a smaller reason: an operator who asks the fleet
 * to wind down, then restarts for some unrelated reason, has not changed their
 * mind, and coming back up dispatching would be the harness overruling them.
 */
export class UpgradeStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * The intent as it stands. A database that has never recorded one reads as
   * {@link IDLE_INTENT} rather than null — there is no such thing as *no* answer to
   * "is an upgrade in progress", and every caller would otherwise write the same
   * `?? IDLE_INTENT`.
   */
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

  /**
   * Replace the intent. An upsert on the fixed id rather than an insert-or-update
   * pair: the row is a single cell of state, so "has it been written before" is a
   * question no caller should have to hold an opinion about.
   */
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
