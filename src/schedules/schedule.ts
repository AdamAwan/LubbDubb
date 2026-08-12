import type { Job, JobSchedule, Task } from '../types.js';
import { isActiveTask } from '../tasks.js';
import { nextCronRun } from './cron.js';

/**
 * What a pulse does with the operator's recurrences, as a pure fold — the desk
 * around it ({@link ScheduleDesk}) is the store round trip and nothing else, the
 * shape {@link DeliveryCloseOutDesk} already has.
 */

/** When the next firing of `cron` is due, as an ISO string, or null when it is never due again. */
export function nextRunAfter(cron: string, after: Date): string | null {
  return nextCronRun(cron, after)?.toISOString() ?? null;
}

/** One schedule's verdict for this pulse. */
interface ScheduleFiring {
  schedule: JobSchedule;
  /**
   * Null when the schedule fires; otherwise the reason it was rolled forward to
   * its next slot without firing. The one such reason today is that its previous
   * job is still in flight.
   */
  heldFor: string | null;
  /** The moment the pass judged it due — what `lastFiredAt` records. */
  firedAt: string;
  /** Where the recurrence goes next, computed from `now` rather than from the slot it just used. */
  nextRunAt: string | null;
}

/**
 * Which schedules have come due, and what happens to each.
 *
 * Three properties, all of them about a harness that was not running when a slot
 * came round — which is the normal case for a laptop, not an edge case:
 *
 * - **A missed window fires once, not once per slot.** A schedule due nightly on a
 *   machine that was off for a week is one job on the next pulse, and the next
 *   `nextRunAt` is computed from **now**. Firing seven agents at 09:03 on Monday
 *   for the seven mornings nobody was there is a bill, not a catch-up.
 * - **A schedule never has two of its own jobs in flight.** A nightly job that
 *   takes longer than a day is rolled forward instead of stacking a second agent
 *   on the work the first is still doing. Rolled forward rather than deferred, so
 *   the missed one does not fire the instant the long one lands — a 3am job
 *   arriving at 11am because last night's overran is a surprise, and the cadence
 *   the operator asked for is the one they get.
 * - **At most one firing per schedule per pulse**, which falls out of taking the
 *   next slot after `now` rather than draining every slot before it.
 */
export function schedulePass(input: {
  schedules: readonly JobSchedule[];
  now: Date;
  /** Whether this schedule's previous job is still queued or still being worked. */
  inFlight: (schedule: JobSchedule) => boolean;
}): ScheduleFiring[] {
  const firedAt = input.now.toISOString();
  const out: ScheduleFiring[] = [];
  for (const schedule of input.schedules) {
    if (!schedule.enabled || schedule.nextRunAt === null) continue;
    if (schedule.nextRunAt > firedAt) continue;
    out.push({
      schedule,
      heldFor: input.inFlight(schedule) ? 'its previous job is still in flight' : null,
      firedAt,
      nextRunAt: nextRunAfter(schedule.cron, input.now),
    });
  }
  return out;
}

/**
 * The job a firing creates: the schedule's own text, **verbatim**.
 *
 * Nothing is interpolated into the prompt — not the schedule's name, not the
 * time, not "this is a scheduled run". An operator's prompt is the one string in
 * this system that is theirs, and a harness sentence prepended to it is a
 * sentence they did not write being read by an agent they cannot see. What
 * connects the two is recorded instead: the schedule keeps the job id it created
 * and the job's own `job:<id>` origin is what everything downstream is keyed on.
 *
 * The branch is deliberately absent, so every firing gets the derived `job/<id>`
 * of its own job (see {@link jobBranch}). A fixed branch on a recurrence is a
 * worktree two firings would share the moment one runs long.
 */
export function scheduleJobRequest(schedule: JobSchedule): Pick<JobSchedule, 'title' | 'prompt' | 'kind'> {
  return { title: schedule.title, prompt: schedule.prompt, kind: schedule.kind };
}

/**
 * Whether the job a schedule last created is still going on — the predicate
 * {@link schedulePass} holds a firing for.
 *
 * `dispatched` is terminal for a job, so the task it became is the only thing
 * that says whether the work is still running; that is `listStandingJobs`'
 * reasoning, asked here of one job rather than in SQL of all of them, because a
 * schedule knows exactly which job it is asking about.
 */
export function jobStillGoing(job: Job | null, task: Task | null): boolean {
  if (!job || job.status === 'cancelled') return false;
  if (job.status === 'queued') return true;
  return task !== null && isActiveTask(task);
}
