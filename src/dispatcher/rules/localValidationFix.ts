import { localValidationFixBriefing } from '../../localValidation/briefing.js';
import { localValidationFixOrigin } from '../../localValidation/origin.js';
import { issueWatchGateReason } from '../issuePickup.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Put an agent on what a local validation found.
 *
 * **This is the half that makes the reading worth taking.** A `failed` validation
 * is somebody's account of the delivered thing not working, and until this rule
 * existed it was a note on a page: the same dead end a `failed` validation check was
 * before `validation-failed`, arriving by a different route. Every other negative
 * verdict in the harness has a consumer, and so does this one.
 *
 * **It is not a shortfall, and must never become one.** `VERDICT_EXCLUSIONS` has a
 * shortfall clear the goal's delivery, and the delivery is what parks it — so
 * recording a failed validation that way would un-park the goal, settle its
 * close-out and hand delivered work back to the fleet, all on the strength of an
 * exploratory run against a branch. The two answer different questions: a shortfall
 * says the work is not finished, and this says the work in front of somebody did not
 * behave. → [20](../../../docs/spec/20-validation.md#when-a-check-fails)
 *
 * **Writable, on the branch that was validated**, which is the one thing here that
 * differs from every other rule this feature has. The validator reads and the fixer
 * writes, and what it writes belongs on the branch whose behaviour was wrong. The
 * executor's branch gate defers it while a part agent holds that branch — two agents
 * on one branch is exactly what that gate exists for, and a fix that waits a pulse
 * for the part to finish is the right outcome rather than a missed one.
 */
export function localValidationFix(s: StageContext): void {
  for (const row of s.localValidations) {
    // The store's own query already narrows to this, and asking again here is the
    // rule stating its own gate rather than trusting a caller's filter — the two
    // readers of that table want different halves of it.
    if (row.status !== 'failed' || row.fixTaskId !== null || row.findings.length === 0) continue;

    // A validation that ran from the integration branch has nowhere to put a fix:
    // the goal never cut a branch, so the only writable target would be the branch
    // everything merges into. Nothing is dispatched, and the findings stand on the
    // page for a person to act on.
    if (row.ref === s.defaultBranch) continue;

    const parts = /^issue:(\d+)$/.exec(row.originRef);
    if (parts === null) continue;
    const issueNumber = Number(parts[1]);
    const issue = s.liveIssue(issueNumber);
    if (issue === null) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;

    const origin = localValidationFixOrigin(issueNumber, row.id);
    if (s.activeOrigins.has(origin)) continue;

    const blockers = row.findings.filter((finding) => finding.severity === 'blocker').length;
    const title = `Fix what validating #${String(issueNumber)} locally found`;
    const reason =
      `Validating #${String(issueNumber)} against the local environment failed with ` +
      `${String(row.findings.length)} finding${row.findings.length === 1 ? '' : 's'}` +
      `${blockers > 0 ? ` (${String(blockers)} of them blocking)` : ''} on ${row.ref}.`;

    s.candidates.push({
      origin,
      rule: 'local-validation-fix',
      title,
      kind: 'code',
      branch: row.ref,
      reason,
      action: {
        type: 'dispatch_code_agent',
        branch: row.ref,
        // The branch exists — a validation ran against a checkout of it — so this is
        // only ever consulted if it has since been reaped, and the default branch is
        // the honest answer then.
        base: s.defaultBranch,
        title,
        // Appended for the prompt book's reason: the findings are the whole of what
        // this agent was sent to act on, and an override that predated them would
        // dispatch an agent with nothing to fix.
        prompt:
          s.templates.render('local-validation-fix', { number: issueNumber, title: issue.title }) +
          localValidationFixBriefing(row, s.liveLocalRun),
        localValidation: { id: row.id, as: 'fix' },
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'local-validation-fix',
        reason,
      } satisfies RawAction,
    });
  }
}
