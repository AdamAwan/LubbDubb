import type {
  GoalWatch,
  GoalWatchInput,
  GoalWatchKind,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchWindow,
} from '../types.js';
import type { StoreContext } from './context.js';

/**
 * Three tables. `goal_watches` — what each goal declared a running system would
 * have to show for its work to have done what it claimed, and what the dry run
 * read against it — plus the two the window is made of: `watch_windows`, one per
 * `(goal, environment)` an arrival opened, and `watch_readings`, what each check
 * answered each time the window was read.
 *
 * `goal_watches` is one row per `(goal_ref, check_id)`, written `OR REPLACE` on
 * the declaration: the merge key is the author's own slug, exactly as a part's is
 * and a validation check's is, so an amended plan lands on the row rather than
 * beside it.
 *
 * **A reading is not a `WorldEvent`, and this table is why it does not have to
 * be.** `deliveryHold` expires a standing delivery verdict on *any* world event
 * matching the goal's issue ref, so a reading written as one would un-park the
 * goal it just reported on and hand finished work back to the fleet to do again.
 * Own table, own wire list, merged at the feed's door — what arrivals already do.
 *
 * The tables are new, so they need no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added later will. That is not
 * hypothetical here: `watch_windows.settled_at` null means *still watching*, so a
 * column added to it without a backfill gated on `ensureColumns`' report reopens
 * every settled window on the boot an operator takes the build.
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
   *
   * **A dropped check takes its readings with it**, in the same transaction. Once
   * a window's readings hang off a check, deleting the row alone would orphan the
   * evidence behind a verdict — and the honest answer is not to keep the evidence
   * for a question nobody is asking any more, but to leave neither: a verdict with
   * nothing behind it is the shape that is unreadable six weeks later, and a
   * reading of a check no document declares is a number with no rule.
   * → `docs/plans/29-post-deploy-watch.md`
   */
  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    const ids = checks.map((c) => c.id);
    this.ctx.db.transaction(() => {
      const keep = new Set(ids);
      for (const row of this.ctx.db.prepare(`SELECT check_id FROM goal_watches WHERE goal_ref=?`).all(originRef) as {
        check_id: string;
      }[]) {
        if (keep.has(row.check_id)) continue;
        this.ctx.db.prepare(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
        this.ctx.db.prepare(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
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

  /**
   * Open a window on an arrival.
   *
   * `OR IGNORE`, for {@link EnvironmentStore.recordGoalArrival}'s reason and one
   * sharper: a goal that grows another pull request and is confirmed again has not
   * arrived twice — and replacing would move `settles_at` forward, or worse clear
   * `settled_at`, which is **a settled watch re-opened by a later reading**. That
   * is a record of what happened after a deploy, not a monitor.
   */
  openWatchWindow(input: { goalRef: string; environment: string; openedAt: string; settlesAt: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO watch_windows (goal_ref, environment, opened_at, settles_at, settled_at)
         VALUES (@goalRef, @environment, @openedAt, @settlesAt, NULL)`,
      )
      .run(input);
  }

  /**
   * Fix a window's verdict: its readings stop and its rows stay on the goal page
   * as the permanent account of what production said about this work.
   *
   * The `settled_at IS NULL` guard is the whole of the one-way rule, in SQL rather
   * than in a caller: a second settle cannot move the stamp, so nothing about when
   * a window closed depends on which pass got to it.
   */
  settleWatchWindow(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE watch_windows SET settled_at=? WHERE goal_ref=? AND environment=? AND settled_at IS NULL`)
      .run(this.ctx.now(), goalRef, environment);
  }

  /** Every window, oldest first — the order the desk drains its per-pulse cap in. */
  listWatchWindows(): WatchWindow[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM watch_windows ORDER BY opened_at ASC, environment ASC`)
      .all() as WatchWindowRow[];
    return rows.map((r) => ({
      goalRef: r.goal_ref,
      environment: r.environment,
      openedAt: r.opened_at,
      settlesAt: r.settles_at,
      settledAt: r.settled_at,
    }));
  }

  /**
   * Append what one check answered.
   *
   * Append-only and keyed on the read time, so a window keeps the series rather
   * than the last answer: the readings are the evidence behind the verdict, and a
   * row overwritten in place would leave the verdict standing with nothing behind
   * it. Bounded by `for` over `watchIntervalMs` — 96 rows per check per
   * environment on the defaults — rather than by a retention rule.
   */
  recordWatchReading(input: {
    goalRef: string;
    environment: string;
    checkId: string;
    verdict: WatchCheckVerdict;
    rows: number | null;
    detail: string | null;
  }): void {
    this.ctx.db
      .prepare(
        `INSERT OR REPLACE INTO watch_readings (goal_ref, environment, check_id, read_at, verdict, rows_read, detail)
         VALUES (@goalRef, @environment, @checkId, @readAt, @verdict, @rows, @detail)`,
      )
      .run({ ...input, readAt: this.ctx.now() });
  }

  /** Every reading, oldest first. The newest per `(window, check)` is what the card draws. */
  listWatchReadings(): WatchReading[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM watch_readings ORDER BY read_at ASC, check_id ASC`)
      .all() as WatchReadingRow[];
    return rows.map((r) => ({
      goalRef: r.goal_ref,
      environment: r.environment,
      checkId: r.check_id,
      readAt: r.read_at,
      verdict: r.verdict as WatchCheckVerdict,
      rows: r.rows_read,
      detail: r.detail,
    }));
  }
}

/** `watch_windows`, as `better-sqlite3` hands it back. */
interface WatchWindowRow {
  goal_ref: string;
  environment: string;
  opened_at: string;
  settles_at: string;
  settled_at: string | null;
}

/** `watch_readings`, the same. `rows_read` because `rows` is not a name SQLite likes. */
interface WatchReadingRow {
  goal_ref: string;
  environment: string;
  check_id: string;
  read_at: string;
  verdict: string;
  rows_read: number | null;
  detail: string | null;
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
