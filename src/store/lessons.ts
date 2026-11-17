import { nanoid } from 'nanoid';
import type {
  LessonDraft,
  LessonDraftStatus,
  LessonFix,
  LessonMiss,
  PendingLessonDraft,
  RemedyCause,
  RemedyKind,
} from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/41-repo-lessons.md#the-record-and-the-desk

const COLUMNS =
  'id, group_key, kind, cause, place, goals, misses, status, task_id, fix, title, summary, reason, ' +
  'pr_number, ticket_ref, created_at, settled_at';

/** What `lesson_conclude` says, kept on the row. */
interface LessonConclusion {
  fix: LessonFix | null;
  title: string | null;
  summary: string | null;
  reason: string | null;
}

type SettledStatus = Extract<LessonDraftStatus, 'adopted' | 'declined' | 'filed' | 'nothing' | 'unanswered'>;

export class LessonStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Null when a draft is already out, or the group already has a live one: the partial unique indexes are the lock. */
  openDraft(input: {
    groupKey: string;
    kind: RemedyKind;
    cause: RemedyCause;
    where: string;
    goals: string[];
    misses: LessonMiss[];
    briefing: string;
  }): LessonDraft | null {
    const id = `lsn_${nanoid(10)}`;
    const info = this.ctx
      .prep(
        `INSERT OR IGNORE INTO lesson_drafts
           (id, group_key, kind, cause, place, goals, misses, briefing, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.groupKey,
        input.kind,
        input.cause,
        input.where,
        JSON.stringify(input.goals),
        JSON.stringify(input.misses),
        input.briefing,
        this.ctx.now(),
      );
    return info.changes === 0 ? null : this.getDraft(id);
  }

  claimDraft(id: string, taskId: string): boolean {
    const info = this.ctx
      .prep(`UPDATE lesson_drafts SET status='dispatched', task_id=? WHERE id=? AND status='pending'`)
      .run(taskId, id);
    return info.changes > 0;
  }

  /** The agent opened its pull request: the draft waits on the operator's review. */
  concludePr(id: string, prNumber: number, said: LessonConclusion): boolean {
    const info = this.ctx
      .prep(
        `UPDATE lesson_drafts SET status='pr-open', pr_number=@prNumber, fix=@fix, title=@title, summary=@summary, reason=@reason
         WHERE id=@id AND status='dispatched'`,
      )
      .run({ id, prNumber, ...said });
    return info.changes > 0;
  }

  /** Settles a draft out of one of `from`; false when it was not in one. */
  settle(
    id: string,
    status: SettledStatus,
    from: readonly LessonDraftStatus[],
    said: Partial<LessonConclusion> & { ticketRef?: string } = {},
  ): boolean {
    const info = this.ctx
      .prep(
        `UPDATE lesson_drafts SET status=@status, settled_at=@at,
           fix=COALESCE(@fix, fix), title=COALESCE(@title, title), summary=COALESCE(@summary, summary),
           reason=COALESCE(@reason, reason), ticket_ref=COALESCE(@ticketRef, ticket_ref)
         WHERE id=@id AND status IN (SELECT value FROM json_each(@from))`,
      )
      .run({
        id,
        status,
        at: this.ctx.now(),
        from: JSON.stringify(from),
        fix: said.fix ?? null,
        title: said.title ?? null,
        summary: said.summary ?? null,
        reason: said.reason ?? null,
        ticketRef: said.ticketRef ?? null,
      });
    return info.changes > 0;
  }

  getDraft(id: string): LessonDraft | null {
    const row = this.ctx.prep(`SELECT ${COLUMNS} FROM lesson_drafts WHERE id=?`).get(id) as DraftRow | undefined;
    return row ? toDraft(row) : null;
  }

  /** The one draft waiting for its agent, with the briefing it is dispatched with. */
  pendingDraft(): PendingLessonDraft | null {
    const row = this.ctx.prep(`SELECT ${COLUMNS}, briefing FROM lesson_drafts WHERE status = 'pending'`).get() as
      (DraftRow & { briefing: string }) | undefined;
    return row ? { ...toDraft(row), briefing: row.briefing } : null;
  }

  listDrafts(): LessonDraft[] {
    return (
      this.ctx.prep(`SELECT ${COLUMNS} FROM lesson_drafts ORDER BY created_at ASC, rowid ASC`).all() as DraftRow[]
    ).map(toDraft);
  }

  /** The drafts still waiting on their agent or on the operator's review: what the desk settles. */
  unsettledDrafts(): LessonDraft[] {
    return (
      this.ctx
        .prep(
          `SELECT ${COLUMNS} FROM lesson_drafts WHERE status IN ('dispatched', 'pr-open') ORDER BY created_at ASC, rowid ASC`,
        )
        .all() as DraftRow[]
    ).map(toDraft);
  }

  /**
   * This fleet's adopted lessons whose pull request merged at or after `since`: the one set the pool
   * digest publishes and the pool tab counts toward a company-wide cause.
   */
  adoptedSince(since: string): LessonDraft[] {
    return (
      this.ctx
        .prep(
          `SELECT ${COLUMNS} FROM lesson_drafts
            WHERE status = 'adopted' AND settled_at >= ? AND pr_number IS NOT NULL AND fix IS NOT NULL
            ORDER BY settled_at ASC, rowid ASC`,
        )
        .all(since) as DraftRow[]
    ).map(toDraft);
  }
}

function toDraft(r: DraftRow): LessonDraft {
  return {
    id: r.id,
    groupKey: r.group_key,
    kind: r.kind as RemedyKind,
    cause: r.cause as RemedyCause,
    where: r.place,
    goals: parseArray<string>(r.goals),
    misses: parseArray<LessonMiss>(r.misses),
    status: r.status as LessonDraftStatus,
    taskId: r.task_id,
    fix: r.fix as LessonFix | null,
    title: r.title,
    summary: r.summary,
    reason: r.reason,
    prNumber: r.pr_number,
    ticketRef: r.ticket_ref,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

interface DraftRow {
  id: string;
  group_key: string;
  kind: string;
  cause: string;
  place: string;
  goals: string;
  misses: string;
  status: string;
  task_id: string | null;
  fix: string | null;
  title: string | null;
  summary: string | null;
  reason: string | null;
  pr_number: number | null;
  ticket_ref: string | null;
  created_at: string;
  settled_at: string | null;
}
