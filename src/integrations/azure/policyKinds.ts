// → docs/spec/15-integrations.md

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

const POLICY_CHECK_MODES = ['check', 'advisory', 'off'] as const;

export type PolicyCheckMode = (typeof POLICY_CHECK_MODES)[number];

export type PolicyCheckModes = Partial<Record<PolicyKind, PolicyCheckMode>>;

const POLICY_TYPE_KINDS: ReadonlyMap<string, PolicyKind> = new Map([
  ['0609b952-1397-4640-95ec-e00a01b2c241', 'build'],
  ['cbdc66da-9728-4af8-aada-9a5a32e4a226', 'status'],
  ['c6a1889d-b943-4856-b76f-9e46bb6b0df2', 'comments'],
  ['40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e', 'workItems'],
  ['fd2167ab-b0be-447a-8ec8-39368250530e', 'reviewers'],
  ['fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', 'reviewers'],
  ['fa4e907d-c16b-4a4c-9dfa-4916e5d171ab', 'mergeStrategy'],
]);

const DEFAULT_POLICY_CHECK_MODES: Record<PolicyKind, PolicyCheckMode> = {
  build: 'check',
  status: 'check',
  comments: 'advisory',
  workItems: 'off',
  reviewers: 'off',
  mergeStrategy: 'off',
  other: 'off',
};

export function policyKindOf(typeId: string): PolicyKind {
  return POLICY_TYPE_KINDS.get(typeId) ?? 'other';
}

export function policyCheckMode(kind: PolicyKind, modes: PolicyCheckModes | undefined): PolicyCheckMode {
  return modes?.[kind] ?? DEFAULT_POLICY_CHECK_MODES[kind];
}

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
