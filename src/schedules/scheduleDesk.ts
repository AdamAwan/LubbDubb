import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { jobStillGoing, schedulePass, scheduleJobRequest } from './schedule.js';

// → docs/spec/08-planning.md

export class ScheduleDesk {
  constructor(private readonly deps: { store: Store; errors: ErrorRecorder }) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(now: Date = new Date()): void {
    const { store, errors } = this.deps;
    const schedules = store.listJobSchedules();
    if (schedules.length === 0) return;
    for (const firing of schedulePass({
      schedules,
      now,
      inFlight: (schedule) => {
        const job = schedule.lastJobId ? store.getJob(schedule.lastJobId) : null;
        return jobStillGoing(job, job?.taskId ? store.getTask(job.taskId) : null);
      },
    })) {
      const { schedule } = firing;
      try {
        if (firing.heldFor !== null) {
          store.updateJobSchedule(schedule.id, { nextRunAt: firing.nextRunAt });
          continue;
        }
        const job = store.createJob(scheduleJobRequest(schedule));
        store.recordJobScheduleRun(schedule.id, {
          firedAt: firing.firedAt,
          jobId: job.id,
          nextRunAt: firing.nextRunAt,
        });
      } catch (err) {
        errors.record({
          source: 'cycle',
          message: `Schedule ${schedule.title} (${schedule.cron}) failed to fire: ${(err as Error).message}`,
          detail: (err as Error).stack ?? null,
        });
      }
    }
  }
}
