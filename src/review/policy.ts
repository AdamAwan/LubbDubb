// → docs/spec/31-review-packs.md

interface PrReviewMode {
  charterFile?: string | null;
  profile?: string | null;
}

export interface PrReviewPolicy {
  enabled: boolean;
  blocking: boolean;
  publish: 'none' | 'comment';
  publishedThreadProperty: string | null;
  publishedThreadRole: string | null;
  modes: Record<string, PrReviewMode>;
  allowSkip: boolean;
  reviewedElsewhere: string | null;
  defaultMode: string | null;
  routingCharterFile: string | null;
}

export const DEFAULT_PR_REVIEW: PrReviewPolicy = {
  enabled: false,
  blocking: true,
  publish: 'none',
  publishedThreadProperty: null,
  publishedThreadRole: null,
  modes: {},
  allowSkip: false,
  reviewedElsewhere: null,
  defaultMode: null,
  routingCharterFile: null,
};
