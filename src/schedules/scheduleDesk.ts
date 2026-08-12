import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { jobStillGoing, schedulePass, scheduleJobRequest } from './schedule.js';

/**
 * Where a recurrence becomes a queued job, once a pulse.
 *
 * The desk half of {@link schedulePass}, and thin for {@link DeliveryCloseOutDesk}'s
 * reason: every decision is in the pure function and this is the store round trip
 * around it. It writes `jobs` and `job_schedules` rows and decides no dispatch —
 * what happens to the job it queues is rule `manual-job`'s business, exactly as
 * it is for one the operator launched by hand.
 *
 * **A failing schedule fails only itself.** Each firing is recorded through
 * `errors.record` and the loop carries on, because the alternative is one bad row
 * taking the whole pulse — and the pulse is what would have fixed it, since the
 * operator's edit only takes effect on the next one.
 */
export class ScheduleDesk {
  constructor(private readonly deps: { store: Store; errors: ErrorRecorder }) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(now: Date = new Date()): void {
    const { store, errors } = this.deps;
    const schedules = store.listJobSchedules();
    // A deployment with no schedules reads nothing further, which is every
    // deployment until an operator writes one — and this runs on every pulse.
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
          // Rolled forward without firing: the next slot, and no record of a run
          // that did not happen.
          store.updateJobSchedule(schedule.id, { nextRunAt: firing.nextRunAt });
          continue;
        }
        const job = store.createJob(scheduleJobRequest(schedule));
        // The job first, then the record of it: a failed create leaves the
        // schedule due, so the next pulse retries rather than skipping a night.
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
