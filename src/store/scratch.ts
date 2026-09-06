import { nanoid } from 'nanoid';
import type { PadDecision, Retrospective, ScratchEntry, ScratchPadSummary } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const SCRATCH_COLUMNS: ColumnMigrations = {
  scratch_entries: { decision: 'TEXT' },
  retrospectives: {},
};

export class ScratchStore {
  constructor(private readonly ctx: StoreContext) {}

  appendScratchEntry(input: {
    padRef: string;
    authorOriginRef: string;
    agentId: string;
    taskId: string;
    topic: string | null;
    note: string;
    decision: PadDecision | null;
  }): ScratchEntry {
    const row: ScratchEntry = { id: `scr_${nanoid(10)}`, ...input, createdAt: this.ctx.now() };
    this.ctx.db
      .prepare(
        `INSERT INTO scratch_entries (id, pad_ref, author_origin_ref, agent_id, task_id, topic, note, decision, created_at)
         VALUES (@id, @padRef, @authorOriginRef, @agentId, @taskId, @topic, @note, @decision, @createdAt)`,
      )
      .run({ ...row, decision: row.decision ? JSON.stringify(row.decision) : null });
    return row;
  }

  listScratchEntries(padRef: string): ScratchEntry[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM scratch_entries WHERE pad_ref=? ORDER BY created_at ASC, rowid ASC`)
      .all(padRef) as ScratchEntryRow[];
    return rows.map(rowToScratchEntry);
  }

  listScratchPadSummaries(): ScratchPadSummary[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT pad_ref, COUNT(*) AS entries, MAX(created_at) AS updated_at
           FROM scratch_entries GROUP BY pad_ref`,
      )
      .all() as { pad_ref: string; entries: number; updated_at: string }[];
    return rows.map((r) => ({ padRef: r.pad_ref, entries: r.entries, updatedAt: r.updated_at }));
  }

  recordRetrospective(input: {
    originRef: string;
    summary: string;
    document: string;
    agentId: string;
    taskId: string;
  }): Retrospective {
    const ts = this.ctx.now();
    const prev = this.getRetrospective(input.originRef);
    const row: Retrospective = { ...input, createdAt: prev?.createdAt ?? ts, updatedAt: ts };
    this.ctx.db
      .prepare(
        `INSERT INTO retrospectives (origin_ref, summary, document, agent_id, task_id, created_at, updated_at)
         VALUES (@originRef, @summary, @document, @agentId, @taskId, @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET
           summary=excluded.summary, document=excluded.document, agent_id=excluded.agent_id,
           task_id=excluded.task_id, updated_at=excluded.updated_at`,
      )
      .run(row);
    return row;
  }

  getRetrospective(originRef: string): Retrospective | null {
    const row = this.ctx.db.prepare(`SELECT * FROM retrospectives WHERE origin_ref=?`).get(originRef) as
      | RetrospectiveRow
      | undefined;
    return row ? rowToRetrospective(row) : null;
  }

  listRetrospectiveOrigins(): string[] {
    const rows = this.ctx.db.prepare(`SELECT origin_ref FROM retrospectives`).all() as { origin_ref: string }[];
    return rows.map((r) => r.origin_ref);
  }
}

interface ScratchEntryRow {
  id: string;
  pad_ref: string;
  author_origin_ref: string;
  agent_id: string;
  task_id: string;
  topic: string | null;
  note: string;
  decision?: string | null;
  created_at: string;
}
interface RetrospectiveRow {
  origin_ref: string;
  summary: string;
  document: string;
  agent_id: string;
  task_id: string;
  created_at: string;
  updated_at: string;
}

function rowToScratchEntry(r: ScratchEntryRow): ScratchEntry {
  return {
    id: r.id,
    padRef: r.pad_ref,
    authorOriginRef: r.author_origin_ref,
    agentId: r.agent_id,
    taskId: r.task_id,
    topic: r.topic,
    note: r.note,
    decision: r.decision ? (JSON.parse(r.decision) as PadDecision) : null,
    createdAt: r.created_at,
  };
}
function rowToRetrospective(r: RetrospectiveRow): Retrospective {
  return {
    originRef: r.origin_ref,
    summary: r.summary,
    document: r.document,
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
