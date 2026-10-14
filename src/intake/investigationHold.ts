import type { IssueInvestigation } from '../types.js';

// → docs/spec/06-issue-pickup.md

/** Why plan and pickup wait on a labelled issue's standing investigation, or null. */
export function investigationHold(investigation: IssueInvestigation | null): string | null {
  if (investigation === null) return null;
  if (investigation.resolution === null) return 'the investigation findings are waiting on you';
  if (investigation.resolution === 'close') return 'you marked the investigation for closing';
  if (investigation.resolution === 'ask') return 'you asked for more from the reporter after the investigation';
  return null;
}
