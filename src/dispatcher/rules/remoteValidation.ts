import { readOnlyDispatch } from './readOnlyDispatch.js';
import { issueWatchGateReason } from '../issuePickup.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/36-remote-validation.md#the-dispatch--rule-remote-validation

/**
 * One code agent on one open run row. Everything it needs is a run row and a rendered string, both
 * already on the `StageContext`: nothing here imports `src/remoteValidation/` or `src/environments/`,
 * which is asserted structurally.
 *
 * No cooldown budget and no escalation. A run row is one press rather than a standing signal: it is
 * re-proposed each pulse until it dispatches, the operator calls it off, or the pin goes bad. One
 * agent per run is the store's `WHERE status = 'pending'` on the dispatched flip, which is what makes
 * it true across a restart rather than only within one.
 */
export function remoteValidation(s: StageContext): void {
  for (const run of s.remoteRuns) {
    if (run.status !== 'pending') continue;
    if (run.confirmed === 0) continue;
    const issue = s.liveIssue(run.issueNumber);
    if (issue === null) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (s.activeOrigins.has(run.origin)) continue;

    const title = `Run #${String(run.issueNumber)}'s validation sheet on ${run.environment}`;
    const reason =
      `An operator pressed go on issue #${String(run.issueNumber)}'s validation sheet for ${run.environment}, ` +
      `and ${run.confirmed === 1 ? 'one row is' : `${String(run.confirmed)} rows are`} confirmed for the browser suite.`;
    s.candidates.push({
      origin: run.origin,
      rule: 'remote-validation',
      title,
      kind: 'code',
      branch: run.leaseKey,
      reason,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(run.leaseKey, run.deployedSha),
        title,
        prompt:
          s.templates.render('remote-validation', {
            number: run.issueNumber,
            title: issue.title,
            environment: run.environment,
          }) + run.briefing,
        remoteRun: { id: run.runId },
        originRef: run.origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'remote-validation',
        reason,
      } satisfies RawAction,
    });
  }
}
