// → docs/spec/14-persistence.md

export type VerdictKind = 'conclusion' | 'delivery' | 'shortfall' | 'appraisal';

export const VERDICT_KINDS = [
  'conclusion',
  'delivery',
  'shortfall',
  'appraisal',
] as const satisfies readonly VerdictKind[];

export const VERDICT_TABLES: Record<VerdictKind, string> = {
  conclusion: 'issue_conclusions',
  delivery: 'issue_deliveries',
  shortfall: 'issue_shortfalls',
  appraisal: 'issue_appraisals',
};

export const VERDICT_EXCLUSIONS: Record<VerdictKind, readonly VerdictKind[]> = {
  conclusion: ['delivery'],
  delivery: ['conclusion', 'shortfall'],
  shortfall: ['delivery'],
  appraisal: [],
};
