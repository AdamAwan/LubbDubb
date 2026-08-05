/**
 * Azure branch-policy *kinds*, and what the harness does with each.
 *
 * The provider used to key on a two-GUID allow-list, which answered one question
 * — "is this an automated check?" — and therefore could not express the two the
 * operator actually has. A policy can be worth *seeing* without being worth
 * *dispatching for*, and one the harness will dispatch for does not necessarily
 * block the merge. So evaluations classify into a kind here, and the operator
 * maps kind → mode.
 *
 * Pure and dependency-free: `config.ts` validates a mode map without importing
 * the provider, and `sourceControl.ts` reads one without importing config.
 */

/** Every kind an evaluation can classify into, so config validation can't drift from the map. */
export const POLICY_KINDS = [
  'build',
  'status',
  'comments',
  'workItems',
  'reviewers',
  'mergeStrategy',
  'other',
] as const;

export type PolicyKind = (typeof POLICY_KINDS)[number];

/**
 * How a kind is surfaced.
 *
 * - `check` — an ordinary `CiCheck`: visible, routable by a `ci.checks` rule,
 *   dispatchable.
 * - `advisory` — visible and *structurally* unable to dispatch or escalate. The
 *   comment policy's mode, so it can never outrank rule `pr-review-comment`, which holds the same
 *   signal at far higher fidelity (thread ids, authors, bodies).
 * - `off` — not emitted.
 */
const POLICY_CHECK_MODES = ['check', 'advisory', 'off'] as const;

export type PolicyCheckMode = (typeof POLICY_CHECK_MODES)[number];

/** An operator's kind → mode map; absent kinds take {@link DEFAULT_POLICY_CHECK_MODES}. */
export type PolicyCheckModes = Partial<Record<PolicyKind, PolicyCheckMode>>;

/**
 * Azure's well-known branch-policy type GUIDs, stable across every organization.
 *
 * Two GUIDs map to `reviewers` ("Required reviewers" and "Minimum number of
 * reviewers"); they differ from each other, and from the merge-strategy GUID, by
 * a handful of characters, so they are transcribed rather than pattern-matched.
 */
const POLICY_TYPE_KINDS: ReadonlyMap<string, PolicyKind> = new Map([
  ['0609b952-1397-4640-95ec-e00a01b2c241', 'build'],
  ['cbdc66da-9728-4af8-aada-9a5a32e4a226', 'status'],
  ['c6a1889d-b943-4856-b76f-9e46bb6b0df2', 'comments'],
  ['40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e', 'workItems'],
  ['fd2167ab-b0be-447a-8ec8-39368250530e', 'reviewers'],
  ['fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', 'reviewers'],
  ['fa4e907d-c16b-4a4c-9dfa-4916e5d171ab', 'mergeStrategy'],
]);

/**
 * Conservative by intent.
 *
 * Build and status are the automated checks, Optional ones included — a failing
 * check nobody named still dispatches, which is `ci.checks`' deliberate design
 * and the reason a job added next week gets fixed rather than parking every red
 * PR forever. Comments are advisory: purely additive, since an advisory check
 * moves no dispatch and no aggregate. Work items are off, because promoting them
 * means an agent making writes against a tracker, which is an opt-in.
 */
const DEFAULT_POLICY_CHECK_MODES: Record<PolicyKind, PolicyCheckMode> = {
  build: 'check',
  status: 'check',
  comments: 'advisory',
  workItems: 'off',
  reviewers: 'off',
  mergeStrategy: 'off',
  other: 'off',
};

/** Which kind a policy type GUID is. An unrecognised type is `other` — never guessed at. */
export function policyKindOf(typeId: string): PolicyKind {
  return POLICY_TYPE_KINDS.get(typeId) ?? 'other';
}

/** The configured mode for a kind, falling back to the default for that kind. */
export function policyCheckMode(kind: PolicyKind, modes: PolicyCheckModes | undefined): PolicyCheckMode {
  return modes?.[kind] ?? DEFAULT_POLICY_CHECK_MODES[kind];
}

/**
 * Reject a mode map that cannot mean what it says, at load rather than at 3am —
 * the same fail-fast discipline as `validateCiPolicy`. A typo'd kind would
 * otherwise be silently ignored, and the operator would watch a check they
 * believed they had configured behave exactly as if they had not.
 */
export function validatePolicyCheckModes(modes: PolicyCheckModes): void {
  for (const [kind, mode] of Object.entries(modes)) {
    if (!(POLICY_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`azureDevOps.policyChecks: "${kind}" is not a policy kind (${POLICY_KINDS.join(' | ')}).`);
    }
    if (!(POLICY_CHECK_MODES as readonly string[]).includes(mode as string)) {
      throw new Error(
        `azureDevOps.policyChecks.${kind}: "${String(mode)}" is not one of ${POLICY_CHECK_MODES.join(' | ')}.`,
      );
    }
  }
}
