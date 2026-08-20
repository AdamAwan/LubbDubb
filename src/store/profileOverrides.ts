import type { ProfileOverride } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * Which model profile the operator has said one queued origin's work runs on.
 *
 * Its own module rather than a third method group on `PriorityStore`: that one
 * owns the operator's two *priority* statements, and this is a different question
 * asked about the same rows. What the two share is the key and the sweep — an
 * origin the harness has stopped tracking is one nothing can be said about any
 * more — and sharing those is not sharing a table.
 */
export class ProfileOverrideStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Pin `origin`'s next dispatch to `profile`, or clear the pin with null.
   * Idempotent both ways. Re-pinning to the same profile still moves
   * `updated_at`: unlike a goal-priority flag, the value can change, so the row
   * records when the operator last said it rather than when they first did.
   */
  setProfileOverride(origin: string, profile: string | null): void {
    if (profile === null) {
      this.ctx.db.prepare(`DELETE FROM profile_overrides WHERE origin=?`).run(origin);
      return;
    }
    const ts = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO profile_overrides (origin, profile, updated_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET profile=excluded.profile, updated_at=excluded.updated_at`,
      )
      .run(origin, profile, ts, ts);
  }

  /** Every standing override, oldest decision first. */
  listProfileOverrides(): ProfileOverride[] {
    const rows = this.ctx.db
      .prepare(`SELECT origin, profile FROM profile_overrides ORDER BY updated_at ASC`)
      .all() as ProfileOverride[];
    return rows.map((r) => ({ origin: r.origin, profile: r.profile }));
  }

  /**
   * Bump `last_seen_at` for the origins the harness still tracks this pulse, then
   * drop any override whose origin has been untracked for longer than `ttlMs`.
   * `ttlMs <= 0` disables pruning, which is a supported configuration. Called
   * once per pulse, beside the priority sweep and off the same key.
   */
  reconcileProfileOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    const now = this.ctx.now();
    const tx = this.ctx.db.transaction(() => {
      if (trackedOrigins.length > 0) {
        const placeholders = trackedOrigins.map(() => '?').join(',');
        this.ctx.db
          .prepare(`UPDATE profile_overrides SET last_seen_at=? WHERE origin IN (${placeholders})`)
          .run(now, ...trackedOrigins);
      }
      if (ttlMs > 0) {
        const cutoff = new Date(Date.parse(now) - ttlMs).toISOString();
        this.ctx.db.prepare(`DELETE FROM profile_overrides WHERE last_seen_at < ?`).run(cutoff);
      }
    });
    tx();
  }
}
