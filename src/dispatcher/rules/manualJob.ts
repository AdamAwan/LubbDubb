import { jobBranch } from '../../jobs.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Operator-launched jobs outrank every world-driven rule, which is what their
 * first position in the pipeline says. Queued oldest-first so the headroom cut
 * dispatches them ahead of every world-driven candidate — a manual request wins
 * the next free slot; one that doesn't fit stays in the queue as `waiting` and is
 * retried next cycle. No cooldown throttle applies (a job is a one-shot request,
 * not a persistent signal): once dispatched it's marked so and leaves the queue.
 * The `jobId` rides on the action so the executor marks the job dispatched only
 * once its agent actually spawns.
 */
export function manualJob(s: StageContext): void {
  for (const job of s.ctx.queuedJobs) {
    const origin = `job:${job.id}`;
    if (s.activeOrigins.has(origin)) continue;
    // Shared with the work graph's fold, which recognises this job's PR by it.
    const branch = jobBranch(job);
    const reason = `Operator-launched job "${job.title}" takes priority for the next free slot.`;
    const action: RawAction =
      job.kind === 'code'
        ? {
            type: 'dispatch_code_agent',
            branch: branch!,
            title: job.title,
            prompt: job.prompt,
            originRef: origin,
            originTitle: job.title,
            originSummary: 'Operator-launched job.',
            jobId: job.id,
            rule: 'manual-job',
            reason,
          }
        : {
            type: 'dispatch_desk_agent',
            title: job.title,
            prompt: job.prompt,
            originRef: origin,
            originTitle: job.title,
            originSummary: 'Operator-launched job.',
            jobId: job.id,
            rule: 'manual-job',
            reason,
          };
    s.candidates.push({ origin, rule: 'manual-job', title: job.title, kind: job.kind, branch, reason, action });
  }
}
