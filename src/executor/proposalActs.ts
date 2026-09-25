import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import {
  planAmendmentHold,
  planAmendmentProposalRef,
  planProposalHold,
  planProposalRef,
  proposalHold,
  reaskContext,
  rejectionSignalQuery,
} from '../proposals/proposals.js';
import { validationPlanProposalHold, validationPlanProposalRef } from '../validation/planApproval.js';
import { amendmentWarnings, describeAmendment } from '../plans/planAmendment.js';
import { proposedPlanDiff } from '../plans/planDiff.js';
import { planNarrative, planPartInputs, validatePlanDocument } from '../plans/planDocument.js';
import { shortfallRef } from '../delivery/shortfall.js';
import type { Action, DecisionOutcome, PlanAmendment, Proposal, WorldEvent } from '../types.js';

// → docs/spec/09-execution.md

interface ProposalDeps {
  store: Store;
  escalations: EscalationInbox;
}

export type RecordOutcome = (outcome: DecisionOutcome, detail: string) => void;

export function proposePlan(
  deps: ProposalDeps,
  action: ValidatedAction & { type: 'propose_plan' },
  record: RecordOutcome,
): void {
  const { store } = deps;
  const ref = planProposalRef(action.originRef);
  const heldBy = planProposalHold(ref, store.escalations.listProposals());
  if (heldBy) {
    record('skipped', `Skipped proposing the plan for ${action.originRef}: ${heldBy}.`);
    return;
  }
  const esc = deps.escalations.create({
    type: 'approve_change',
    prompt: action.prompt,
    context: {
      originRef: action.originRef,
      planId: action.planId,
      ...(action.detail ? { detail: action.detail, detailFrom: 'What the plan says' } : {}),
    },
  });
  const proposal = store.escalations.createProposal({
    kind: 'plan',
    ref,
    action: action as unknown as Action,
    escalationId: esc.id,
  });
  record(
    'executed',
    `Proposed the plan for ${action.originRef} for approval: ${esc.id} / ${proposal.id}. ` +
      `Accepting releases its parts; nothing is scheduled until then.`,
  );
}

export function proposeValidationPlan(
  deps: ProposalDeps,
  action: ValidatedAction & { type: 'propose_validation_plan' },
  record: RecordOutcome,
): void {
  const { store } = deps;
  const ref = validationPlanProposalRef(action.issueNumber);
  const heldBy = validationPlanProposalHold(ref, store.escalations.listProposals());
  if (heldBy) {
    record('skipped', `Skipped proposing the validation check set for ${action.originRef}: ${heldBy}.`);
    return;
  }
  const esc = deps.escalations.create({
    type: 'approve_change',
    prompt: action.prompt,
    context: {
      originRef: action.originRef,
      issueNumber: action.issueNumber,
      ...(action.note === null ? {} : { detail: action.note, detailFrom: 'What the planner says' }),
    },
  });
  const proposal = store.escalations.createProposal({
    kind: 'validation_plan',
    ref,
    action: action as unknown as Action,
    escalationId: esc.id,
  });
  record(
    'executed',
    `Proposed the validation check set for ${action.originRef} for approval: ${esc.id} / ${proposal.id}. ` +
      `Accepting releases its ${action.checks} check(s); nothing runs them until then.`,
  );
}

export function proposePlanAmendment(
  deps: ProposalDeps,
  action: ValidatedAction & { type: 'propose_plan_amendment' },
  record: RecordOutcome,
): void {
  const { store } = deps;
  const ref = planAmendmentProposalRef(action.amendmentId);
  const heldBy = planAmendmentHold(ref, store.escalations.listProposals());
  if (heldBy) {
    record('skipped', `Skipped proposing the amendment to the plan for ${action.originRef}: ${heldBy}.`);
    return;
  }
  const amendment = store.plans.getPlanAmendment(action.amendmentId);
  if (!amendment || amendment.status !== 'pending') {
    record(
      'skipped',
      `Skipped proposing the amendment to the plan for ${action.originRef}: it is ` +
        `${amendment ? `"${amendment.status}"` : 'gone'}.`,
    );
    return;
  }
  const esc = deps.escalations.create({
    type: 'approve_change',
    prompt: action.prompt,
    context: {
      originRef: action.originRef,
      planId: action.planId,
      amendmentId: amendment.id,
      detail: describeAmendmentFor(store, amendment),
      detailFrom: 'What the amendment changes',
    },
  });
  const proposal = store.escalations.createProposal({
    kind: 'plan_amendment',
    ref,
    action: action as unknown as Action,
    escalationId: esc.id,
  });
  record(
    'executed',
    `Proposed a change to the running plan for ${action.originRef} for approval: ${esc.id} / ` +
      `${proposal.id}. The plan keeps scheduling either way; accepting amends it in place.`,
  );
}

export function proposeShortfall(
  deps: ProposalDeps,
  action: ValidatedAction & { type: 'propose_shortfall' },
  record: RecordOutcome,
): void {
  const { store } = deps;
  const ref = shortfallRef(action.issueNumber);
  const proposals = store.escalations.listProposals();
  const signals = rejectionSignals(store, proposals);
  const heldBy = proposalHold('shortfall', ref, proposals, { rejectionSignals: signals });
  if (heldBy) {
    record('skipped', `Skipped proposing a response to the assessment of ${action.originRef}: ${heldBy}.`);
    return;
  }
  const again = reaskContext('shortfall', ref, proposals, { rejectionSignals: signals });
  const esc = deps.escalations.create({
    type: 'approve_change',
    prompt: again ? `${again}\n\n${action.prompt}` : action.prompt,
    context: {
      originRef: action.originRef,
      issueNumber: action.issueNumber,
      planId: action.planId,
      detail: action.detail,
      detailFrom: 'What the assessor found',
    },
  });
  const proposal = store.escalations.createProposal({
    kind: 'shortfall',
    ref,
    action: action as unknown as Action,
    escalationId: esc.id,
  });
  record(
    'executed',
    `Proposed a response to the failed assessment of ${action.originRef}: ${esc.id} / ${proposal.id}. ` +
      `Accepting ${action.cause === 'plan' ? 'sends the plan back to a planner' : `appends a follow-up part for "${action.partSlug}"`}; nothing happens until then.`,
  );
}

export function rejectionSignals(store: Store, proposals: Proposal[]): WorldEvent[] {
  const query = rejectionSignalQuery(proposals);
  return query ? store.world.listWorldEventsSince(query.since, query.refs) : [];
}

function describeAmendmentFor(store: Store, amendment: PlanAmendment): string {
  let document: unknown;
  try {
    document = JSON.parse(amendment.document);
  } catch {
    return describeAmendment({ note: amendment.note, diff: null, warnings: [] });
  }
  const parsed = validatePlanDocument(document);
  if (!parsed.ok) return describeAmendment({ note: amendment.note, diff: null, warnings: [] });
  const declared = planPartInputs(parsed.document);
  return describeAmendment({
    note: amendment.note,
    diff: proposedPlanDiff(store.plans.listPlanRevisions(amendment.planId), {
      narrative: planNarrative(parsed.document),
      parts: declared,
    }),
    warnings: amendmentWarnings(store.plans.listPlanParts(amendment.planId), declared),
  });
}
