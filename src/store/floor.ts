import type { FloorCompletion } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `floor_completions` table: which finished goals stay drawn on the Goal Floor
 * (issue #203).
 *
 * Its own module rather than part of the work graph it sits beside: the graph is a
 * record of what happened, this is a record of what an operator still wants to
 * *see*, and the only transition on it is a dismissal nothing else can undo.
 */
export class FloorStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Note that a finished goal should stay on the Goal Floor (issue #203).
   *
   * Upsert on the issue origin, and captured while the issue is still live so the
   * `title` outlives the world forgetting it. `completed_at` survives an overwrite
   * — the row dates when the goal was first observed complete, not the last pulse
   * that re-recorded it — and a standing `dismissed_at` is never resurrected: a
   * dismissed goal that re-completes stays dismissed until the operator says
   * otherwise, the way a re-reported finding keeps its status.
   */
  recordFloorCompletion(input: { originRef: string; issueNumber: number; title: string }): void {
    const ts = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO floor_completions (origin_ref, issue_number, title, completed_at, dismissed_at, updated_at)
         VALUES (@originRef, @issueNumber, @title, @ts, NULL, @ts)
         ON CONFLICT(origin_ref) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`,
      )
      .run({ ...input, ts });
  }

  /**
   * The one thing that removes a completed goal from the floor. Idempotent in the
   * write (`WHERE dismissed_at IS NULL`), so a second click is a no-op rather than
   * a re-stamp, and it returns whether it changed a row. One-way: an accidental
   * dismissal is undone by the goal re-entering production, not by an un-dismiss.
   */
  dismissFloorCompletion(originRef: string): boolean {
    const ts = this.ctx.now();
    const info = this.ctx.db
      .prepare(`UPDATE floor_completions SET dismissed_at=?, updated_at=? WHERE origin_ref=? AND dismissed_at IS NULL`)
      .run(ts, ts, originRef);
    return info.changes > 0;
  }

  /**
   * Every floor completion, dismissed ones included — the cockpit needs the
   * dismissed flag to hide a completed goal that is still in the world, and an
   * absent-but-not-dismissed one to draw it back. Unbounded in age for
   * `listWorkItemIgnores`' reason: a retention that aged out of a window would put
   * a goal back on the floor the operator had already cleared.
   */
  listFloorCompletions(): FloorCompletion[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM floor_completions ORDER BY completed_at DESC`)
      .all() as FloorCompletionRow[];
    return rows.map(rowToFloorCompletion);
  }
}

interface FloorCompletionRow {
  origin_ref: string;
  issue_number: number;
  title: string;
  completed_at: string;
  dismissed_at: string | null;
  updated_at: string;
}

function rowToFloorCompletion(r: FloorCompletionRow): FloorCompletion {
  return {
    originRef: r.origin_ref,
    issueNumber: r.issue_number,
    title: r.title,
    completedAt: r.completed_at,
    dismissedAt: r.dismissed_at,
    updatedAt: r.updated_at,
  };
}
