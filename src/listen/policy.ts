// → docs/spec/44-needs-you.md#sending-by-itself

export interface ListenPolicy {
  autoSendReviews: boolean;
  autoSendReady: boolean;
  /** The skill a pull request is talked through with; empty is `/lubbdubb:pr`. */
  prSkill: string;
}

export const DEFAULT_LISTEN: ListenPolicy = { autoSendReviews: false, autoSendReady: false, prSkill: '' };

export function prSkillOf(policy: ListenPolicy): string {
  return policy.prSkill.trim() || '/lubbdubb:pr';
}
