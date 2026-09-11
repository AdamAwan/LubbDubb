import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import {
  checkSetReleased,
  proposedCheckSet,
  queryNotice,
  validationPlanProposalHold,
  validationPlanProposalRef,
} from '../../validation/planApproval.js';
import { liveChecks } from '../../validation/verdict.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `validation-plan-approval`)

export function validationPlanApproval(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);
    const record = s.validationPlans.get(origin) ?? null;
    // The stamp is what is being proposed. A set nobody authored is not a proposal, and a released
    // one has already been answered.
    if (record?.authoredAt == null) continue;
    const checks = liveChecks(s.validationChecks.get(origin) ?? []);
    if (checkSetReleased({ record, checks })) continue;
    const ref = validationPlanProposalRef(issue.number);
    if (validationPlanProposalHold(ref, ctx.proposals ?? []) !== null) continue;

    s.raw.push({
      type: 'propose_validation_plan',
      originRef: origin,
      issueNumber: issue.number,
      checks: checks.length,
      note: record.note,
      hint: record.hint,
      set: proposedCheckSet(checks),
      prompt:
        s.templates.render('validation-plan-approval', {
          number: issue.number,
          title: issue.title,
          checks: checks.length,
        }) + queryNotice(checks),
      rule: 'validation-plan-approval',
      reason:
        `Issue #${issue.number} has a validation check set of ${checks.length} check(s) and nothing reads it as ` +
        `work until you accept it.`,
    } satisfies RawAction);
  }
}
