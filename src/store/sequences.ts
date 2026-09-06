import type { FeatureSequence, FeatureSequenceEdge } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const SEQUENCE_COLUMNS: ColumnMigrations = {
  feature_sequences: {
    members: 'TEXT',
  },
};

export class SequenceStore {
  constructor(private readonly ctx: StoreContext) {}

  recordFeatureSequence(input: {
    originRef: string;
    status: FeatureSequence['status'];
    reason: string;
    unsure: string | null;
    standingKey: string;
    edges: readonly FeatureSequenceEdge[];
    members: readonly number[];
    agentId: string | null;
    taskId: string | null;
  }): FeatureSequence {
    const ts = this.ctx.now();
    const previous = this.getFeatureSequence(input.originRef);
    const row: FeatureSequence = {
      ...input,
      edges: [...input.edges],
      members: [...input.members],
      answeredBy: null,
      answeredAt: null,
      createdAt: previous?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `INSERT INTO feature_sequences
             (origin_ref, status, reason, unsure, standing_key, members, answered_by, answered_at,
              agent_id, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
           ON CONFLICT(origin_ref) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             unsure = excluded.unsure,
             standing_key = excluded.standing_key,
             members = excluded.members,
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
          JSON.stringify(row.members),
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
      members: parseMembers(row.members),
      answeredBy: row.answered_by,
      answeredAt: row.answered_at,
      agentId: row.agent_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function parseMembers(raw: string | null): number[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) return null;
    return parsed as number[];
  } catch {
    return null;
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
  members: string | null;
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
