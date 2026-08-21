import { nanoid } from 'nanoid';
import type { Remedy, RemedyInput, RemedyKind } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `remedies` table: why the fleet came back to a pull request, and what
 * settled it.
 *
 * A brand-new table, so no {@link ColumnMigrations} entry — but being new *once*
 * does not keep it exempt, and a column added to it later needs one.
 *
 * **Nothing here gates anything.** No dispatch rule, desk or gate reads this
 * store; the two readers are `buildRemedyInsights` (the panel) and
 * `priorRemedies` (the note a later dispatch carries). That is why there is no
 * status column and no transition method: a remedy is testimony, and unlike a
 * {@link Finding} or a {@link Lesson} nobody has to rule on it before it is worth
 * something — the ruling it feeds is the operator's own, over a lesson the same
 * submission proposed.
 */
export class RemedyStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File one account of a return.
   *
   * **Deduped on the caller's task**, not on the origin. One agent can settle
   * several distinct reds on one branch and should be able to say so once each;
   * what it must not do is file the same account twice — an agent calling the
   * tool again in the same turn, or resubmitting after a rejected field. So the
   * key is the task plus the claim itself (cause, guard, summary), and a repeat
   * refreshes the row rather than inserting beside it.
   *
   * The origin is deliberately *not* the key. A pull request that goes red four
   * times over four days genuinely has four remedies on `pr:42:ci`, and that
   * repetition is the strongest signal this table holds — collapsing it would
   * hide exactly the pull request an operator most needs to see.
   */
  recordRemedy(input: RemedyInput): Remedy {
    const existing = this.findSameClaim(input);
    const ts = this.ctx.now();
    if (existing) {
      this.ctx.db.prepare(`UPDATE remedies SET updated_at=? WHERE id=?`).run(ts, existing.id);
      return { ...existing, updatedAt: ts };
    }
    const remedy: Remedy = { id: `rmd_${nanoid(10)}`, ...input, createdAt: ts, updatedAt: ts };
    this.ctx.db
      .prepare(
        `INSERT INTO remedies (id, kind, origin_ref, pr_number, cause, guard, summary, checks, agent_id, task_id, created_at, updated_at)
         VALUES (@id, @kind, @originRef, @prNumber, @cause, @guard, @summary, @checks, @agentId, @taskId, @createdAt, @updatedAt)`,
      )
      .run({ ...remedy, checks: remedy.checks.length === 0 ? null : JSON.stringify(remedy.checks) });
    return remedy;
  }

  private findSameClaim(input: RemedyInput): Remedy | null {
    const row = this.ctx.db
      .prepare(
        `SELECT * FROM remedies
         WHERE task_id=? AND cause=? AND guard=? AND summary=?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.taskId, input.cause, input.guard, input.summary) as RemedyRow | undefined;
    return row ? rowToRemedy(row) : null;
  }

  /**
   * Every remedy filed at or after `since`, oldest first.
   *
   * Oldest first because the panel's timeline reads them in the order they
   * happened, the same ordering `/api/reliability` asks its CI events in and for
   * the same reason.
   */
  listRemediesSince(since: string): Remedy[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM remedies WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as RemedyRow[];
    return rows.map(rowToRemedy);
  }

  /**
   * The most recent remedies of one kind, newest first — what a fresh dispatch is
   * handed about this repository's own history.
   *
   * Capped in SQL rather than in the caller: this is read on the dispatch path,
   * on every pulse that produces a CI candidate, and a table that grows for the
   * life of the deployment must not be walked whole to hand an agent three lines.
   */
  listRecentRemedies(kind: RemedyKind, limit: number): Remedy[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM remedies WHERE kind=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(kind, limit) as RemedyRow[];
    return rows.map(rowToRemedy);
  }
}

interface RemedyRow {
  id: string;
  kind: string;
  origin_ref: string;
  pr_number: number;
  cause: string;
  guard: string;
  summary: string;
  checks: string | null;
  agent_id: string;
  task_id: string;
  created_at: string;
  updated_at: string;
}

function rowToRemedy(r: RemedyRow): Remedy {
  return {
    id: r.id,
    kind: r.kind as Remedy['kind'],
    originRef: r.origin_ref,
    prNumber: r.pr_number,
    cause: r.cause as Remedy['cause'],
    guard: r.guard as Remedy['guard'],
    summary: r.summary,
    checks: parseChecks(r.checks),
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Null and malformed both read as "no checks named", rather than throwing on a
 * row the panel would then refuse to draw at all. The column is written by one
 * `JSON.stringify` here and by nothing else, so malformed means a database
 * somebody edited — and a lost check list is a worse reading, not a broken one.
 */
function parseChecks(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
