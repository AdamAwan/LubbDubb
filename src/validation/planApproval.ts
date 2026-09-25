import { fleetCanStart } from './steps.js';
import { validationPlanOrigin } from './authoring.js';
import type { ProposedCheck, Proposal, ValidationCheck, ValidationPlanRecord } from '../types.js';

// → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work

/**
 * The proposal's ref is the validation planner's own dispatch origin, minted through the family that
 * declares it: one per goal, already classified. `issue:<n>:plan` is the code plan's and cannot be
 * shared: two proposals on one ref would hold each other.
 */
export function validationPlanProposalRef(issueNumber: number): string {
  return validationPlanOrigin(issueNumber);
}

export function validationPlanProposalHold(ref: string, proposals: readonly Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'validation_plan' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

/**
 * A goal whose check set anything may read as work. The stamp is the authority for a set the
 * validation planner authored; the second arm is a set a plan document ingested before authoring
 * moved, which an operator may be halfway through and which no press of theirs ever released.
 * Reading such a set as held would stop a sheet assembling and a dispatch firing on every goal
 * planned before the gate, with nothing red.
 */
export function checkSetReleased(input: {
  record: ValidationPlanRecord | null;
  checks: readonly ValidationCheck[];
}): boolean {
  if (input.record?.releasedAt != null) return true;
  if (input.record?.authoredAt != null) return false;
  return input.checks.length > 0;
}

/**
 * A set still waiting on the operator: authored and not accepted, or sent back and being rewritten.
 * Not `!checkSetReleased` — a sent-back set keeps its `note` and its rows.
 * → docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time
 */
export function checkSetUnanswered(record: ValidationPlanRecord): boolean {
  return record.releasedAt === null && (record.authoredAt !== null || record.note !== null);
}

/**
 * The set as it is put to the operator: one entry per check, carried on the action so the ask draws
 * structure rather than a paragraph. A card that says "three checks" and hands over prose asks for a
 * verdict on a number; a card that draws the journey and who each step falls to asks for one on the
 * set. → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work
 */
export function proposedCheckSet(checks: readonly ValidationCheck[]): ProposedCheck[] {
  return checks.map((check) => ({
    letter: check.letter,
    title: check.title,
    expect: check.expect,
    proof: check.proof ?? '',
    steps: check.steps.map((step) => ({ kind: step.kind, do: step.do, actor: step.actor, why: step.why })),
    fleetCandidate: check.fleetCandidate,
    candidateWhy: check.candidateWhy,
    fleetBlocked: fleetCanStart(check.steps) === false,
    carriesQuery: check.steps.some((step) => step.kind === 'state'),
  }));
}
