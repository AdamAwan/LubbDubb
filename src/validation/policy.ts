/**
 * The validation plan's operator policy — what a deployment turns on, and what it
 * turns off byte-for-byte.
 *
 * Its own module for {@link DEFAULT_PLANNING}'s reason: the policy's default
 * belongs beside the subsystem that means it, not in the middle of `config.ts`
 * where the four other funnels' defaults would have to be read to find it.
 */
export interface ValidationPolicy {
  /**
   * **On by default**, unlike `planning` and `assessment`, because it spends no
   * agent and gates nothing: a planner is asked for checks it may decline to
   * write, a person marks them off by hand, and the only thing that ever happens
   * as a result is that closing a goal with checks outstanding says so.
   *
   * Off leaves the surface out entirely — no checks are ingested, the plan sheet
   * draws no section, no goal is flagged at close-out, and behaviour is exactly
   * what it is without validation.
   */
  enabled: boolean;
}

export const DEFAULT_VALIDATION: ValidationPolicy = {
  enabled: true,
};
