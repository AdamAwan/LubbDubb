import { nanoid } from 'nanoid';
import type {
  PadDecision,
  Retrospective,
  RetroMiss,
  RetroMissInput,
  ScratchEntry,
  ScratchPadSummary,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const SCRATCH_COLUMNS: ColumnMigrations = {
  scratch_entries: { decision: 'TEXT' },
  retrospectives: { misses_at: 'TEXT' },
  retro_misses: {},
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
    this.ctx
      .prep(
        `INSERT INTO scratch_entries (id, pad_ref, author_origin_ref, agent_id, task_id, topic, note, decision, created_at)
         VALUES (@id, @padRef, @authorOriginRef, @agentId, @taskId, @topic, @note, @decision, @createdAt)`,
      )
      .run({ ...row, decision: row.decision ? JSON.stringify(row.decision) : null });
    return row;
  }

  listScratchEntries(padRef: string): ScratchEntry[] {
    const rows = this.ctx
      .prep(`SELECT * FROM scratch_entries WHERE pad_ref=? ORDER BY created_at ASC, rowid ASC`)
      .all(padRef) as ScratchEntryRow[];
    return rows.map(rowToScratchEntry);
  }

  listScratchPadSummaries(): ScratchPadSummary[] {
    const rows = this.ctx
      .prep(
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
    /** Replaces the goal's misses whole when given; left out, the ones already recorded stand. */
    misses?: readonly RetroMissInput[];
  }): Retrospective {
    const ts = this.ctx.now();
    const prev = this.getRetrospective(input.originRef);
    const { misses, ...fields } = input;
    const row: Retrospective = { ...fields, createdAt: prev?.createdAt ?? ts, updatedAt: ts };
    this.ctx.db.transaction(() => {
      this.writeRetrospective(row, misses === undefined ? null : ts);
      if (misses !== undefined) this.replaceRetroMisses(row, misses);
    })();
    return row;
  }

  /** Every retrospective miss recorded at or after `since`, oldest first. */
  listRetroMissesSince(since: string): RetroMiss[] {
    const rows = this.ctx
      .prep(`SELECT * FROM retro_misses WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as RetroMissRow[];
    return rows.map(rowToRetroMiss);
  }

  private replaceRetroMisses(row: Retrospective, misses: readonly RetroMissInput[]): void {
    this.ctx.prep(`DELETE FROM retro_misses WHERE origin_ref=?`).run(row.originRef);
    for (const miss of misses) {
      this.ctx
        .prep(
          `INSERT INTO retro_misses (id, origin_ref, cause, guard, path, summary, agent_id, task_id, created_at)
           VALUES (@id, @originRef, @cause, @guard, @path, @summary, @agentId, @taskId, @createdAt)`,
        )
        .run({
          id: `rtm_${nanoid(10)}`,
          originRef: row.originRef,
          cause: miss.cause,
          guard: miss.guard,
          path: miss.path,
          summary: miss.summary,
          agentId: row.agentId,
          taskId: row.taskId,
          createdAt: row.createdAt,
        });
    }
  }

  private writeRetrospective(row: Retrospective, missesAt: string | null): void {
    this.ctx
      .prep(
        `INSERT INTO retrospectives (origin_ref, summary, document, agent_id, task_id, created_at, updated_at, misses_at)
         VALUES (@originRef, @summary, @document, @agentId, @taskId, @createdAt, @updatedAt, @missesAt)
         ON CONFLICT(origin_ref) DO UPDATE SET
           summary=excluded.summary, document=excluded.document, agent_id=excluded.agent_id,
           task_id=excluded.task_id, updated_at=excluded.updated_at,
           misses_at=COALESCE(misses_at, excluded.misses_at)`,
      )
      .run({ ...row, missesAt });
  }

  getRetrospective(originRef: string): Retrospective | null {
    const row = this.ctx.prep(`SELECT * FROM retrospectives WHERE origin_ref=?`).get(originRef) as
      RetrospectiveRow | undefined;
    return row ? rowToRetrospective(row) : null;
  }

  /**
   * When each retrospective that answered the misses question was first written, for those written at or
   * after `since`. One written before misses existed never answered it, and is not an occasion to miss on.
   */
  listRetrospectivesWrittenSince(since: string): { originRef: string; createdAt: string }[] {
    const rows = this.ctx
      .prep(
        `SELECT origin_ref, created_at FROM retrospectives
          WHERE created_at >= ? AND misses_at IS NOT NULL ORDER BY created_at ASC`,
      )
      .all(since) as { origin_ref: string; created_at: string }[];
    return rows.map((r) => ({ originRef: r.origin_ref, createdAt: r.created_at }));
  }

  /** When the first retrospective answered the misses question; null before any has. */
  firstMissesAt(): string | null {
    const row = this.ctx.prep(`SELECT MIN(misses_at) AS at FROM retrospectives`).get() as { at: string | null };
    return row.at;
  }

  listRetrospectiveOrigins(): string[] {
    const rows = this.ctx.prep(`SELECT origin_ref FROM retrospectives`).all() as { origin_ref: string }[];
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

interface RetroMissRow {
  id: string;
  origin_ref: string;
  cause: string;
  guard: string;
  path: string;
  summary: string;
  agent_id: string;
  task_id: string;
  created_at: string;
}

function rowToRetroMiss(r: RetroMissRow): RetroMiss {
  return {
    id: r.id,
    originRef: r.origin_ref,
    cause: r.cause as RetroMiss['cause'],
    guard: r.guard as RetroMiss['guard'],
    path: r.path,
    summary: r.summary,
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
  };
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
