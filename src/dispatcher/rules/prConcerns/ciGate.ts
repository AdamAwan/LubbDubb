import type { PullRequest } from '../../../types.js';
import { ciWatchNote, classifyWatchedChecks, type CiWatchVerdict } from '../../../ci/ciPolicy.js';
import type { RawAction, StageContext } from '../context.js';
import { directActUnperformed, type PrConcern } from './concern.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function ciGateConcern(pr: PullRequest, s: StageContext, inherited: boolean): PrConcern | null {
  const gateVerdict = classifyWatchedChecks(pr.ciChecks, s.ci);
  if (gateVerdict.watched.length === 0 || inherited) return null;
  const waiting = gateVerdict.watched.map((m) => m.name).join(', ');
  const gateOrigin = `pr:${pr.number}:ci-gate`;
  const requeues = gateRequeues(gateVerdict);
  const direct = requeues !== null && !directActUnperformed('requeue_ci_check', gateOrigin, s.ctx.recentDecisions);
  return {
    rule: 'pr-ci-gate',
    act:
      direct && requeues
        ? ({
            type: 'requeue_ci_check',
            prNumber: pr.number,
            checks: requeues,
            originRef: gateOrigin,
            rule: 'pr-ci-gate',
            reason: `The build policy on PR #${pr.number} is expired (${waiting}); queueing a run through the provider rather than spending an agent on it.`,
          } satisfies RawAction)
        : undefined,
    origin: gateOrigin,
    title: `Clear the waiting check on PR #${pr.number}`,
    prompt:
      s.templates.render('pr-ci-gate', { number: pr.number, title: pr.title, branch: pr.branch }) +
      ciWatchNote(gateVerdict),
    dispatchReason: gateDispatchReason(pr.number, gateVerdict),
    note: `A check on PR #${pr.number} is waiting on an action — ${waiting}.${ciWatchNote(gateVerdict)}`,
    originTitle: pr.title,
    originSummary: `PR #${pr.number} on branch ${pr.branch} · waiting on ${waiting}`,
    urgent: gateVerdict.urgent,
    ciChecks: gateVerdict.watched.map((m) => m.name),
  };
}

function gateRequeues(verdict: CiWatchVerdict): Array<{ name: string; requeueRef: string }> | null {
  const requeues: Array<{ name: string; requeueRef: string }> = [];
  for (const m of verdict.watched) {
    if (!m.expired || m.rule?.guidance?.trim() || !m.requeueRef) return null;
    requeues.push({ name: m.name, requeueRef: m.requeueRef });
  }
  return requeues.length > 0 ? requeues : null;
}

function gateDispatchReason(prNumber: number, verdict: CiWatchVerdict): string {
  const names = verdict.watched.map((m) => m.name).join(', ');
  return `PR #${prNumber} has a check waiting on an action (${names}) and no agent is on it.`;
}
