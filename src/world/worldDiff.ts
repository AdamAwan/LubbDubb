import { issueOriginRef } from '../issueOrigins.js';
import { prState } from '../pr/prHealth.js';
import type { CiStatus, Issue, PullRequest, WorldEvent, WorldEventInput, WorldSnapshot } from '../types.js';

// → docs/spec/03-world-model.md

const CI_SUMMARY = /^PR #\d+ CI (passing|failing|pending|unknown)$/;

function ciSummary(number: number, status: CiStatus): string {
  return `PR #${number} CI ${status}`;
}

export function ciStatusOf(event: Pick<WorldEvent, 'kind' | 'summary'>): CiStatus | null {
  if (event.kind !== 'pr_ci') return null;
  const status = CI_SUMMARY.exec(event.summary)?.[1];
  return status === undefined ? null : (status as CiStatus);
}

export function diffWorlds(prev: WorldSnapshot, next: WorldSnapshot): WorldEventInput[] {
  const events: WorldEventInput[] = [];

  const prevPrs = byId(prev.pullRequests);
  for (const pr of next.pullRequests) {
    const before = prevPrs.get(pr.id);
    if (!before) {
      events.push({ kind: 'pr_opened', ref: prRef(pr), summary: `PR #${pr.number} opened: ${pr.title}` });
      continue;
    }
    if (before.ciStatus !== pr.ciStatus) {
      events.push({ kind: 'pr_ci', ref: prRef(pr), summary: ciSummary(pr.number, pr.ciStatus) });
    }
    if (!before.approved && pr.approved) {
      events.push({ kind: 'pr_approved', ref: prRef(pr), summary: `PR #${pr.number} approved` });
    }
    if (!before.mergeable && pr.mergeable) {
      events.push({ kind: 'pr_mergeable', ref: prRef(pr), summary: `PR #${pr.number} is mergeable` });
    }
    if (!before.merged && pr.merged) {
      events.push({ kind: 'pr_merged', ref: prRef(pr), summary: `PR #${pr.number} merged` });
    }
    const seen = new Set(before.unresolvedComments.map((c) => c.id));
    for (const comment of pr.unresolvedComments) {
      if (!seen.has(comment.id)) {
        events.push({ kind: 'pr_comment', ref: prRef(pr), summary: `PR #${pr.number}: ${comment.author} commented` });
      }
    }
  }

  const prevClosed = byId(prev.closedPullRequests ?? []);
  for (const pr of next.closedPullRequests ?? []) {
    if (prevClosed.has(pr.id)) continue;
    const merged = prState(pr) === 'merged';
    if (merged && prevPrs.get(pr.id)?.merged) continue;
    events.push(
      merged
        ? { kind: 'pr_merged', ref: prRef(pr), summary: `PR #${pr.number} merged` }
        : { kind: 'pr_closed', ref: prRef(pr), summary: `PR #${pr.number} closed without merging` },
    );
  }

  const prevIssues = byId(prev.issues);
  for (const issue of next.issues) {
    const before = prevIssues.get(issue.id);
    if (!before) {
      events.push({
        kind: 'issue_opened',
        ref: issueRef(issue),
        summary: `Issue #${issue.number} opened: ${issue.title}`,
      });
      continue;
    }
    if (before.state === 'open' && issue.state === 'closed') {
      events.push({ kind: 'issue_closed', ref: issueRef(issue), summary: `Issue #${issue.number} closed` });
    }
    if (before.linkedPrNumber === null && issue.linkedPrNumber !== null) {
      events.push({
        kind: 'issue_linked',
        ref: issueRef(issue),
        summary: `Issue #${issue.number} linked to PR #${issue.linkedPrNumber}`,
      });
    }
  }

  return events;
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

const prRef = (pr: PullRequest): string => `pr:${pr.number}`;
const issueRef = (issue: Issue): string => issueOriginRef('root', issue.number);
