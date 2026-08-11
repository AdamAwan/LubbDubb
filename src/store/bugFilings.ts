import type { BugFiling } from '../types.js';
import type { StoreContext } from './context.js';

interface BugFilingRow {
  job_id: string;
  origin_ref: string;
  status: string;
  ticket_ref: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBugFiling(row: BugFilingRow): BugFiling {
  return {
    jobId: row.job_id,
    originRef: row.origin_ref,
    status: row.status as BugFiling['status'],
    ticketRef: row.ticket_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The `issue_bug_filings` table: bugs an operator raised against a story from the
 * cockpit, and what became of each.
 *
 * **Keyed on the job, not on the story** — the one structural difference from
 * `work_item_filings`, which is keyed `target_ref PRIMARY KEY` so a node has at
 * most one filing ever. A story can be wrong in several ways over its life and
 * each is its own bug; refusing the second would be a rule nobody asked for. The
 * story is `origin_ref`, indexed, and the cockpit groups by it.
 *
 * Two statuses for the reason {@link ..\types.js FindingStatus} has them: filing
 * is asynchronous, so `filing` means an agent is creating the item and `filed` is
 * the one carrying a ref.
 *
 * The operator's report itself is **not** here. The desk job's prompt already
 * carries it verbatim and is durable; a second copy would be two records of one
 * sentence, free to drift.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class BugFilingStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Open a filing for a bug the operator asked for.
   *
   * Unconditional, unlike `createWorkItemFiling`: the key is the job, and a job
   * is minted per click, so there is no second-click case to refuse here.
   */
  createBugFiling(input: { jobId: string; originRef: string }): BugFiling {
    const ts = this.ctx.now();
    const row: BugFiling = {
      jobId: input.jobId,
      originRef: input.originRef,
      status: 'filing',
      ticketRef: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO issue_bug_filings (job_id, origin_ref, status, ticket_ref, created_at, updated_at)
         VALUES (@jobId, @originRef, @status, @ticketRef, @createdAt, @updatedAt)`,
      )
      .run(row);
    return row;
  }

  /**
   * Every bug ever raised, oldest first.
   *
   * Unbounded in age like `listWorkItemFilings`, and for its reason: the row is
   * what puts the link on the story's row in the cockpit, and one that aged out
   * would quietly un-say that the operator had already raised this.
   */
  listBugFilings(): BugFiling[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_bug_filings ORDER BY created_at ASC`).all() as BugFilingRow[];
    return rows.map(rowToBugFiling);
  }

  /** The filing a job was created for, if it was created for one. */
  findBugFilingByJobId(jobId: string): BugFiling | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_bug_filings WHERE job_id=?`).get(jobId) as
      | BugFilingRow
      | undefined;
    return row ? rowToBugFiling(row) : null;
  }

  /**
   * Record the bug a filing agent created: `filing` → `filed`.
   *
   * Guarded in the write rather than by a read-then-check, mirroring
   * `linkWorkItemFiling` exactly — an agent that calls `link_ticket` twice links
   * once. Null means there was nothing awaiting a ticket, which the tool turns
   * into an error the agent can read.
   */
  linkBugFiling(jobId: string, ticketRef: string): BugFiling | null {
    const updatedAt = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE issue_bug_filings SET status='filed', ticket_ref=?, updated_at=? WHERE job_id=? AND status='filing'`,
      )
      .run(ticketRef, updatedAt, jobId);
    if (result.changes === 0) return null;
    return this.findBugFilingByJobId(jobId);
  }
}
