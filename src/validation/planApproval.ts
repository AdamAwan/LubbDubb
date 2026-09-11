import { fleetCanStart } from './steps.js';
import type { Proposal, ValidationCheck, ValidationPlanRecord } from '../types.js';

// → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work

/**
 * The proposal's ref is the validation planner's own dispatch origin, which is already one per goal
 * and already classified in `src/issueOrigins.ts`. `issue:<n>:plan` is the code plan's and cannot be
 * shared: two proposals on one ref would hold each other.
 */
export function validationPlanProposalRef(issueNumber: number): string {
  return `issue:${issueNumber}:validate-plan`;
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
 * What the operator is actually deciding about, **appended** to the rendered ask rather than
 * interpolated into it: the planner's note, and every check with its journey and who each step falls
 * to. A card that says "four checks" and does not show them asks for a verdict on a number.
 * → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work
 */
export function describeCheckSet(input: {
  record: ValidationPlanRecord | null;
  checks: readonly ValidationCheck[];
}): string {
  const lines: string[] = [];
  if (input.record?.note != null) lines.push(`**What the planner says**\n\n${input.record.note}\n`);
  if (input.record?.hint != null) lines.push(`**What the plan asked for**\n\n> ${input.record.hint}\n`);
  if (input.checks.length === 0) {
    lines.push(
      '**No checks**\n',
      input.record?.emptyReason == null
        ? 'The planner declared none and gave no account of the absence.'
        : input.record.emptyReason,
    );
    return lines.join('\n');
  }
  for (const check of input.checks) {
    lines.push(`**${check.letter} — ${check.title}**\n`);
    if (check.do.trim() !== '') lines.push(`${check.do}\n`);
    if (check.expect.trim() !== '') lines.push(`Expects: ${check.expect}\n`);
    if (check.steps.length > 0) {
      lines.push(
        ...check.steps.map(
          (step, at) =>
            `${at + 1}. \`${step.kind}\` ${step.do} — ${step.actor === 'fleet' ? 'the fleet' : 'you'}` +
            (step.actor === 'fleet' || step.why === null ? '' : ` (${step.why})`),
        ),
        '',
      );
      if (fleetCanStart(check.steps) === false)
        lines.push('Its first step is a person’s, so the fleet cannot start this one.\n');
    }
    if (check.fleetCandidate)
      lines.push(`The planner nominates the fleet${check.candidateWhy === null ? '' : `: ${check.candidateWhy}`}\n`);
  }
  return lines.join('\n');
}

/**
 * Every check carrying a `state` step, which is the one thing on this card that a release does not
 * authorize. Agent-authored SQL against a real store is approved on its own dry run, keyed on
 * `(query digest, environment)` — a per-place consent, which an accept on one goal must not spend.
 * Naming them here is the other half of that: an operator who accepts four checks and then meets a
 * `blocked` row was not told.
 * → docs/spec/36-remote-validation.md#a-query-is-approved-by-a-person-before-it-is-ever-run
 */
export function queryNotice(checks: readonly ValidationCheck[]): string {
  const carrying = checks.filter((check) => check.steps.some((step) => step.kind === 'state'));
  if (carrying.length === 0) return '';
  return (
    `\n\n${carrying.map((c) => c.letter).join(', ')} read the deployed store, and accepting this set does not ` +
    'approve what they read it with. A query runs once you have read it beside what it returned, on its own dry ' +
    'run and per environment; until then the check is `blocked` and says so.'
  );
}
