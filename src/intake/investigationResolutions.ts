// → docs/spec/06-issue-pickup.md

/** The answers an operator gives an investigation's findings, and the recommendations an investigator makes. */
export const INVESTIGATION_RESOLUTIONS = ['plan', 'close', 'ask'] as const;

/** A row or an agent from before `pickup` was withdrawn: it reads as `plan`. → docs/spec/38-bug-investigation.md#no-fix-without-a-plan */
export function withdrawnPickup(value: string): string {
  return value === 'pickup' ? 'plan' : value;
}
