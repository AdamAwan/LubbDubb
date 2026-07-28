import type { Job } from './types.js';

/**
 * The branch an operator-launched job's work lands on.
 *
 * Rule 0 needs it to dispatch, and the work graph's fold needs it to recognise
 * the PR that job produced. Those two answering differently is the bug class this
 * repo has paid for twice (`proposalWorldRef`'s match-and-ask, the jobs 409/defer
 * pair), so it is one predicate with two callers rather than one expression
 * copied.
 *
 * Null for a desk job, which runs in a scratch directory and has no branch at
 * all — the same discriminator rule 0 already applies when it chooses between a
 * code and a desk dispatch.
 *
 * Note this is the one dispatch path where origin and branch are **not** 1:1:
 * `job.branch` is a free string the operator supplies. The derived `job/<id>`
 * fallback is, which is what makes the fold's branch match exact for every job
 * the operator did not name a branch for.
 */
export function jobBranch(job: Job): string | null {
  return job.kind === 'code' ? (job.branch ?? `job/${job.id}`) : null;
}
