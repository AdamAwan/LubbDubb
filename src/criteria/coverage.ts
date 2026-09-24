import type { CriterionCoverage, ValidationCheck } from '../types.js';

// → docs/spec/20-validation.md#satisfies-and-the-goals-criteria

type CriterionReading = CriterionCoverage['reading'];

const LABEL: Record<CriterionReading, string> = {
  met: '✅ met',
  'not-met': '❌ not met',
  waived: '➖ waived',
  unread: '⏳ not yet read',
  gap: '⚠️ no check names it',
};

/**
 * One reading per criterion, off the live checks that name it: any failure is `not-met`, every
 * one passed is `met`, every one waived is `waived`, a mix of passes and waivers is `met`, and
 * anything still out is `unread`. A criterion no check names is a `gap` — an absent check looks
 * exactly like one that passed until someone counts.
 */
export function criteriaCoverage(items: readonly string[], checks: readonly ValidationCheck[]): CriterionCoverage[] {
  const live = checks.filter((c) => c.supersededReason === null && c.state !== 'declined');
  return items.map((criterion) => {
    const naming = live.filter((c) => (c.satisfies ?? []).includes(criterion));
    return { criterion, reading: reading(naming), checks: naming.map((c) => c.letter) };
  });
}

function reading(naming: readonly ValidationCheck[]): CriterionReading {
  if (naming.length === 0) return 'gap';
  if (naming.some((c) => c.state === 'failed')) return 'not-met';
  if (naming.every((c) => c.state === 'waived')) return 'waived';
  if (naming.every((c) => c.state === 'passed' || c.state === 'waived')) return 'met';
  return 'unread';
}

export function coverageLines(coverage: readonly CriterionCoverage[]): string[] {
  return coverage.map(
    (c) => `- ${LABEL[c.reading]} — ${c.criterion}${c.checks.length > 0 ? ` (${c.checks.join(', ')})` : ''}`,
  );
}
