import { nanoid } from 'nanoid';
import type { HumanTask, HumanTaskInput, HumanTaskKind, HumanTaskStatus } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `human_tasks` was a fresh `CREATE TABLE`, and `kind` is the column that proved
 * the entry was worth declaring empty: every row written before it existed is an
 * `ask`, and the default is what says so on a database that predates the sweep.
 *
 * `dismissed_at` is nullable with no default, and null is already the right
 * answer for every row from before it existed: nobody had cleared anything off
 * the bench, because there was no way to.
 */
export const HUMAN_TASK_COLUMNS: ColumnMigrations = {
  human_tasks: { kind: `TEXT NOT NULL DEFAULT 'ask'`, dismissed_at: `TEXT` },
};

/**
 * The `human_tasks` table: work only a person can do.
 *
 * The dispatcher does not read this table, and that is the whole of the access
 * story. A human task holds work off the fleet only by *being* a plan part
 * (`part_id`), and a part is a node the reconciler and rule `plan-part` already
 * understand — so an agent that asks for one gains the ability to ask a person,
 * never the ability to stop the fleet.
 */
export class HumanTaskStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File a human task. `agentId`/`taskId`/`originRef` are the caller's own,
   * resolved from its credential by the tool layer, or all null when an operator
   * filed it from the cockpit.
   *
   * A repeat (same agent, same origin, same title) refreshes the existing row
   * rather than inserting, exactly as `proposeFact` matches a claim and for its reason: an
   * agent that asks for the same thing on every turn must not fill the operator's
   * list. The status is deliberately *not* reset — a declined task asked for
   * again stays declined, which is what declining it meant — and neither is
   * `dismissed_at`, for the same reason: an answered row does not come back onto
   * the bench because the asker repeated itself.
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
    // `IS` rather than `=` so a null matches a null (SQL equality doesn't). `kind`
    // is in the key so an operator who types the sweep's own sentence at it
    // refreshes their own row rather than the harness's.
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
   * whole view of what a person owes the fleet, and of what they used to.
   *
   * Deliberately unbounded where {@link listHumanTasks} takes a limit, and the
   * difference is the point: that one feeds a panel, where a cap hides the tail
   * of a long list, and this one feeds a *count* and a *median*, where a cap
   * would silently report a hundred when the answer is two hundred — on
   * precisely the deployments furthest behind.
   *
   * **Settled rows are in it, and that is not laxity.** The debt count reads the
   * open ones; the lead time reads the closed ones, because a hold that has
   * ended is exactly the span the median must not have counted as work
   * (`docs/spec/25-supply.md#the-lead-time-is-fleet-time`). One read rather than
   * an open list beside a closed one, on {@link RunwayInput}'s rule: two lists of
   * one table, either a subset of the other, is a caller free to pair a debt with
   * somebody else's history.
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
   * Every one of them, not only the open ones: `declined` is precisely the state
   * the reconciler has to see, and filtering here would hand it silence for a
   * refusal.
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
   * Every status, for {@link listHumanTasksForParts}' reason, and here it is both
   * directions at once: a **settled** row is what stops the sweep filing the same
   * obligation a second time, and an **open** one whose delivery has since been
   * cleared is what it has to retract. Unbounded in age, as `listDeliveries` is
   * and for its reason — one row per goal ever delivered, and a count bound would
   * hide the oldest standing obligation rather than the least important one.
   *
   * Reading the rows back is also why the sweep does not simply call
   * `recordHumanTask` each pulse and lean on its dedup: that refreshes
   * `updated_at`, and the panel it feeds is newest-first.
   */
  listHumanTasksOfKind(kind: HumanTaskKind): HumanTask[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM human_tasks WHERE kind=?`).all(kind) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * Settle a human task: the person did it, or refused it.
   *
   * Compare-and-set in the write (`WHERE id=? AND status='open'`), the same
   * discipline as `decideProposal` and `linkFindingTicket`: a second click settles
   * nothing and cannot overwrite the first verdict with the second. Returns null
   * when there was no open task to settle, which the route turns into a 409.
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
   * Clear a settled task off the bench: the operator has read the record and is
   * done with it.
   *
   * **Only a settled row**, which is the guard that makes this safe rather than a
   * second way to make work disappear — an open obligation has two answers, and
   * neither of them is "hide it". Compare-and-set on both halves
   * (`status<>'open' AND dismissed_at IS NULL`), {@link settleHumanTask}'s
   * discipline, so a second click dismisses nothing and cannot restamp the time.
   * Returns null when there was no undismissed settled task, which the route
   * turns into a 409.
   *
   * The row is updated, never deleted. The close-out sweep recognises its own
   * settled row by finding it again, and a delete would have it file the same
   * obligation on the next pulse — the same reason a dismissed finding stays in
   * the list.
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
