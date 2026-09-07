import type { AppState, Issue } from '../types.js';

// → docs/spec/17-cockpit.md

interface OrphanGoal {
  proposed: number | null;
  settledAt: string | null;
}

export function orphanGoal(state: AppState, issue: Issue): OrphanGoal | null {
  if (!state.config.canPlaceWorkItem) return null;
  if (issue.parent !== null) return null;
  const appraisal = issue.appraisal;
  return {
    proposed: appraisal?.placement.find((p) => p.field === 'parent')?.proposedParent ?? null,
    settledAt: appraisal?.parentSettledAt ?? null,
  };
}

export function orphanCount(state: AppState, issues: readonly Issue[]): number {
  return issues.filter((issue) => orphanGoal(state, issue) !== null).length;
}

export function proposedParentTitle(state: AppState, number: number | null): string | null {
  if (number === null) return null;
  const candidate = state.world.parentCandidates.find((c) => c.number === number);
  if (candidate !== undefined) return candidate.title;
  return state.world.issues.find((i) => i.number === number)?.title ?? null;
}
