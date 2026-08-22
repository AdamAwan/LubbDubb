import type { Finding, FindingKind, FindingStatus } from '../types.js';
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
 * The `findings` table, **read-only and on its way out**.
 *
 * Nothing writes it any more: a claim an agent files is a `knowledge_facts` row,
 * and every row this table holds was carried across by the fold
 * ([14](../../docs/spec/14-persistence.md#the-one-that-exists-folding-the-claim-stores)).
 * What is left here is the two readers that have not moved yet — the snapshot's
 * historical list and the pets panel's label for a `finding` origin — and they go
 * with the table.
 */
export class FindingStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * The claim each of these findings made, by id — the pets panel's label for a
   * `finding` origin. By id rather than off {@link listFindings}, whose cap is
   * the reason a client-side join would leave the oldest pets unnamed. A missing
   * id is absent from the map, never an error.
   * → `docs/spec/22-pets.md#the-sources`
   */
  findingLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, summary FROM findings WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      summary: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.summary]));
  }

  /** Every finding, newest first — the snapshot feed. */
  listFindings(limit = 100): Finding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM findings ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as FindingRow[];
    return rows.map(rowToFinding);
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
