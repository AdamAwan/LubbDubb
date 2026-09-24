import type { CriteriaAlignmentPoint, CriteriaAlignmentVerdict } from '../types.js';

// → docs/spec/08-planning.md#the-alignment-check

export const CRITERIA_ALIGNMENT_VERDICTS = [
  'aligned',
  'partial',
  'conflicting',
] as const satisfies readonly CriteriaAlignmentVerdict[];

export const CRITERIA_POINT_TAGS = [
  'matches',
  'extra',
  'uncovered',
  'contradicts',
] as const satisfies readonly CriteriaAlignmentPoint['tag'][];
