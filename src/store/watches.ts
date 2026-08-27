import type { GoalWatch, GoalWatchInput, GoalWatchKind, WatchReadingVerdict } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * `goal_watches` — what each goal declared a running system would have to show
 * for its work to have done what it claimed, and what the dry run read against it.
 *
 * One row per `(goal_ref, check_id)`, written `OR REPLACE` on the declaration:
 * the merge key is the author's own slug, exactly as a part's is and a validation
 * check's is, so an amended plan lands on the row rather than beside it.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added later will.
 * → `docs/spec/29-post-deploy-watch.md#persistence`
 */
export class WatchStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Fold a document's `watch` block onto a goal's rows.
   *
   * A document speaks for the **whole** watch, so a check it stopped declaring is
   * removed rather than left behind: at this stage a check row carries nothing but
   * its declaration and the dry run of that declaration, both of which the
   * amendment has replaced, and a row nothing declares is a query the harness
   * would go on asking on behalf of a plan that no longer asks it.
   *
   * The dry-run columns are **not** carried across a re-declaration, and that is
   * the point rather than an omission: the reading is a reading *of that query*,
   * and an amended query has never been run.
   */
  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    const ids = checks.map((c) => c.id);
    this.ctx.db.transaction(() => {
      const keep = new Set(ids);
      for (const row of this.ctx.db.prepare(`SELECT check_id FROM goal_watches WHERE goal_ref=?`).all(originRef) as {
        check_id: string;
      }[]) {
        if (!keep.has(row.check_id))
          this.ctx.db.prepare(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
      }
      for (const check of checks) {
        this.ctx.db
          .prepare(
            `INSERT OR REPLACE INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate, why,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate, @why,
                NULL, NULL, NULL, NULL, NULL, NULL, @now, @now)`,
          )
          .run({ ...check, goalRef: originRef, now: this.ctx.now() });
      }
    })();
  }

  /** What the dry run read, stored on the check it was a reading of. */
  recordWatchDryRun(
    originRef: string,
    checkId: string,
    reading: {
      environment: string;
      verdict: WatchReadingVerdict;
      presence: WatchReadingVerdict | null;
      rows: number | null;
      detail: string | null;
    },
  ): void {
    this.ctx.db
      .prepare(
        `UPDATE goal_watches
            SET dry_run_environment=@environment, dry_run_at=@now, dry_run_verdict=@verdict,
                dry_run_presence=@presence, dry_run_rows=@rows, dry_run_detail=@detail, updated_at=@now
          WHERE goal_ref=@goalRef AND check_id=@checkId`,
      )
      .run({ ...reading, goalRef: originRef, checkId, now: this.ctx.now() });
  }

  /** Every declared check, in document order within each goal. */
  listGoalWatches(): GoalWatch[] {
    return (this.ctx.db.prepare(`SELECT * FROM goal_watches ORDER BY goal_ref, seq`).all() as GoalWatchRow[]).map(
      hydrate,
    );
  }
}

/** The table's own shape, as `better-sqlite3` hands it back. */
interface GoalWatchRow {
  goal_ref: string;
  check_id: string;
  seq: number;
  kind: string;
  title: string;
  query: string;
  presence: string | null;
  tolerate: number;
  why: string | null;
  dry_run_environment: string | null;
  dry_run_at: string | null;
  dry_run_verdict: string | null;
  dry_run_presence: string | null;
  dry_run_rows: number | null;
  dry_run_detail: string | null;
}

function hydrate(row: GoalWatchRow): GoalWatch {
  return {
    originRef: row.goal_ref,
    id: row.check_id,
    seq: row.seq,
    kind: row.kind as GoalWatchKind,
    title: row.title,
    query: row.query,
    presence: row.presence,
    tolerate: row.tolerate,
    why: row.why,
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict as WatchReadingVerdict | null,
    dryRunPresence: row.dry_run_presence as WatchReadingVerdict | null,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
  };
}
