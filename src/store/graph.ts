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

/**
 * `work_item_filings` lost its `job_id` when the harness started filing work items
 * itself (issue #394): there is no desk agent behind one any more, so there is no
 * job to name and nothing that resolves a filing from an agent's credential.
 *
 * A key change rather than an additive column, so it is a rebuild — SQLite has no
 * `ALTER COLUMN`, and a `NOT NULL` column no writer fills would refuse every new
 * filing on every database created before this build. The rows themselves come
 * across untouched: `target_ref` was already the primary key, so nothing is
 * re-derived and a filing an operator made last month keeps its ticket.
 */
export const GRAPH_REBUILDS: readonly TableRebuild[] = [
  {
    table: 'work_item_filings',
    keyedOn: 'job_id',
    copy: (old) => `
      INSERT INTO work_item_filings (target_ref, status, ticket_ref, created_at, updated_at)
      SELECT target_ref, status, ticket_ref, created_at, updated_at FROM ${old}`,
  },
];

/**
 * The durable work graph — `work_nodes` — and the two operator answers to a node
 * nothing in the tracker records: `work_item_filings` (file a ticket for it) and
 * `work_item_ignores` (no ticket is wanted).
 *
 * The three are one module because the filing is what *parents* its node: the
 * fold reads the filings and writes the edge, so a filing without the graph beside
 * it is a row nothing consumes.
 */
export class GraphStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write this pulse's observations. Upsert-only: a node not in `observations` is
   * left exactly as it was, which is what makes the graph outlive the world's
   * memory of a merged PR.
   *
   * `parent_ref` is write-once once non-null — work lineage does not change, and an
   * immutable edge makes a cycle impossible rather than merely guarded, which
   * matters because {@link listWorkSubtree} is recursive. A null parent may still be
   * filled later, so a stray PR can be adopted when its issue link appears.
   */
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

  /** Every node with no parent — one per work item the harness has ever touched. */
  listWorkRoots(): WorkNode[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM work_nodes WHERE parent_ref IS NULL ORDER BY last_seen_at DESC`)
      .all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  /**
   * One root and everything beneath it. `UNION` rather than `UNION ALL` so the walk
   * terminates even if a cycle ever reached the table — belt to the write-once
   * parent's braces.
   */
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

  /**
   * Every node, in one read.
   *
   * The unrecorded-work detector needs the whole table — its verdict is per-node
   * but the evidence beside it is what ran underneath — and rebuilding that from
   * {@link listWorkRoots} plus a {@link listWorkSubtree} each is N+1 queries for
   * something one `SELECT` answers.
   *
   * Note this is *not* wired into the recorder, which still reads `existing` the
   * roots-then-subtrees way. Doing so would close the stage-1 backfill reach gap
   * (a node whose ancestor chain is incomplete is invisible to the fold), and that
   * gap was ruled on and deliberately left — see `docs/spec/14-persistence.md`.
   */
  listWorkNodes(): WorkNode[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM work_nodes ORDER BY first_seen_at ASC`).all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  // -- Work-item filings (stage 3) ------------------------------------------

  /**
   * Open a filing for an unrecorded node — the claim, taken **before** the item is
   * created.
   *
   * Returns null when one already stands for that target: the refusal lives in the
   * write (`target_ref` is the primary key), not in a caller remembering to look
   * first — the same discipline as `decideProposal` and `linkFindingTicket`. That
   * is what it is for now that filing is a call the route makes rather than an
   * agent it queues: two clicks land in the same second, and the second one has to
   * lose *before* anything reaches the tracker, or the operator gets two tickets
   * for one piece of work.
   *
   * No job. It used to carry the desk job doing the filing, which is how
   * `link_ticket` found its way back here; since #394 the harness files a work item
   * itself, so there is no agent to resolve from and nothing to store.
   */
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

  /**
   * Every filing ever opened.
   *
   * Unbounded on purpose, like `listProposals`: a linked filing is what parents
   * its node, and one that aged out of a window would have the fold quietly
   * un-record work the operator already filed.
   */
  listWorkItemFilings(): WorkItemFiling[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM work_item_filings ORDER BY created_at ASC`)
      .all() as WorkItemFilingRow[];
    return rows.map(rowToWorkItemFiling);
  }

  /**
   * Record the item the harness created: `filing` → `filed`.
   *
   * Guarded in the write rather than by a read-then-check, mirroring
   * `linkFindingTicket` exactly. Null means there was nothing awaiting a ticket.
   */
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

  /**
   * Release a claim whose filing never happened — the tracker refused the create,
   * or the request died between the two.
   *
   * A delete rather than a third status, for {@link unignoreWorkItem}'s reason: the
   * operator asked for a ticket and there is none, so the honest record is the one
   * that has the button back. Narrowed to `filing` so it can never take a row that
   * has a ref on it.
   */
  dropWorkItemFiling(targetRef: string): void {
    this.ctx.db.prepare(`DELETE FROM work_item_filings WHERE target_ref=? AND status='filing'`).run(targetRef);
  }

  /**
   * The operator's other answer to unrecorded work: no ticket is wanted for this.
   *
   * Idempotent in the write (`target_ref` is the primary key), so a second click
   * is one row — the discipline {@link createWorkItemFiling} follows for the same
   * reason. Undone by {@link unignoreWorkItem}, which is a delete: an ignore that
   * could be "cleared" to some other state would be a second representation of
   * "not ignored".
   */
  ignoreWorkItem(targetRef: string): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO work_item_ignores (target_ref, created_at) VALUES (?, ?)`)
      .run(targetRef, this.ctx.now());
  }

  /** Undo. Silent when nothing stood — the caller asked for an absence and has it. */
  unignoreWorkItem(targetRef: string): void {
    this.ctx.db.prepare(`DELETE FROM work_item_ignores WHERE target_ref=?`).run(targetRef);
  }

  /**
   * Every standing ignore. Unbounded for {@link listWorkItemFilings}' reason: a
   * verdict that aged out of a window would put a row the operator dismissed back
   * in front of them, which is the whole thing they were clearing.
   */
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
