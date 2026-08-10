import { nanoid } from 'nanoid';
import type { Finding, FindingInput, FindingKind, FindingStatus } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const FINDING_COLUMNS: ColumnMigrations = {
  findings: {
    ticket_ref: 'TEXT',
    // `where` is SQL — the column is `where_at`, the field is `where`.
    where_at: 'TEXT',
    detail: 'TEXT',
  },
};

/**
 * The `findings` table: what an agent noticed that isn't its own task.
 *
 * Nothing in the dispatcher reads any of this — a finding is testimony an operator
 * acts on, never work the harness schedules.
 */
export class FindingStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File a finding for an agent. `agentId`/`taskId`/`originRef` are the caller's
   * own, resolved from its credential by the tool layer — there is no argument
   * for them, so a finding cannot be filed as another agent.
   *
   * A repeat (same agent, kind, ref and summary) refreshes the existing row
   * instead of inserting: an agent that reports the same thing on every turn
   * should not fill the operator's list. The summary is the whole key because it
   * is the claim — `where` and `detail` are the same claim's supporting text, so
   * a repeat carrying better evidence overwrites them rather than being filed
   * again beside the thinner one. The status is deliberately *not* reset: a
   * dismissed finding repeated stays dismissed, which is what dismissing it
   * meant.
   */
  recordFinding(
    agentId: string,
    taskId: string,
    originRef: string | null,
    input: FindingInput,
  ): { finding: Finding; created: boolean } {
    const ts = this.ctx.now();
    // `IS` rather than `=` so a null ref matches a null ref (SQL equality doesn't).
    const existing = this.ctx.db
      .prepare(`SELECT * FROM findings WHERE agent_id=? AND kind=? AND ref IS ? AND summary=?`)
      .get(agentId, input.kind, input.ref, input.summary) as FindingRow | undefined;
    if (existing) {
      this.ctx.db
        .prepare(`UPDATE findings SET where_at=?, detail=?, updated_at=? WHERE id=?`)
        .run(input.where, input.detail, ts, existing.id);
      return {
        finding: { ...rowToFinding(existing), where: input.where, detail: input.detail, updatedAt: ts },
        created: false,
      };
    }
    const finding: Finding = {
      id: `find_${nanoid(10)}`,
      agentId,
      taskId,
      originRef,
      kind: input.kind,
      ref: input.ref,
      summary: input.summary,
      where: input.where,
      detail: input.detail,
      status: 'open',
      jobId: null,
      ticketRef: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO findings (id, agent_id, task_id, origin_ref, kind, ref, summary, where_at, detail, status, job_id, ticket_ref, created_at, updated_at)
         VALUES (@id, @agentId, @taskId, @originRef, @kind, @ref, @summary, @where, @detail, @status, @jobId, @ticketRef, @createdAt, @updatedAt)`,
      )
      .run(finding);
    return { finding, created: true };
  }

  getFinding(id: string): Finding | null {
    const row = this.ctx.db.prepare(`SELECT * FROM findings WHERE id=?`).get(id) as FindingRow | undefined;
    return row ? rowToFinding(row) : null;
  }

  /** Every finding, newest first — the snapshot feed. */
  listFindings(limit = 100): Finding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM findings ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as FindingRow[];
    return rows.map(rowToFinding);
  }

  /**
   * Resolve an open finding: `promoted` or `filing` (with the job it became), or
   * `dismissed`. Only an open finding can be resolved, so a double-click can't
   * queue a second job for one finding. Returns null when there was nothing open
   * to resolve.
   */
  resolveFinding(
    id: string,
    status: Exclude<FindingStatus, 'open' | 'filed'>,
    jobId: string | null = null,
  ): Finding | null {
    const existing = this.getFinding(id);
    if (!existing || existing.status !== 'open') return null;
    const updatedAt = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE findings SET status=?, job_id=?, updated_at=? WHERE id=?`)
      .run(status, jobId, updatedAt, id);
    return { ...existing, status, jobId, updatedAt };
  }

  /** The finding a job was created for, if it was created for one. */
  findFindingByJobId(jobId: string): Finding | null {
    const row = this.ctx.db.prepare(`SELECT * FROM findings WHERE job_id=?`).get(jobId) as FindingRow | undefined;
    return row ? rowToFinding(row) : null;
  }

  /**
   * Record the ticket a filing agent created: `filing` → `filed`.
   *
   * Guarded in the write (`WHERE id=? AND status='filing'`) rather than by a
   * read-then-check, the same discipline `decideProposal` uses — an agent that
   * calls `link_ticket` twice links once, with no caller obliged to remember to
   * look first. Returns null when there was no filing finding to settle, which
   * is what the tool turns into an error the agent can read.
   */
  linkFindingTicket(id: string, ticketRef: string): Finding | null {
    const updatedAt = this.ctx.now();
    const result = this.ctx.db
      .prepare(`UPDATE findings SET status='filed', ticket_ref=?, updated_at=? WHERE id=? AND status='filing'`)
      .run(ticketRef, updatedAt, id);
    if (result.changes === 0) return null;
    return this.getFinding(id);
  }
}

interface FindingRow {
  id: string;
  agent_id: string;
  task_id: string;
  origin_ref: string | null;
  kind: string;
  ref: string | null;
  summary: string;
  status: string;
  job_id: string | null;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  ticket_ref: string | null | undefined;
  where_at: string | null | undefined;
  detail: string | null | undefined;
  created_at: string;
  updated_at: string;
}

function rowToFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    agentId: r.agent_id,
    taskId: r.task_id,
    originRef: r.origin_ref,
    kind: r.kind as FindingKind,
    ref: r.ref,
    summary: r.summary,
    // A row from before the split has neither column; it is all summary, and the
    // card clamps it rather than inventing a structure it never had.
    where: r.where_at ?? null,
    detail: r.detail ?? null,
    status: r.status as FindingStatus,
    jobId: r.job_id,
    ticketRef: r.ticket_ref ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
