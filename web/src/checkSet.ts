import type { ProposedCheck, Proposal, ValidationCheckActor, ValidationStepKind } from './types.js';

// → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work

const STEP_KINDS: ValidationStepKind[] = ['browser', 'suite', 'screenshot', 'state', 'signal', 'measure', 'manual'];

export interface ProposedCheckSet {
  note: string | null;
  hint: string | null;
  checks: ProposedCheck[];
}

/**
 * The set as it was put to the operator, read off the proposal's own action — never off the goal's
 * live rows. `planCaveatsOf`'s rule, one subsystem over: an amendment landing between the ask and the
 * answer must not change what the verdict is about.
 */
export function checkSetOf(proposal: Proposal | undefined): ProposedCheckSet | null {
  if (!proposal || proposal.kind !== 'validation_plan') return null;
  const action = proposal.action as Record<string, unknown>;
  const raw = Array.isArray(action.set) ? action.set : [];
  const checks: ProposedCheck[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { letter, title, expect, steps, fleetCandidate, candidateWhy, fleetBlocked, carriesQuery } = entry as Record<
      string,
      unknown
    >;
    if (typeof letter !== 'string' || letter === '' || typeof title !== 'string' || title === '') continue;
    checks.push({
      letter,
      title,
      expect: typeof expect === 'string' ? expect : '',
      steps: readSteps(steps),
      fleetCandidate: fleetCandidate === true,
      candidateWhy: typeof candidateWhy === 'string' && candidateWhy ? candidateWhy : null,
      fleetBlocked: fleetBlocked === true,
      carriesQuery: carriesQuery === true,
    });
  }
  return {
    note: typeof action.note === 'string' && action.note ? action.note : null,
    hint: typeof action.hint === 'string' && action.hint ? action.hint : null,
    checks,
  };
}

function readSteps(raw: unknown): ProposedCheck['steps'] {
  if (!Array.isArray(raw)) return [];
  const steps: ProposedCheck['steps'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { kind, actor, why } = entry as Record<string, unknown>;
    const did = (entry as Record<string, unknown>).do;
    if (!STEP_KINDS.includes(kind as ValidationStepKind)) continue;
    steps.push({
      kind: kind as ValidationStepKind,
      do: typeof did === 'string' ? did : '',
      actor: (actor === 'fleet' ? 'fleet' : 'human') as ValidationCheckActor,
      why: typeof why === 'string' && why ? why : null,
    });
  }
  return steps;
}
