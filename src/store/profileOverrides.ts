import type { ProfileOverride } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class ProfileOverrideStore {
  constructor(private readonly ctx: StoreContext) {}

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

  listProfileOverrides(): ProfileOverride[] {
    const rows = this.ctx.db
      .prepare(`SELECT origin, profile FROM profile_overrides ORDER BY updated_at ASC`)
      .all() as ProfileOverride[];
    return rows.map((r) => ({ origin: r.origin, profile: r.profile }));
  }

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
