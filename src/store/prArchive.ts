import type { ClosedPrSweep } from '../integrations/closedWindow.js';
import type { PullRequest } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrArchiveStore implements ClosedPrSweep {
  constructor(private readonly ctx: StoreContext) {}

  archiveClosedPrs(prs: readonly PullRequest[]): void {
    if (prs.length === 0) return;
    const at = this.ctx.now();
    const stmt = this.ctx.prep(
      `INSERT INTO pr_archive (number, closed_at, first_seen_at, updated_at, snapshot)
       VALUES (@number, @closedAt, @at, @at, @snapshot)
       ON CONFLICT(number) DO UPDATE SET
         closed_at = excluded.closed_at,
         updated_at = excluded.updated_at,
         snapshot = excluded.snapshot`,
    );
    const writeAll = this.ctx.db.transaction((rows: readonly PullRequest[]) => {
      for (const pr of rows) {
        stmt.run({ number: pr.number, closedAt: pr.closedAt ?? null, at, snapshot: JSON.stringify(pr) });
      }
    });
    writeAll(prs);
  }

  readClosedSweep(): string | null {
    const row = this.ctx.prep(`SELECT swept_to FROM closed_pr_sweep WHERE id = 1`).get() as
      | { swept_to: string }
      | undefined;
    return row?.swept_to ?? null;
  }

  recordClosedSweep(sweptTo: string): void {
    const at = this.ctx.now();
    this.ctx
      .prep(
        `INSERT INTO closed_pr_sweep (id, swept_to, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET swept_to = MAX(closed_pr_sweep.swept_to, excluded.swept_to), updated_at = excluded.updated_at`,
      )
      .run(sweptTo, at);
  }

  listArchivedPrs(): PullRequest[] {
    const rows = this.ctx
      .prep(`SELECT snapshot FROM pr_archive ORDER BY COALESCE(closed_at, first_seen_at) DESC, number DESC`)
      .all() as { snapshot: string }[];
    return rows.map((row) => JSON.parse(row.snapshot) as PullRequest);
  }
}
