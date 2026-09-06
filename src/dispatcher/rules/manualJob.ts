import { jobBranch } from '../../jobs.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `manual-job`)

export function manualJob(s: StageContext): void {
  for (const job of s.ctx.queuedJobs) {
    const origin = `job:${job.id}`;
    if (s.activeOrigins.has(origin)) continue;
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
