import type Database from 'better-sqlite3';
import type { IssueRun } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const FLOOR_COLUMNS: ColumnMigrations = {
  issue_runs: { dismiss_note: 'TEXT' },
};

export class FloorStore {
  constructor(private readonly ctx: StoreContext) {}

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

  listIssueRuns(): IssueRun[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_runs ORDER BY started_at DESC`).all() as IssueRunRow[];
    return rows.map(rowToIssueRun);
  }
}

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
  dismiss_note: string | null | undefined;
  updated_at: string;
}

function rowToIssueRun(r: IssueRunRow): IssueRun {
  return {
    originRef: r.origin_ref,
    issueNumber: r.issue_number,
    title: r.title,
    body: r.body,
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
