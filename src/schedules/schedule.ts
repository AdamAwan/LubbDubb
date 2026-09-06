import type { Job, JobSchedule, Task } from '../types.js';
import { isActiveTask } from '../tasks.js';
import { nextCronRun } from './cron.js';

// → docs/spec/08-planning.md

export function nextRunAfter(cron: string, after: Date): string | null {
  return nextCronRun(cron, after)?.toISOString() ?? null;
}

interface ScheduleFiring {
  schedule: JobSchedule;
  heldFor: string | null;
  firedAt: string;
  nextRunAt: string | null;
}

export function schedulePass(input: {
  schedules: readonly JobSchedule[];
  now: Date;
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

export function scheduleJobRequest(schedule: JobSchedule): Pick<JobSchedule, 'title' | 'prompt' | 'kind'> {
  return { title: schedule.title, prompt: schedule.prompt, kind: schedule.kind };
}

export function jobStillGoing(job: Job | null, task: Task | null): boolean {
  if (!job || job.status === 'cancelled') return false;
  if (job.status === 'queued') return true;
  return task !== null && isActiveTask(task);
}
