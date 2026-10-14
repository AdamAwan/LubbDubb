import { hasWorkStarted } from '../../intake/appraisal.js';
import { investigateBranch, investigateOrigin, investigationHold } from '../../intake/investigation.js';
import { issueOrigin } from '../../plans/planning.js';
import { relatedWorkNote } from '../../issueRelations.js';
import { sequenceHoldReason } from '../../sequence/readiness.js';
import { readOnlyDispatch, readOnlyNote } from './readOnlyDispatch.js';
import { supersededReason } from '../admission.js';
import type { Issue } from '../../types.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-investigate`)

export function issueInvestigate(s: StageContext): void {
  const { ctx } = s;
  for (const { issue } of s.eligibleIssues) {
    if (!s.investigateLabelled(issue)) continue;
    if (s.appraising.has(issue.number)) continue;
    if (s.investigationFor(issue) !== null) continue;
    if (s.plansByOrigin.has(issueOrigin(issue.number))) continue;
    if (hasWorkStarted(issue.number, ctx.tasks)) continue;
    const origin = investigateOrigin(issue.number);
    if (s.activeOrigins.has(origin)) {
      s.investigating.add(issue.number);
      continue;
    }
    const root = issueOrigin(issue.number);
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const branch = investigateBranch(issue.number);
    const title = `Investigate issue #${issue.number}`;
    const reason = `Issue #${issue.number} carries the investigate label; find the cause before it is planned.`;
    const candidate = {
      origin,
      rule: 'issue-investigate' as const,
      title,
      kind: 'code' as const,
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt:
          s.templates.render('issue-investigate', {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            branch,
          }) +
          readOnlyNote('Your findings need neither: report_investigation records them directly.') +
          relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates, s.pickup.parentedTypes),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-investigate',
        reason,
      } satisfies RawAction,
    };
    const waits = s.sequenceWaits.get(issue.number);
    if (waits) {
      s.candidates.push({ ...candidate, held: 'sequenced', reason: `${reason} ${sequenceHoldReason(waits)}` });
      s.investigating.add(issue.number);
      continue;
    }
    if (s.consider(candidate)) s.investigating.add(issue.number);
  }
}

/** The reason plan and pickup stand aside for the investigation, or null. Removing the label lifts it. */
export function investigationSupersedes(s: StageContext, issue: Issue, reason: string): string | null {
  if (!s.investigateLabelled(issue)) return null;
  if (s.investigating.has(issue.number)) return supersededReason('issue-investigate', reason);
  const hold = investigationHold(s.investigationFor(issue), true);
  return hold === null ? null : `${reason} Held: ${hold}.`;
}
