import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import { claimIsLive } from '../../validation/desktop.js';
import { failureBriefing, validationFailureBranch, validationFailureOrigin } from '../../validation/fleet.js';
import { validationGoalDir } from '../../validation/resources.js';
import { liveChecks } from '../../validation/verdict.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { Decision, ValidationCheck } from '../../types.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `validation-failed`)

export function validationFailed(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);

    for (const check of liveChecks(s.validationChecks.get(origin) ?? [])) {
      if (check.state !== 'failed') continue;
      if (check.resultAt === null) continue;
      if (claimIsLive(check, s.now, s.validationClaimMinutes)) continue;

      const checkOrigin = validationFailureOrigin(issue.number, check.id);
      const verdict = dispatchVerdict(checkOrigin, s.now, sinceReading(ctx.recentDecisions, check), s.cooldown);
      if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

      const title = `Look into failed validation check ${check.letter} on issue #${issue.number}`;
      const reason =
        `Check ${check.letter} ("${check.title}") on issue #${issue.number} was run against the delivered ` +
        `goal and failed.`;
      s.candidates.push({
        origin: checkOrigin,
        rule: 'validation-failed',
        title,
        kind: 'code',
        branch: validationFailureBranch(issue.number, check.id),
        reason,
        held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
        action: {
          type: 'dispatch_code_agent',
          ...readOnlyDispatch(validationFailureBranch(issue.number, check.id), s.defaultBranch),
          title,
          prompt:
            s.templates.render('validation-failed', {
              number: issue.number,
              title: issue.title,
              letter: check.letter,
              root: validationGoalDir(s.validationRoot, origin),
            }) + failureBriefing(check),
          originRef: checkOrigin,
          originTitle: issue.title,
          originSummary: issue.body,
          rule: 'validation-failed',
          reason,
        } satisfies RawAction,
      });
    }
  }
}

function sinceReading(recentDecisions: Decision[], check: ValidationCheck): Decision[] {
  const since = Date.parse(check.resultAt ?? '');
  if (Number.isNaN(since)) return recentDecisions;
  return recentDecisions.filter((d) => Date.parse(d.createdAt) > since);
}
