import type { DispatchRuleId } from './rules.js';

// → docs/spec/05-dispatcher.md

interface Rankable {
  origin: string;
  rule: DispatchRuleId;
}

export function rankByPriorityOverride<T extends Rankable>(
  candidates: readonly T[],
  overrideRank: ReadonlyMap<string, number>,
  isExpedited: (originRef: string) => boolean = () => false,
): T[] {
  const keyed = candidates.map((candidate, index) => {
    const override = overrideRank.get(candidate.origin);
    const tier =
      candidate.rule === 'manual-job' ? 0 : isExpedited(candidate.origin) ? 1 : override !== undefined ? 2 : 3;
    const secondary = tier === 2 ? override! : index;
    return { candidate, index, tier, secondary };
  });
  keyed.sort((a, b) => a.tier - b.tier || a.secondary - b.secondary || a.index - b.index);
  return keyed.map((k) => k.candidate);
}
