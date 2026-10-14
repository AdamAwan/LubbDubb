import type { IssueInvestigation } from '../types.js';

// → docs/spec/06-issue-pickup.md

export const FINDINGS_WAITING_REASON = 'the investigation findings are waiting on you';

/** Why plan and pickup wait on a standing investigation, or null. The label is the only switch. */
export function investigationHold(investigation: IssueInvestigation | null, labelled: boolean): string | null {
  if (!labelled || investigation === null) return null;
  if (investigation.resolution === null) return FINDINGS_WAITING_REASON;
  if (investigation.resolution === 'close') return 'you marked the investigation for closing';
  if (investigation.resolution === 'ask') return 'you asked for more from the reporter after the investigation';
  return null;
}
