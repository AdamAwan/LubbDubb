import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import { claimIsLive } from '../../validation/desktop.js';
import { checkBriefing, validateBranch, validateOrigin } from '../../validation/fleet.js';
import { validationGoalDir } from '../../validation/resources.js';
import { liveChecks } from '../../validation/verdict.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `validate-check`)

export function validateCheck(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);

    for (const check of liveChecks(s.validationChecks.get(origin) ?? [])) {
      if (check.actor !== 'fleet' || check.state !== 'unrun') continue;
      if (claimIsLive(check, s.now, s.validationClaimMinutes)) continue;

      const checkOrigin = validateOrigin(issue.number, check.id);
      const verdict = dispatchVerdict(checkOrigin, s.now, ctx.recentDecisions, s.cooldown);
      if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

      const title = `Run validation check ${check.letter} on issue #${issue.number}`;
      const reason = `Check ${check.letter} ("${check.title}") on issue #${issue.number} was handed to the fleet and has not been run.`;
      s.candidates.push({
        origin: checkOrigin,
        rule: 'validate-check',
        title,
        kind: 'code',
        branch: validateBranch(issue.number, check.id),
        reason,
        held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
        action: {
          type: 'dispatch_code_agent',
          ...readOnlyDispatch(validateBranch(issue.number, check.id), s.defaultBranch),
          title,
          prompt:
            s.templates.render('validation-check', {
              number: issue.number,
              title: issue.title,
              letter: check.letter,
              root: validationGoalDir(s.validationRoot, origin),
            }) + checkBriefing(check),
          originRef: checkOrigin,
          originTitle: issue.title,
          originSummary: issue.body,
          rule: 'validate-check',
          reason,
        } satisfies RawAction,
      });
    }
  }
}
