import type { Issue } from '../types.js';

// → docs/spec/17-cockpit.md

export function awaitedProfile(issue: Issue): string | null {
  return issue.appraisal?.awaitingProfileAnswer === true ? issue.appraisal.proposedProfile : null;
}

export function placementAskOf(row: { placementField?: 'parent' | 'areaPath' }, issue: Issue | undefined) {
  return issue?.appraisal?.placement.find((p) => p.field === row.placementField);
}
