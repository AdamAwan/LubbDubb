import type { FeatureSequence, FeatureSequenceEdge } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `feature_sequences` and `feature_sequence_edges` tables: the order the
 * stories under one Feature are worked in, and the operator's answer to it.
 * → `docs/spec/33-story-sequencing.md#the-record`
 *
 * Both tables are new, so neither is owed a `ColumnMigrations` entry — but a table
 * being new *once* does not keep it exempt, and a column added to either later
 * will.
 *
 * **The edges are written as a set, never merged.** An edge dropped from an amended
 * order has to disappear, and an upsert on (issue, dependsOn) would leave it behind
 * indistinguishable from one still meant — the row would then hold work in an order
 * nobody had chosen, which is the one failure the whole mechanism must not be able
 * to cause. The two writes go in one transaction for the same reason: a sequence
 * carrying half of an old order and half of a new one is not an order.
 */
export class SequenceStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write a Feature's order, replacing whatever stood.
   *
   * `createdAt` survives a rewrite — when a Feature was *first* sequenced is a
   * different fact from when its current order was written, and the card shows
   * both. The answer does not survive: a new order over a different set of stories
   * is a new question, so `answeredBy` / `answeredAt` come back null and the
   * operator is asked again. That is deliberate rather than incidental — carrying
   * an acceptance forward onto edges nobody has read would make the hold stand on
   * an approval that was given for something else.
   */
  recordFeatureSequence(input: {
    originRef: string;
    status: FeatureSequence['status'];
    reason: string;
    unsure: string | null;
    standingKey: string;
    edges: readonly FeatureSequenceEdge[];
    agentId: string | null;
    taskId: string | null;
  }): FeatureSequence {
    const ts = this.ctx.now();
    const previous = this.getFeatureSequence(input.originRef);
    const row: FeatureSequence = {
      ...input,
      edges: [...input.edges],
      answeredBy: null,
      answeredAt: null,
      createdAt: previous?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `INSERT INTO feature_sequences
             (origin_ref, status, reason, unsure, standing_key, answered_by, answered_at,
              agent_id, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
           ON CONFLICT(origin_ref) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             unsure = excluded.unsure,
             standing_key = excluded.standing_key,
             answered_by = NULL,
             answered_at = NULL,
             agent_id = excluded.agent_id,
             task_id = excluded.task_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          row.originRef,
          row.status,
          row.reason,
          row.unsure,
          row.standingKey,
          row.agentId,
          row.taskId,
          row.createdAt,
          row.updatedAt,
        );
      this.ctx.db.prepare(`DELETE FROM feature_sequence_edges WHERE origin_ref = ?`).run(row.originRef);
      const insert = this.ctx.db.prepare(
        `INSERT INTO feature_sequence_edges (origin_ref, issue, depends_on, source, reason)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const edge of row.edges) {
        insert.run(row.originRef, edge.issue, edge.dependsOn, edge.source, edge.reason);
      }
    })();
    return row;
  }

  /**
   * The operator's answer. `accepted` is the only status the dispatch gate reads;
   * `declined` is stored rather than forgotten, because "run them all" is a real
   * answer about a feature whose stories genuinely are independent, and a proposal
   * that came back on the next pulse would make the fleet argue with them once a
   * Feature until they gave in.
   *
   * Returns null for a Feature with no order, which is what a click on a row the
   * pulse withdrew underneath it looks like — a refusal, never a row conjured to
   * receive the answer.
   */
  answerFeatureSequence(originRef: string, status: 'accepted' | 'declined', by: string): FeatureSequence | null {
    const ts = this.ctx.now();
    const changed = this.ctx.db
      .prepare(
        `UPDATE feature_sequences SET status = ?, answered_by = ?, answered_at = ?, updated_at = ?
         WHERE origin_ref = ?`,
      )
      .run(status, by, ts, ts, originRef).changes;
    return changed === 0 ? null : this.getFeatureSequence(originRef);
  }

  getFeatureSequence(originRef: string): FeatureSequence | null {
    const row = this.ctx.db.prepare(`SELECT * FROM feature_sequences WHERE origin_ref = ?`).get(originRef) as
      | Row
      | undefined;
    return row ? this.hydrate(row, this.edgesFor(originRef)) : null;
  }

  /**
   * Every order on file, with its edges. One read per pulse rather than a lookup
   * per Feature: the rule compares a key for every Feature in the world, and a
   * query each would turn a board of forty into forty round trips.
   */
  listFeatureSequences(): FeatureSequence[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM feature_sequences ORDER BY origin_ref`).all() as Row[];
    if (rows.length === 0) return [];
    const edges = new Map<string, FeatureSequenceEdge[]>();
    for (const edge of this.ctx.db
      .prepare(`SELECT * FROM feature_sequence_edges ORDER BY issue, depends_on`)
      .all() as EdgeRow[]) {
      const group = edges.get(edge.origin_ref);
      if (group) group.push(mapEdge(edge));
      else edges.set(edge.origin_ref, [mapEdge(edge)]);
    }
    return rows.map((row) => this.hydrate(row, edges.get(row.origin_ref) ?? []));
  }

  private edgesFor(originRef: string): FeatureSequenceEdge[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM feature_sequence_edges WHERE origin_ref = ? ORDER BY issue, depends_on`)
      .all(originRef) as EdgeRow[];
    return rows.map(mapEdge);
  }

  private hydrate(row: Row, edges: FeatureSequenceEdge[]): FeatureSequence {
    return {
      originRef: row.origin_ref,
      status: row.status as FeatureSequence['status'],
      reason: row.reason,
      unsure: row.unsure,
      standingKey: row.standing_key,
      edges,
      answeredBy: row.answered_by,
      answeredAt: row.answered_at,
      agentId: row.agent_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function mapEdge(row: EdgeRow): FeatureSequenceEdge {
  return {
    issue: row.issue,
    dependsOn: row.depends_on,
    source: row.source as FeatureSequenceEdge['source'],
    reason: row.reason,
  };
}

interface Row {
  origin_ref: string;
  status: string;
  reason: string;
  unsure: string | null;
  standing_key: string;
  answered_by: string | null;
  answered_at: string | null;
  agent_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  origin_ref: string;
  issue: number;
  depends_on: number;
  source: string;
  reason: string | null;
}
