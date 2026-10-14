import type { Issue, IssueInvestigation } from '../types.js';
import { issueOriginRef } from '../issueOrigins.js';
import { goalFingerprint } from './appraisal.js';

// → docs/spec/06-issue-pickup.md

export function investigateOrigin(issueNumber: number): string {
  return issueOriginRef('investigate', issueNumber);
}

export function investigateBranch(issueNumber: number): string {
  return `investigate/issue/${issueNumber}`;
}

export function currentInvestigation(
  investigation: IssueInvestigation | null | undefined,
  issue: Pick<Issue, 'title' | 'body'>,
): IssueInvestigation | null {
  if (!investigation) return null;
  return investigation.goalRef === goalFingerprint(issue.title, issue.body) ? investigation : null;
}

export function investigationSkipsPlanning(investigation: IssueInvestigation | null): boolean {
  return investigation?.resolution === 'pickup';
}

export function investigationNote(investigation: IssueInvestigation | null): string {
  if (investigation === null) return '';
  if (investigation.resolution !== 'plan' && investigation.resolution !== 'pickup') return '';
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
