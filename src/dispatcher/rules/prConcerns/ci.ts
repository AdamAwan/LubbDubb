import type { PullRequest } from '../../../types.js';
import { ciNeedsAttention } from '../../../pr/prHealth.js';
import { askedAlready } from '../../admission.js';
import { ciFailureNote, ciNeedsHuman, classifyCiFailures, type CiVerdict } from '../../../ci/ciPolicy.js';
import { priorCiRemediesNote } from '../../../remedies/priorRemedies.js';
import { remedyAskNote } from '../../../remedies/remedies.js';
import type { RawAction, StageContext } from '../context.js';
import type { PrConcern } from './concern.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function ciFailingConcern(
  pr: PullRequest,
  s: StageContext,
  inherited: boolean,
): { concern: PrConcern | null; escalation: RawAction | null } {
  const { ctx } = s;
  const ciVerdict = classifyCiFailures(pr.ciChecks, s.ci, pr.ciChecksWithheld);
  const ciFailing = ciNeedsAttention(pr) && !inherited;
  const ciOrigin = `pr:${pr.number}:ci`;
  if (ciFailing && ciVerdict.actionable) {
    return {
      escalation: null,
      concern: {
        rule: 'pr-ci-failing',
        origin: ciOrigin,
        title: `Fix failing CI on PR #${pr.number}`,
        prompt:
          s.templates.render('pr-ci-fix', { number: pr.number, title: pr.title, branch: pr.branch }) +
          ciFailureNote(ciVerdict) +
          priorCiRemediesNote(
            ctx.priorRemedies ?? [],
            ciVerdict.dispatch.map((m) => m.name),
          ) +
          remedyAskNote('ci'),
        dispatchReason: ciDispatchReason(pr.number, ciVerdict),
        note: `CI is now failing on PR #${pr.number} — investigate and push a fix.${ciFailureNote(ciVerdict)}`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
        urgent: ciVerdict.urgent,
        ciChecks: ciVerdict.dispatch.map((m) => m.name),
      },
    };
  }
  if (ciFailing && ciNeedsHuman(ciVerdict) && !askedAlready(ciOrigin, ctx.openEscalations, ctx.recentDecisions)) {
    const names = ciVerdict.escalate.map((m) => m.name).join(', ');
    return {
      concern: null,
      escalation: {
        type: 'escalate_to_human',
        escalationType: 'resolve_ambiguity',
        prompt:
          `CI is failing on PR #${pr.number} ("${pr.title}") only on checks you told the harness not to act ` +
          `on, so nothing has been dispatched — this needs someone who can reach whoever owns them.`,
        context: {
          originRef: ciOrigin,
          prNumber: pr.number,
          taskTitle: pr.title,
          detail: ciVerdict.escalate.map((m) => `- \`${m.name}\``).join('\n'),
          detailFrom: 'Failing, and configured to be left alone',
        },
        rule: 'pr-ci-blocked',
        reason: `PR #${pr.number} is red only on checks configured to escalate (${names}).`,
      } satisfies RawAction,
    };
  }
  return { concern: null, escalation: null };
}

function ciDispatchReason(prNumber: number, verdict: CiVerdict): string {
  const names = verdict.dispatch.map((m) => m.name);
  if (names.length === 0) return `PR #${prNumber} has failing CI and no agent is on it.`;
  return `PR #${prNumber} has failing CI (${names.join(', ')}) and no agent is on it.`;
}
