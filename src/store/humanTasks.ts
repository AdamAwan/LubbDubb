import { nanoid } from 'nanoid';
import type { HumanTask, HumanTaskInput, HumanTaskKind, HumanTaskStatus } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const HUMAN_TASK_COLUMNS: ColumnMigrations = {
  human_tasks: { kind: `TEXT NOT NULL DEFAULT 'ask'`, dismissed_at: `TEXT` },
};

export class HumanTaskStore {
  constructor(private readonly ctx: StoreContext) {}

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

  humanTaskLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, title FROM human_tasks WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      title: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  listHumanTasks(limit = 100): HumanTask[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  listAllHumanTasks(): HumanTask[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks ORDER BY created_at ASC, rowid ASC`)
      .all() as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  listHumanTasksForParts(partIds: string[]): HumanTask[] {
    if (partIds.length === 0) return [];
    const holes = partIds.map(() => '?').join(',');
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks WHERE part_id IN (${holes})`)
      .all(...partIds) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  listHumanTasksOfKind(kind: HumanTaskKind): HumanTask[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM human_tasks WHERE kind=?`).all(kind) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

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
