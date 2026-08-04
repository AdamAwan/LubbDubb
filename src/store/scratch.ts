import { nanoid } from 'nanoid';
import type { Retrospective, ScratchEntry, ScratchPadSummary } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `scratch_entries` and `retrospectives` tables: a goal's written record.
 *
 * Both are prose nothing branches on, and they are the two halves of one thing —
 * the pad is written *during* a run by whoever is working it, the retrospective
 * *after* it by an agent that did none of the work and reads the pad to write it.
 */
export class ScratchStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Append one entry to an issue's shared pad.
   *
   * There is deliberately no update and no delete beside this: an agent able to
   * revise its own entries would leave a tidied record rather than a true one, and
   * a retrospective reads the trail for *when* something was learned. The pad ref
   * is resolved from the caller's credential upstream (`padWriteTarget`), never
   * from an argument.
   */
  appendScratchEntry(input: {
    padRef: string;
    authorOriginRef: string;
    agentId: string;
    taskId: string;
    topic: string | null;
    note: string;
  }): ScratchEntry {
    const row: ScratchEntry = { id: `scr_${nanoid(10)}`, ...input, createdAt: this.ctx.now() };
    this.ctx.db
      .prepare(
        `INSERT INTO scratch_entries (id, pad_ref, author_origin_ref, agent_id, task_id, topic, note, created_at)
         VALUES (@id, @padRef, @authorOriginRef, @agentId, @taskId, @topic, @note, @createdAt)`,
      )
      .run(row);
    return row;
  }

  /**
   * One pad, oldest first — the order the trail is read in. Unbounded on purpose:
   * a pad is already bounded by one goal's agents, and dropping the early entries
   * would lose exactly the ones a late retrospective has no other way to hear.
   *
   * Ties on `created_at` break on **rowid**, which is insertion order. The id
   * cannot do it — it is a nanoid, so two entries written in the same millisecond
   * would come back in a random order, and this pad is read as a sequence.
   */
  listScratchEntries(padRef: string): ScratchEntry[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM scratch_entries WHERE pad_ref=? ORDER BY created_at ASC, rowid ASC`)
      .all(padRef) as ScratchEntryRow[];
    return rows.map(rowToScratchEntry);
  }

  /**
   * Every pad that has been written to, as a count and the age of its newest
   * entry — what the cockpit needs to draw a way in without opening one.
   *
   * **One grouped query for the whole world**, not one per issue: this is read on
   * every `/api/state` poll, and a per-issue read would scale the poll with the
   * number of goals to say nothing more than these two numbers do. `MAX` over an
   * ISO-8601 UTC timestamp sorts as it reads, which is the same property
   * {@link listScratchEntries} already leans on.
   */
  listScratchPadSummaries(): ScratchPadSummary[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT pad_ref, COUNT(*) AS entries, MAX(created_at) AS updated_at
           FROM scratch_entries GROUP BY pad_ref`,
      )
      .all() as { pad_ref: string; entries: number; updated_at: string }[];
    return rows.map((r) => ({ padRef: r.pad_ref, entries: r.entries, updatedAt: r.updated_at }));
  }

  /**
   * Write (or revise) an issue's retrospective.
   *
   * Upsert on the issue, so a second submission revises one row rather than
   * duplicating it — idempotence in the write rather than in a read-then-check.
   * `created_at` survives an overwrite, so the row still dates the moment the run
   * was first written up rather than the last time someone tidied it.
   */
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

  /**
   * Which goals have one — **origins only, never the writing**. Rule `issue-retro` needs to
   * know whether to dispatch and that is the whole of what it may know: a rule
   * branching on retrospective prose would let one agent's account of a run change
   * what the harness schedules next.
   */
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
