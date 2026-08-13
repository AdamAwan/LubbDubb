import type Database from 'better-sqlite3';
import type { IssueRun } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `issue_runs` was a fresh `CREATE TABLE` and needed no entry — **once**. It has
 * one now: `dismiss_note` is what the operator said when they ended a run whose
 * validation was not clear, and without this it is invisible on every database
 * that predates it, with nothing erroring. Null is the right answer for every row
 * from before it existed: nobody was asked.
 */
export const FLOOR_COLUMNS: ColumnMigrations = {
  issue_runs: { dismiss_note: 'TEXT' },
};

/**
 * The `issue_runs` table: the harness's run at a goal, from the first pulse that
 * saw work under it until the operator dismisses it (issues #203, #234).
 *
 * Its own module rather than part of the work graph it sits beside: the graph is a
 * record of what happened, this is the record of a run that is still *live* — what
 * an operator still wants to see, and what the dispatcher may still act on — and
 * the only transition on it is a dismissal nothing else can undo.
 */
export class FloorStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Note that the harness has a run at this goal (issue #234).
   *
   * Upsert on the issue origin. The snapshot fields are refreshed every pulse the
   * issue is live and then stand still once the world forgets it — which is the
   * whole point: a retained run is dispatched from, so its body and labels must be
   * the ones the issue last actually had.
   *
   * Two instants are frozen and one flag is never resurrected. `started_at` dates
   * the first pulse that saw work, not the last that re-recorded it; `completed_at`
   * dates the first pulse that saw the goal finished, and `complete: false` on a
   * later pulse does **not** clear it — a goal reached once has been reached, and
   * the standing verdicts are where "is it still finished" is asked. A dismissed
   * run stays dismissed until the operator says otherwise, the way a re-reported
   * finding keeps its status.
   */
  recordIssueRun(input: {
    originRef: string;
    issueNumber: number;
    title: string;
    body: string;
    labels: string[];
    linkedPrNumber: number | null;
    workItemState: string | null;
    complete: boolean;
  }): void {
    const ts = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO issue_runs (origin_ref, issue_number, title, body, labels, linked_pr, work_item_state,
                                 started_at, completed_at, outcome, dismissed_at, updated_at)
         VALUES (@originRef, @issueNumber, @title, @body, @labels, @linkedPrNumber, @workItemState,
                 @ts, @completedAt, NULL, NULL, @ts)
         ON CONFLICT(origin_ref) DO UPDATE SET
           title=excluded.title,
           body=excluded.body,
           labels=excluded.labels,
           linked_pr=excluded.linked_pr,
           work_item_state=excluded.work_item_state,
           completed_at=COALESCE(issue_runs.completed_at, excluded.completed_at),
           updated_at=excluded.updated_at`,
      )
      .run({
        originRef: input.originRef,
        issueNumber: input.issueNumber,
        title: input.title,
        body: input.body,
        labels: JSON.stringify(input.labels),
        linkedPrNumber: input.linkedPrNumber,
        workItemState: input.workItemState,
        completedAt: input.complete ? ts : null,
        ts,
      });
  }

  /**
   * End a run — the terminal act, and the only one (issue #234).
   *
   * Operator-only and one-way. Two routes reach it and the row decides which: a
   * run the harness had judged finished ends `judged`, one it had not ends
   * `abandoned`. The outcome is read off `completed_at` rather than passed in, so
   * nothing can claim a verdict the evidence does not carry.
   *
   * Idempotent in the write (`WHERE dismissed_at IS NULL`), so a second click is a
   * no-op rather than a re-stamp, and it returns whether it changed a row. This now
   * stops the dispatcher as well as the card — see `docs/spec/17-cockpit.md` — so
   * an accidental dismissal is undone by the goal being worked again, not by an
   * un-dismiss.
   */
  dismissIssueRun(originRef: string, note: string | null = null): boolean {
    const ts = this.ctx.now();
    const info = this.ctx.db
      .prepare(
        `UPDATE issue_runs
            SET dismissed_at=?, updated_at=?, dismiss_note=?,
                outcome=CASE WHEN completed_at IS NULL THEN 'abandoned' ELSE 'judged' END
          WHERE origin_ref=? AND dismissed_at IS NULL`,
      )
      .run(ts, ts, note, originRef);
    return info.changes > 0;
  }

  /**
   * Every run, dismissed ones included — the dispatcher needs the dismissal to stop
   * acting on a goal, and the cockpit needs it to tell a live goal from a cleared
   * one. Unbounded in age for `listWorkItemIgnores`' reason: a retention that aged
   * out of a window would put a goal back in front of the operator (and back in
   * front of the dispatcher) after they had ended it.
   */
  listIssueRuns(): IssueRun[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_runs ORDER BY started_at DESC`).all() as IssueRunRow[];
    return rows.map(rowToIssueRun);
  }
}

/**
 * Carry `floor_completions` (#203) into `issue_runs` (#234), then drop it.
 *
 * A reshape rather than an `ensureColumns` entry: `completed_at` was `NOT NULL`
 * and a run minted at pickup has no completion, so stretching the column to mean
 * two things would leave "minted" and "finished" indistinguishable on exactly the
 * databases with history in them. Every old row *was* a completion, so it
 * backfills as a run that started and completed at the same instant it was
 * observed — the only instant the old shape recorded.
 *
 * Guarded on the new table being **empty**, not on the old one existing: a second
 * boot has nothing to carry, and re-running the copy would overwrite refreshed
 * snapshots with the stale titles of the old shape. Carrying `dismissed_at` is the
 * load-bearing part — a live database holds dismissals the operator has already
 * made, and a backfill that silently dropped them would put every cleared card
 * back on the floor, now with the dispatcher acting on it again. In one
 * transaction, so a failure leaves the old table in place to retry from rather
 * than half a history.
 *
 * Exported and run from `Store` beside the `ensureColumns` pass rather than done
 * in the constructor above: it is a migration, it must happen before any module
 * reads, and that ordering belongs where the other migrations are stated.
 */
export function adoptFloorCompletions(db: Database.Database): void {
  const old = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='floor_completions'`).get() as
    | { name: string }
    | undefined;
  if (!old) return;
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM issue_runs`).get() as { n: number };
  db.transaction(() => {
    if (n === 0) {
      db.exec(
        `INSERT INTO issue_runs (origin_ref, issue_number, title, body, labels, linked_pr, work_item_state,
                                 started_at, completed_at, outcome, dismissed_at, updated_at)
         SELECT origin_ref, issue_number, title, '', '[]', NULL, NULL,
                completed_at, completed_at,
                CASE WHEN dismissed_at IS NULL THEN NULL ELSE 'judged' END,
                dismissed_at, updated_at
           FROM floor_completions`,
      );
    }
    db.exec(`DROP TABLE floor_completions`);
  })();
}

interface IssueRunRow {
  origin_ref: string;
  issue_number: number;
  title: string;
  body: string;
  labels: string;
  linked_pr: number | null;
  work_item_state: string | null;
  started_at: string;
  completed_at: string | null;
  outcome: string | null;
  dismissed_at: string | null;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  dismiss_note: string | null | undefined;
  updated_at: string;
}

function rowToIssueRun(r: IssueRunRow): IssueRun {
  return {
    originRef: r.origin_ref,
    issueNumber: r.issue_number,
    title: r.title,
    body: r.body,
    // Tolerant of a row written before the column existed (the `floor_completions`
    // backfill writes `[]`, but a hand-edited database is not worth a crash on).
    labels: parseJsonArray(r.labels),
    linkedPrNumber: r.linked_pr,
    workItemState: r.work_item_state,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    outcome: r.outcome === 'judged' || r.outcome === 'abandoned' ? r.outcome : null,
    dismissedAt: r.dismissed_at,
    dismissNote: r.dismiss_note ?? null,
    updatedAt: r.updated_at,
  };
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
