import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import { claimIsLive } from '../../validation/desktop.js';
import { checkBriefing, validateBranch, validateOrigin } from '../../validation/fleet.js';
import { checkSetReleased } from '../../validation/planApproval.js';
import { fleetCanStart } from '../../validation/steps.js';
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
    const checks = liveChecks(s.validationChecks.get(origin) ?? []);
    // A set the operator has not accepted is not work yet: the rows exist, the bench draws them as
    // proposed, and dispatching one would put an agent on a procedure nobody agreed to.
    // → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work
    if (!checkSetReleased({ record: s.validationPlans.get(origin) ?? null, checks })) continue;

    for (const check of checks) {
      if (check.actor !== 'fleet' || check.state !== 'unrun') continue;
      if (claimIsLive(check, s.now, s.validationClaimMinutes)) continue;
      // A test plan whose *first* step is a person's is a check that can never execute: dispatched,
      // it holds a slot in front of a step no agent can take, and blocks nothing while it does. It
      // stays where an operator can see it — unrun and handed to the fleet — rather than becoming an
      // agent sitting in front of somebody's day.
      // → docs/spec/20-validation.md#an-inline-person-and-a-deferred-one-are-not-the-same-step
      if (fleetCanStart(check.steps) === false) continue;

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
