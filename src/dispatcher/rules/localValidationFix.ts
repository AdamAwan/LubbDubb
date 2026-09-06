import { localValidationFixBriefing } from '../../localValidation/briefing.js';
import { localValidationFixOrigin } from '../../localValidation/origin.js';
import { issueWatchGateReason } from '../issuePickup.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `local-validation-fix`)

export function localValidationFix(s: StageContext): void {
  for (const row of s.localValidations) {
    if (row.status !== 'failed' || row.fixTaskId !== null || row.findings.length === 0) continue;

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
        base: s.defaultBranch,
        title,
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
