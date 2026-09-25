import type { AppState, Issue } from '../types.js';
import type { NeedRow } from './needsYou.js';
import { goalIssue } from './goalRefs.js';
import { proposedParentTitle } from './orphanGoal.js';

// → docs/spec/17-cockpit.md#an-ask-with-a-proposal-is-answered-on-its-row

type QuickField = 'profile' | 'parent' | 'areaPath';

interface QuickChoice {
  value: string;
  label: string;
}

export interface QuickAnswer {
  issue: number;
  field: QuickField;
  proposed: QuickChoice;
  others: QuickChoice[];
}

export function quickAnswer(row: NeedRow, state: AppState): QuickAnswer | null {
  if (row.goalRef === null) return null;
  const issue = goalIssue(state, row.goalRef);
  if (!issue?.appraisal) return null;
  if (row.kind === 'profile') return profileAnswer(issue, state);
  if (row.kind === 'placement') return placementAnswer(row, issue, state);
  return null;
}

function profileAnswer(issue: Issue, state: AppState): QuickAnswer | null {
  const proposed = issue.appraisal?.proposedProfile ?? null;
  if (!issue.appraisal?.awaitingProfileAnswer || proposed === null) return null;
  return {
    issue: issue.number,
    field: 'profile',
    proposed: { value: proposed, label: proposed },
    others: state.config.profiles.filter((p) => p.name !== proposed).map((p) => ({ value: p.name, label: p.name })),
  };
}

function placementAnswer(row: NeedRow, issue: Issue, state: AppState): QuickAnswer | null {
  const ask = issue.appraisal?.placement.find((p) => `placement:${p.field}:${row.goalRef}` === row.id);
  if (ask?.field === 'areaPath' && ask.proposedAreaPath !== null) {
    const proposed = ask.proposedAreaPath;
    return {
      issue: issue.number,
      field: 'areaPath',
      proposed: { value: proposed, label: proposed },
      others: state.config.areaPaths.filter((p) => p !== proposed).map((p) => ({ value: p, label: p })),
    };
  }
  if (ask?.field !== 'parent' || ask.proposedParent === null) return null;
  const proposed = ask.proposedParent;
  return {
    issue: issue.number,
    field: 'parent',
    proposed: { value: String(proposed), label: proposedParentTitle(state, proposed) ?? `#${proposed}` },
    others: state.world.parentCandidates
      .filter((c) => c.number !== issue.number && c.number !== proposed)
      .map((c) => ({ value: String(c.number), label: `${c.title} (#${c.number})` })),
  };
}
