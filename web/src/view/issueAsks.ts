import type { InvestigationResolution, Issue, IssueInvestigation } from '../types.js';
import { INVESTIGATION_RESOLUTIONS } from './investigationResolutions.js';

// → docs/spec/17-cockpit.md

export function awaitedProfile(issue: Issue): string | null {
  return issue.appraisal?.awaitingProfileAnswer === true ? issue.appraisal.proposedProfile : null;
}

export function placementAskOf(row: { placementField?: 'parent' | 'areaPath' }, issue: Issue | undefined) {
  return issue?.appraisal?.placement.find((p) => p.field === row.placementField);
}

/** The findings an ask stands on: recorded for the goal's current text, not yet answered, and holding the goal. */
export function awaitedFindings(issue: Issue): IssueInvestigation | null {
  const found = issue.investigation;
  return found !== null && found.resolution === null && issue.pickup.status === 'investigation' ? found : null;
}

/** The header's `Investigation ·` chip: an answer the operator gave, or findings that hold the goal on them. */
export function investigationChip(issue: Issue): { text: string; tone: 'amber' | 'green' } | null {
  const found = issue.investigation;
  if (found === null) return null;
  if (found.resolution !== null) return { text: found.resolution, tone: 'green' };
  return awaitedFindings(issue) === null ? null : { text: 'waiting on you', tone: 'amber' };
}

const FINDINGS_ANSWER: Record<InvestigationResolution, { label: string; title: string }> = {
  plan: { label: 'Plan it', title: 'Send it to a planner, with these findings in its brief' },
  pickup: {
    label: 'Straight to pickup',
    title: 'Skip planning — one agent works the issue whole, with these findings in its brief',
  },
  close: {
    label: 'Close',
    title: 'Hold it for closing — nothing is planned or picked up while the label stays on',
  },
  ask: {
    label: 'Ask for info',
    title: 'Hold it while the reporter is asked for more — nothing is planned or picked up while the label stays on',
  },
};

/** The four answers to an investigation, in the order the ask draws them. → docs/spec/06-issue-pickup.md */
export const FINDINGS_ANSWERS: readonly { resolution: InvestigationResolution; label: string; title: string }[] =
  INVESTIGATION_RESOLUTIONS.map((resolution) => ({ resolution, ...FINDINGS_ANSWER[resolution] }));
