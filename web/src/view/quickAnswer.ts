import type { AppState } from '../types.js';
import type { NeedRow } from './needsYou.js';
import { goalIssue } from './goalRefs.js';
import { awaitedProfile, placementAskOf } from './issueAsks.js';

// → docs/spec/17-cockpit.md#an-ask-with-a-proposal-is-answered-on-its-row

export interface QuickAnswer {
  issue: number;
  field: 'profile' | 'areaPath';
  proposed: string;
  others: string[];
}

export function quickAnswer(row: NeedRow, state: AppState): QuickAnswer | null {
  const issue = row.goalRef === null ? undefined : goalIssue(state, row.goalRef);
  if (!issue) return null;
  if (row.kind === 'profile') {
    const proposed = awaitedProfile(issue);
    if (proposed === null) return null;
    const others = state.config.profiles.map((p) => p.name).filter((n) => n !== proposed);
    return { issue: issue.number, field: 'profile', proposed, others };
  }
  const ask = row.kind === 'placement' ? placementAskOf(row, issue) : undefined;
  if (ask?.field !== 'areaPath' || ask.proposedAreaPath === null) return null;
  const proposed = ask.proposedAreaPath;
  return {
    issue: issue.number,
    field: 'areaPath',
    proposed,
    others: state.config.areaPaths.filter((p) => p !== proposed),
  };
}
