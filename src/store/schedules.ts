import { nanoid } from 'nanoid';
import type { JobSchedule } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

export const JOB_SCHEDULE_COLUMNS: ColumnMigrations = {
  job_schedules: {},
};

export class JobScheduleStore {
  constructor(private readonly ctx: StoreContext) {}

  createJobSchedule(input: {
    title: string;
    prompt: string;
    kind: JobSchedule['kind'];
    cron: string;
    nextRunAt: string | null;
  }): JobSchedule {
    const ts = this.ctx.now();
    const schedule: JobSchedule = {
      id: `sch_${nanoid(10)}`,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      cron: input.cron,
      enabled: true,
      nextRunAt: input.nextRunAt,
      lastFiredAt: null,
      lastJobId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO job_schedules (id, title, prompt, kind, cron, enabled, next_run_at, last_fired_at, last_job_id, created_at, updated_at)
         VALUES (@id, @title, @prompt, @kind, @cron, 1, @nextRunAt, NULL, NULL, @createdAt, @updatedAt)`,
      )
      .run(schedule);
    return schedule;
  }

  getJobSchedule(id: string): JobSchedule | null {
    const row = this.ctx.db.prepare(`SELECT * FROM job_schedules WHERE id=?`).get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  listJobSchedules(): JobSchedule[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM job_schedules ORDER BY created_at ASC`).all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  updateJobSchedule(
    id: string,
    patch: Partial<Pick<JobSchedule, 'title' | 'prompt' | 'kind' | 'cron' | 'enabled' | 'nextRunAt'>>,
  ): JobSchedule | null {
    const existing = this.getJobSchedule(id);
    if (!existing) return null;
    const next: JobSchedule = { ...existing, ...patch, updatedAt: this.ctx.now() };
    this.ctx.db
      .prepare(
        `UPDATE job_schedules SET title=@title, prompt=@prompt, kind=@kind, cron=@cron,
           enabled=@enabledInt, next_run_at=@nextRunAt, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({ ...next, enabledInt: next.enabled ? 1 : 0 });
    return next;
  }

  recordJobScheduleRun(id: string, run: { firedAt: string; jobId: string; nextRunAt: string | null }): void {
    this.ctx.db
      .prepare(
        `UPDATE job_schedules SET last_fired_at=@firedAt, last_job_id=@jobId, next_run_at=@nextRunAt, updated_at=@firedAt
         WHERE id=@id`,
      )
      .run({ ...run, id });
  }

  deleteJobSchedule(id: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM job_schedules WHERE id=?`).run(id).changes > 0;
  }
}

interface ScheduleRow {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  cron: string;
  enabled: number;
  next_run_at: string | null;
  last_fired_at: string | null;
  last_job_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSchedule(r: ScheduleRow): JobSchedule {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    kind: r.kind as JobSchedule['kind'],
    cron: r.cron,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastFiredAt: r.last_fired_at,
    lastJobId: r.last_job_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
