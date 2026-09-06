import { nanoid } from 'nanoid';
import type { HumanTask, HumanTaskInput, HumanTaskKind, HumanTaskStatus } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * Additive columns for `human_tasks`. Every pre-existing row is an `ask`, hence
 * the default; null `dismissed_at` already means "not cleared off the bench".
 */
export const HUMAN_TASK_COLUMNS: ColumnMigrations = {
  human_tasks: { kind: `TEXT NOT NULL DEFAULT 'ask'`, dismissed_at: `TEXT` },
};

/**
 * The `human_tasks` table: work only a person can do.
 *
 * The dispatcher never reads this table; a human task holds work off the fleet
 * only by *being* a plan part (`part_id`).
 */
export class HumanTaskStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File a human task. `agentId`/`taskId`/`originRef` are the caller's own,
   * resolved from its credential by the tool layer, or all null when an operator
   * filed it from the cockpit.
   *
   * A repeat (same agent, origin, title, kind) refreshes the existing row rather
   * than inserting. Status and `dismissed_at` are deliberately never reset: an
   * agent repeating itself must not resurrect a declined or dismissed task.
   */
  recordHumanTask(
    input: HumanTaskInput & {
      agentId: string | null;
      taskId: string | null;
      originRef: string | null;
      partId?: string | null;
      kind?: HumanTaskKind;
    },
  ): { task: HumanTask; created: boolean } {
    const ts = this.ctx.now();
    const kind: HumanTaskKind = input.kind ?? 'ask';
    // `IS` so a null matches a null; `kind` is in the key so an operator typing
    // the sweep's own sentence refreshes their own row, not the harness's.
    const existing = this.ctx.db
      .prepare(`SELECT * FROM human_tasks WHERE agent_id IS ? AND origin_ref IS ? AND title=? AND kind=?`)
      .get(input.agentId, input.originRef, input.title, kind) as HumanTaskRow | undefined;
    if (existing) {
      this.ctx.db
        .prepare(`UPDATE human_tasks SET detail=?, updated_at=? WHERE id=?`)
        .run(input.detail, ts, existing.id);
      return { task: { ...rowToHumanTask(existing), detail: input.detail, updatedAt: ts }, created: false };
    }
    const task: HumanTask = {
      id: `hum_${nanoid(10)}`,
      title: input.title,
      detail: input.detail,
      originRef: input.originRef,
      partId: input.partId ?? null,
      kind,
      agentId: input.agentId,
      taskId: input.taskId,
      status: 'open',
      resolution: null,
      createdAt: ts,
      updatedAt: ts,
      resolvedAt: null,
      dismissedAt: null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO human_tasks (id, title, detail, origin_ref, part_id, kind, agent_id, task_id, status, resolution, created_at, updated_at, resolved_at, dismissed_at)
         VALUES (@id, @title, @detail, @originRef, @partId, @kind, @agentId, @taskId, @status, @resolution, @createdAt, @updatedAt, @resolvedAt, @dismissedAt)`,
      )
      .run(task);
    return { task, created: true };
  }

  getHumanTask(id: string): HumanTask | null {
    const row = this.ctx.db.prepare(`SELECT * FROM human_tasks WHERE id=?`).get(id) as HumanTaskRow | undefined;
    return row ? rowToHumanTask(row) : null;
  }

  /**
   * The title of each of these asks, by id — the pets panel's label for a
   * `human-task` origin. By id rather than off {@link listHumanTasks}, whose cap
   * would leave exactly the oldest pets unnamed. A missing id is absent from the
   * map, never an error. → `docs/spec/22-pets.md#the-sources`
   */
  humanTaskLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, title FROM human_tasks WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      title: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  /** Every human task, newest first — the snapshot feed, open ones and a settled tail alike. */
  listHumanTasks(limit = 100): HumanTask[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * Every obligation the bench has ever held, oldest first — the runway lens's
   * view of what a person owes the fleet and what they used to.
   *
   * Deliberately unbounded: it feeds a count and a median, which a cap would
   * silently understate. Settled rows are included — the debt count reads the
   * open ones, the lead time the closed ones.
   * → `docs/spec/25-supply.md#the-lead-time-is-fleet-time`
   */
  listAllHumanTasks(): HumanTask[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks ORDER BY created_at ASC, rowid ASC`)
      .all() as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * The human tasks backing plan parts — what the reconciler reads to decide
   * whether a part a person owns is still waiting or has been refused.
   *
   * Every status, not only the open ones: `declined` is what the reconciler has
   * to see, and filtering here would hand it silence for a refusal.
   */
  listHumanTasksForParts(partIds: string[]): HumanTask[] {
    if (partIds.length === 0) return [];
    const holes = partIds.map(() => '?').join(',');
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks WHERE part_id IN (${holes})`)
      .all(...partIds) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * Every task of one kind — what the close-out sweep reads to find the rows it
   * filed on earlier pulses.
   *
   * Every status and unbounded in age: a settled row is what stops the sweep
   * filing the same obligation twice, and an open one whose delivery has since
   * been cleared is what it has to retract.
   */
  listHumanTasksOfKind(kind: HumanTaskKind): HumanTask[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM human_tasks WHERE kind=?`).all(kind) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * Settle a human task: the person did it, or refused it.
   *
   * Compare-and-set on `status='open'` so a second click cannot overwrite the
   * first verdict. Returns null when there was no open task, which the route
   * turns into a 409.
   */
  settleHumanTask(id: string, status: Exclude<HumanTaskStatus, 'open'>, resolution: string | null): HumanTask | null {
    const ts = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE human_tasks SET status=?, resolution=?, updated_at=?, resolved_at=? WHERE id=? AND status='open'`,
      )
      .run(status, resolution, ts, ts, id);
    if (result.changes === 0) return null;
    return this.getHumanTask(id);
  }

  /**
   * Put a settled row back on the bench, under its own title, with fresh detail —
   * an obligation that is owed **again**. The one caller is `RunwayDesk`,
   * reopening a row it settled itself; {@link recordHumanTask} must not learn to
   * do this, since its dedup ignores status on purpose.
   *
   * Only a settled row (compare-and-set), and `dismissed_at` is cleared with the
   * status — leaving it dismissed would hide an obligation genuinely owed again.
   * `created_at` moves too, so the reopened row does not fall off the end of
   * {@link listHumanTasks}' newest-first cap; that is the deliberate opposite of
   * a {@link recordHumanTask} refresh, which must not jump the feed. Returns null
   * when there was nothing to reopen.
   */
  reopenHumanTask(id: string, detail: string): HumanTask | null {
    const ts = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE human_tasks SET status='open', resolution=NULL, resolved_at=NULL, dismissed_at=NULL,
           detail=?, created_at=?, updated_at=? WHERE id=? AND status<>'open'`,
      )
      .run(detail, ts, ts, id);
    if (result.changes === 0) return null;
    return this.getHumanTask(id);
  }

  /**
   * Clear a settled task off the bench: the operator has read the record and is
   * done with it.
   *
   * Only a settled, undismissed row (compare-and-set on both halves), so an open
   * obligation can never be hidden and a second click cannot restamp the time;
   * returns null otherwise, which the route turns into a 409. The row is updated,
   * never deleted — the close-out sweep recognises its own settled row by finding
   * it again, and a delete would have it re-file on the next pulse.
   */
  dismissHumanTask(id: string): HumanTask | null {
    const ts = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE human_tasks SET dismissed_at=?, updated_at=? WHERE id=? AND status<>'open' AND dismissed_at IS NULL`,
      )
      .run(ts, ts, id);
    if (result.changes === 0) return null;
    return this.getHumanTask(id);
  }
}

interface HumanTaskRow {
  id: string;
  title: string;
  detail: string | null;
  origin_ref: string | null;
  part_id: string | null;
  kind: string;
  agent_id: string | null;
  task_id: string | null;
  status: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  dismissed_at: string | null;
}

function rowToHumanTask(r: HumanTaskRow): HumanTask {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail,
    originRef: r.origin_ref,
    partId: r.part_id,
    kind: r.kind as HumanTaskKind,
    agentId: r.agent_id,
    taskId: r.task_id,
    status: r.status as HumanTaskStatus,
    resolution: r.resolution,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    dismissedAt: r.dismissed_at,
  };
}
