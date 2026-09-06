import type { BugFiling } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

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

export class BugFilingStore {
  constructor(private readonly ctx: StoreContext) {}

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

  listBugFilings(): BugFiling[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_bug_filings ORDER BY created_at ASC`).all() as BugFilingRow[];
    return rows.map(rowToBugFiling);
  }

  findBugFilingByJobId(jobId: string): BugFiling | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_bug_filings WHERE job_id=?`).get(jobId) as
      | BugFilingRow
      | undefined;
    return row ? rowToBugFiling(row) : null;
  }

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
