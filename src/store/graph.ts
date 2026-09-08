import type {
  WorkItemFiling,
  WorkItemFilingStatus,
  WorkNode,
  WorkNodeKind,
  WorkNodeObservation,
  WorkNodeProvenance,
} from '../types.js';
import type { StoreContext } from './context.js';
import type { TableRebuild } from './migrate.js';

// → docs/spec/14-persistence.md

export const GRAPH_REBUILDS: readonly TableRebuild[] = [
  {
    table: 'work_item_filings',
    keyedOn: 'job_id',
    copy: (old) => `
      INSERT INTO work_item_filings (target_ref, status, ticket_ref, created_at, updated_at)
      SELECT target_ref, status, ticket_ref, created_at, updated_at FROM ${old}`,
  },
];

export class GraphStore {
  constructor(private readonly ctx: StoreContext) {}

  recordWorkGraph(observations: WorkNodeObservation[]): void {
    const ts = this.ctx.now();
    const stmt = this.ctx.db.prepare(`
      INSERT INTO work_nodes
        (ref, kind, parent_ref, base_ref, title, status, terminal, provenance, first_seen_at, last_seen_at)
      VALUES
        (@ref, @kind, @parentRef, @baseRef, @title, @status, @terminal, @provenance, @ts, @ts)
      ON CONFLICT(ref) DO UPDATE SET
        kind         = excluded.kind,
        parent_ref   = COALESCE(work_nodes.parent_ref, excluded.parent_ref),
        base_ref     = COALESCE(excluded.base_ref, work_nodes.base_ref),
        title        = excluded.title,
        status       = excluded.status,
        terminal     = excluded.terminal,
        provenance   = excluded.provenance,
        last_seen_at = excluded.last_seen_at
    `);
    const write = this.ctx.db.transaction((rows: WorkNodeObservation[]) => {
      for (const o of rows)
        stmt.run({
          ref: o.ref,
          kind: o.kind,
          parentRef: o.parentRef ?? null,
          baseRef: o.baseRef ?? null,
          title: o.title,
          status: o.status,
          terminal: o.terminal ? 1 : 0,
          provenance: o.provenance ?? null,
          ts,
        });
    });
    write(observations);
  }

  listWorkRoots(): WorkNode[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM work_nodes WHERE parent_ref IS NULL ORDER BY last_seen_at DESC`)
      .all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  listWorkSubtree(rootRef: string): WorkNode[] {
    const rows = this.ctx.db
      .prepare(
        `WITH RECURSIVE sub(ref) AS (
           SELECT ref FROM work_nodes WHERE ref = ?
           UNION
           SELECT n.ref FROM work_nodes n JOIN sub s ON n.parent_ref = s.ref
         )
         SELECT w.* FROM work_nodes w JOIN sub ON w.ref = sub.ref
         ORDER BY w.first_seen_at ASC, w.ref ASC`,
      )
      .all(rootRef) as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  listWorkNodes(): WorkNode[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM work_nodes ORDER BY first_seen_at ASC`).all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  mergedPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT ref FROM work_nodes WHERE kind = 'pr' AND status = 'merged'`).all() as {
      ref: string;
    }[];
    const out = new Set<number>();
    for (const row of rows) {
      const n = Number(row.ref.slice('pr:'.length));
      if (Number.isInteger(n)) out.add(n);
    }
    return out;
  }

  settledPrs(): ReadonlyMap<number, 'merged' | 'closed'> {
    const rows = this.ctx.db
      .prepare(`SELECT ref, status FROM work_nodes WHERE kind = 'pr' AND status IN ('merged', 'closed')`)
      .all() as { ref: string; status: string }[];
    const out = new Map<number, 'merged' | 'closed'>();
    for (const row of rows) {
      const n = Number(row.ref.slice('pr:'.length));
      if (Number.isInteger(n)) out.set(n, row.status === 'merged' ? 'merged' : 'closed');
    }
    return out;
  }

  createWorkItemFiling(input: { targetRef: string }): WorkItemFiling | null {
    const ts = this.ctx.now();
    const row: WorkItemFiling = {
      targetRef: input.targetRef,
      status: 'filing',
      ticketRef: null,
      createdAt: ts,
      updatedAt: ts,
    };
    const result = this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO work_item_filings (target_ref, status, ticket_ref, created_at, updated_at)
         VALUES (@targetRef, @status, @ticketRef, @createdAt, @updatedAt)`,
      )
      .run(row);
    return result.changes === 0 ? null : row;
  }

  listWorkItemFilings(): WorkItemFiling[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM work_item_filings ORDER BY created_at ASC`)
      .all() as WorkItemFilingRow[];
    return rows.map(rowToWorkItemFiling);
  }

  linkWorkItemFiling(targetRef: string, ticketRef: string): WorkItemFiling | null {
    const updatedAt = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE work_item_filings SET status='filed', ticket_ref=?, updated_at=? WHERE target_ref=? AND status='filing'`,
      )
      .run(ticketRef, updatedAt, targetRef);
    if (result.changes === 0) return null;
    const row = this.ctx.db.prepare(`SELECT * FROM work_item_filings WHERE target_ref=?`).get(targetRef) as
      | WorkItemFilingRow
      | undefined;
    return row ? rowToWorkItemFiling(row) : null;
  }

  dropWorkItemFiling(targetRef: string): void {
    this.ctx.db.prepare(`DELETE FROM work_item_filings WHERE target_ref=? AND status='filing'`).run(targetRef);
  }

  ignoreWorkItem(targetRef: string): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO work_item_ignores (target_ref, created_at) VALUES (?, ?)`)
      .run(targetRef, this.ctx.now());
  }

  unignoreWorkItem(targetRef: string): void {
    this.ctx.db.prepare(`DELETE FROM work_item_ignores WHERE target_ref=?`).run(targetRef);
  }

  listWorkItemIgnores(): string[] {
    const rows = this.ctx.db.prepare(`SELECT target_ref FROM work_item_ignores`).all() as { target_ref: string }[];
    return rows.map((r) => r.target_ref);
  }
}

interface WorkNodeRow {
  ref: string;
  kind: string;
  parent_ref: string | null;
  base_ref: string | null;
  title: string;
  status: string;
  terminal: number;
  provenance: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface WorkItemFilingRow {
  target_ref: string;
  status: string;
  ticket_ref: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkNode(row: WorkNodeRow): WorkNode {
  return {
    ref: row.ref,
    kind: row.kind as WorkNodeKind,
    parentRef: row.parent_ref,
    baseRef: row.base_ref,
    title: row.title,
    status: row.status,
    terminal: row.terminal === 1,
    provenance: row.provenance as WorkNodeProvenance | null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToWorkItemFiling(row: WorkItemFilingRow): WorkItemFiling {
  return {
    targetRef: row.target_ref,
    status: row.status as WorkItemFilingStatus,
    ticketRef: row.ticket_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
