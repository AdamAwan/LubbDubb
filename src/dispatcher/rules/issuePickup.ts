import { supersededReason } from '../admission.js';
import { issueBranch } from '../issuePickup.js';
import { relatedWorkNote } from '../../issueRelations.js';
import type { Candidate, RawAction, StageContext } from './context.js';

/**
 * Resolve an open issue into a PR — the front of the issue → PR → merge loop, and
 * last in the pipeline because everything above it narrows it.
 */
export function issuePickup(s: StageContext): void {
  for (const { issue } of s.eligibleIssues) {
    // Narrowed by the funnel to the **unplanned** arm alone: every planned issue,
    // whether its plan has one part or eight, is scheduled by rule `plan-part`, so
    // what reaches here is only an issue the funnel gave up on. Everything below is
    // byte-for-byte what it was before the gate.
    if (s.routes.get(issue.number)?.route !== 'unplanned') continue;
    const origin = `issue:${issue.number}`;
    // An agent already on this issue owns it — don't throttle/escalate over a
    // live attempt; the active-task de-dup handles it.
    if (s.activeOrigins.has(origin)) continue;
    // `issue-assess` is asking whether this issue is already finished and
    // `issue-assay` whether its goal can be worked from at all. Picking it up in
    // the same cycle would put a second agent on it to redo work the first is
    // still judging, or answer the assay's question by ignoring it. Both sets are
    // built by those two stages, which the pipeline runs first, so no two rules
    // can hold different opinions about which issues are in them.
    const supersededBy = s.assessing.has(issue.number)
      ? ('issue-assess' as const)
      : s.assaying.has(issue.number)
        ? ('issue-assay' as const)
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
          }) + relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-pickup',
        reason,
      } satisfies RawAction,
    };
    // Queued as held rather than skipped, and *not* routed through `consider`:
    // the cooldown has no bearing on a pickup that is not going out this cycle
    // for a different reason entirely, and escalating an attempt cap over a
    // suppressed dispatch would blame the pickup for the assay's turn.
    if (supersededBy) {
      s.candidates.push({ ...candidate, held: 'superseded', reason: supersededReason(supersededBy, reason) });
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
