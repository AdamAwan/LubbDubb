import { nanoid } from 'nanoid';
import type { JobSchedule } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

/**
 * `job_schedules` was a fresh `CREATE TABLE`, and this is declared empty anyway:
 * a table being new **once** does not keep it exempt, and the entry is where the
 * next column added to it has to be named. → `docs/spec/14-persistence.md`
 */
export const JOB_SCHEDULE_COLUMNS: ColumnMigrations = {
  job_schedules: {},
};

/**
 * The `job_schedules` table: recurring briefs, and how far through each
 * recurrence the harness has got.
 *
 * The store holds **when**, never **whether** — no query here asks the clock.
 * `next_run_at` is written by whoever computed it (the route on a create or an
 * edit, the desk on a firing) and read back as a plain string, so the one place
 * that knows what a cron expression means is `src/schedules/cron.ts` and this
 * table cannot form a second opinion about it.
 */
export class JobScheduleStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Record a new recurrence. Enabled on creation — an operator who wrote one means it to run. */
  createJobSchedule(input: {
    title: string;
    prompt: string;
    kind: JobSchedule['kind'];
    cron: string;
    /** When the first firing is due, computed by the caller from the same expression. */
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

  /**
   * Every schedule, oldest first — the order the cockpit draws them in and the
   * order the desk considers them. All of them, enabled or not: a disabled
   * schedule is a standing intent the operator can see and switch back on, and
   * the pass skips it by reading `enabled` rather than by never being handed it.
   */
  listJobSchedules(): JobSchedule[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM job_schedules ORDER BY created_at ASC`).all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * Change what a schedule says or where it is next due. Every field is optional
   * and an absent one is left alone — including `nextRunAt`, which the desk sets
   * on its own when it rolls a held schedule forward.
   *
   * It deliberately cannot write `lastFiredAt` / `lastJobId`:
   * {@link recordJobScheduleRun} is the one writer of those, so a firing is
   * recorded as one thing rather than as an edit that happens to mention it.
   */
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

  /**
   * Record that a schedule fired: when, what it created, and where the recurrence
   * goes next. One write for all three because they are one event — a row that
   * said it fired but not what it produced is exactly the row the next pulse's
   * in-flight check cannot use.
   */
  recordJobScheduleRun(id: string, run: { firedAt: string; jobId: string; nextRunAt: string | null }): void {
    this.ctx.db
      .prepare(
        `UPDATE job_schedules SET last_fired_at=@firedAt, last_job_id=@jobId, next_run_at=@nextRunAt, updated_at=@firedAt
         WHERE id=@id`,
      )
      .run({ ...run, id });
  }

  /**
   * Forget a recurrence. Deleted rather than tombstoned, unlike a dismissed
   * finding or a settled human task: those carry somebody's judgement about a
   * piece of work, and this carries an intention that has ended. Its history is
   * not lost with it either — every job it ever queued is still in `jobs`, with
   * the decisions and agents that came of them.
   */
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
