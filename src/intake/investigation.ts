import type { Issue, IssueInvestigation } from '../types.js';
import { issueOriginRef } from '../issueOrigins.js';
import { pickupLabels } from '../watchLabels.js';
import { goalFingerprint } from './appraisal.js';
import { investigationHold } from './investigationHold.js';

// → docs/spec/06-issue-pickup.md

export function investigateOrigin(issueNumber: number): string {
  return issueOriginRef('investigate', issueNumber);
}

export function investigateBranch(issueNumber: number): string {
  return `investigate/issue/${issueNumber}`;
}

/** One issue's investigation, read once: the findings for its current text, the label, and the hold. */
export interface InvestigationStanding {
  current: IssueInvestigation | null;
  labelled: boolean;
  /** `current` while the label is on, else null — the findings dispatch acts on. */
  inForce: IssueInvestigation | null;
  hold: string | null;
}

export type InvestigationStandings = ReadonlyMap<number, InvestigationStanding>;

const NO_INVESTIGATION: InvestigationStanding = { current: null, labelled: false, inForce: null, hold: null };

export function investigationStandings(
  issues: readonly Pick<Issue, 'number' | 'title' | 'body' | 'labels' | 'labelsAddedByViewer'>[],
  investigations: readonly IssueInvestigation[],
  policy: { investigateLabel: string; requireOwnLabel?: boolean },
): Map<number, InvestigationStanding> {
  const byOrigin = new Map(investigations.map((i) => [i.originRef, i]));
  const standings = new Map<number, InvestigationStanding>();
  for (const issue of issues) {
    const stored = byOrigin.get(issueOriginRef('root', issue.number));
    const current = stored !== undefined && stored.goalRef === goalFingerprint(issue.title, issue.body) ? stored : null;
    const labelled = pickupLabels(issue, policy.requireOwnLabel).includes(policy.investigateLabel);
    const inForce = labelled ? current : null;
    standings.set(issue.number, { current, labelled, inForce, hold: investigationHold(inForce) });
  }
  return standings;
}

export function investigationStanding(
  standings: InvestigationStandings | undefined,
  issueNumber: number,
): InvestigationStanding {
  return standings?.get(issueNumber) ?? NO_INVESTIGATION;
}

export function investigationNote({ inForce: investigation }: InvestigationStanding): string {
  if (investigation === null) return '';
  if (investigation.resolution !== 'plan') return '';
  return (
    '\n\n## What the investigation found\n\n' +
    'A read-only agent investigated this issue before you were dispatched, and an operator accepted its ' +
    'findings. Treat them as one agent’s reading: check anything you rely on against the repository.\n\n' +
    `- **Confidence:** ${investigation.confidence}\n` +
    `- **Reproduction:** ${investigation.reproduction}\n` +
    `- **Root cause:** ${investigation.rootCause}\n` +
    `- **Where:** ${investigation.locations}\n` +
    `- **Blast radius:** ${investigation.blastRadius}`
  );
}
