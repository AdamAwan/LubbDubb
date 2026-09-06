import type { ReviewPackHead } from '../store/reviewPacks.js';

// → docs/spec/31-review-packs.md

export type PrPackStanding = 'current' | 'stale' | 'unplaced' | 'writing';

export function packStandingOf(
  pack: ReviewPackHead | undefined,
  headSha: string | undefined,
  writing: boolean,
): PrPackStanding | undefined {
  if (pack === undefined) return writing ? 'writing' : undefined;
  if (headSha === undefined) return 'unplaced';
  return pack.headSha === headSha ? 'current' : 'stale';
}
