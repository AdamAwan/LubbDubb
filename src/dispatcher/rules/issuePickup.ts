import { issueOriginRef } from '../../issueOrigins.js';
import { supersededReason } from '../admission.js';
import { issueBranch } from '../issuePickup.js';
import { relatedWorkNote } from '../../issueRelations.js';
import { sequenceHoldReason } from '../../sequence/readiness.js';
import type { Candidate, RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-pickup`)

export function issuePickup(s: StageContext): void {
  for (const { issue } of s.eligibleIssues) {
    if (s.routes.get(issue.number)?.route !== 'unplanned') continue;
    const origin = issueOriginRef('root', issue.number);
    if (s.activeOrigins.has(origin)) continue;
    const supersededBy = s.assessing.has(issue.number)
      ? ('issue-assess' as const)
      : s.appraising.has(issue.number)
        ? ('issue-appraisal' as const)
        : null;
    const branch = issueBranch(issue.number);
    const reason = `Open issue #${issue.number} has no open PR and no agent is on it.`;
    const candidate: Candidate = {
      origin,
      rule: 'issue-pickup',
      title: `Resolve issue #${issue.number}`,
      kind: 'code',
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        branch,
        title: `Resolve issue #${issue.number}`,
        prompt:
          s.templates.render('issue-pickup', {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            branch,
          }) +
          relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates, s.pickup.parentedTypes) +
          s.watchDeclareNote +
          s.stateDeclareNote,
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-pickup',
        reason,
      } satisfies RawAction,
    };
    if (supersededBy) {
      s.candidates.push({ ...candidate, held: 'superseded', reason: supersededReason(supersededBy, reason) });
      continue;
    }
    const waits = s.sequenceWaits.get(issue.number);
    if (waits) {
      s.candidates.push({ ...candidate, held: 'sequenced', reason: `${reason} ${sequenceHoldReason(waits)}` });
      continue;
    }
    s.consider(candidate, (attempts) => ({
      type: 'escalate_to_human',
      escalationType: 'resolve_ambiguity',
      prompt: s.templates.render('issue-pickup-escalation', {
        number: issue.number,
        title: issue.title,
        attempts,
      }),
      context: { originRef: origin, taskTitle: `Resolve issue #${issue.number}` },
      rule: 'issue-pickup',
      admission: 'cooldown-escalate',
      reason: `Origin ${origin} hit the ${s.cooldown.maxAttempts}-attempt cap without producing a PR — escalating instead of looping.`,
    }));
  }
}
