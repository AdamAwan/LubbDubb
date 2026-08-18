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
   * ## Two ways an existing row is found again
   *
   * A **repeat** — same agent, kind, ref and summary — refreshes that row instead
   * of inserting: an agent that reports the same thing on every turn should not
   * fill the operator's list. The summary is the whole key because it is the
   * claim; `where` and `detail` are the same claim's supporting text, so a repeat
   * carrying better evidence overwrites them rather than being filed again beside
   * the thinner one. The status is deliberately *not* reset here: a dismissed
   * finding repeated by its own author stays dismissed, which is what dismissing
   * it meant.
   *
   * A **restatement** — a different agent, or the same one wording the claim
   * differently — merges into the standing row for the same claim. Two agents on
   * two tasks land in the same file and see the same unrelated bug, and the exact
   * key above cannot see that at all: it is the first key's blind spot, and the
   * duplicate pairs in the cockpit's list were nearly all of this shape. The
   * match is on {@link claimKey} over kind, ref and summary, and it is scoped to
   * rows that are **not dismissed** — a dismissed finding is a claim an operator
   * has already answered, so it is not something a later report should be folded
   * silently into. A restatement by *another* agent only **backfills** evidence —
   * it may supply a `where` the first reporter had none for, but it does not get
   * to rewrite their words on a row that carries their name.
   */
  recordFinding(
    agentId: string,
    taskId: string,
    originRef: string | null,
    input: FindingInput,
  ): { finding: Finding; created: boolean } {
    const ts = this.ctx.now();
    // The standing row for this claim first, then — only if there is none — the
    // author's own identical row, which at this point can only be a dismissed
    // one. That order is what "don't match a dismissed finding" means in
    // practice: a live row wins over an answered one, and an author repeating a
    // claim nobody else has restated still lands back on their dismissed row
    // rather than refiling it.
    const existing = this.findStandingClaim(input) ?? this.findOwnRepeat(agentId, input);
    if (existing) {
      // Its author may rewrite its evidence; anyone else may only fill in what
      // is missing.
      const own = existing.agentId === agentId;
      const where = own ? input.where : (existing.where ?? input.where);
      const detail = own ? input.detail : (existing.detail ?? input.detail);
      this.ctx.db
        .prepare(`UPDATE findings SET where_at=?, detail=?, updated_at=? WHERE id=?`)
        .run(where, detail, ts, existing.id);
      return { finding: { ...existing, where, detail, updatedAt: ts }, created: false };
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

  /**
   * The finding already standing for this claim, if one is — oldest first, so a
   * restatement joins the row an operator has been looking at rather than the
   * newest near-copy of it.
   *
   * Candidates are narrowed in SQL to the same kind and ref and to rows nobody
   * has dismissed; the claim comparison itself is in TypeScript because it is
   * normalisation, not a predicate SQL can index. The list is short — a
   * deployment's open findings are tens of rows, not thousands — and keeping the
   * rule in one readable function is worth more here than an index would be.
   */
  private findStandingClaim(input: FindingInput): Finding | null {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM findings WHERE kind=? AND ref IS ? AND status<>'dismissed' ORDER BY created_at ASC, rowid ASC`,
      )
      .all(input.kind, input.ref) as FindingRow[];
    const key = claimKey(input.summary);
    const match = rows.find((r) => claimsMatch(key, claimKey(r.summary)));
    return match ? rowToFinding(match) : null;
  }

  /**
   * The caller's own row for exactly this report, whatever its status.
   *
   * `IS` rather than `=` so a null ref matches a null ref (SQL equality doesn't).
   */
  private findOwnRepeat(agentId: string, input: FindingInput): Finding | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM findings WHERE agent_id=? AND kind=? AND ref IS ? AND summary=?`)
      .get(agentId, input.kind, input.ref, input.summary) as FindingRow | undefined;
    return row ? rowToFinding(row) : null;
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

/**
 * A summary reduced to the claim it makes: case, markdown emphasis, backticks,
 * quotes and punctuation dropped, whitespace collapsed. Two agents describing one
 * discovery rarely type the same string, but they very often type the same string
 * modulo exactly this — "`ingest.ts` buffers the whole body" and "ingest.ts
 * buffers the whole body." are one claim.
 */
function claimKey(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether two claim keys are the same claim.
 *
 * Equal, or one wholly contains the other — a restatement that appends its own
 * qualifier ("… on large uploads") is the same claim, and folding it in is the
 * point. The length floor is what keeps containment from being a merge-everything
 * rule: a very short key is a substring of far too much, and a wrong merge is
 * worse than a duplicate because it hides one agent's report inside another's.
 */
const MIN_CONTAINMENT = 24;

function claimsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < MIN_CONTAINMENT) return false;
  // Padded, so containment lands on whole words: "rate limit" is not a claim
  // about "rate limiter" merely because one string sits inside the other.
  return ` ${long} `.includes(` ${short} `);
}
