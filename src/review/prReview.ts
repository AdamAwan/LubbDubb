import type { PrReview, PrReviewRoute, PullRequest } from '../types.js';
import type { PrReviewPolicy } from './policy.js';

// → docs/spec/31-review-packs.md

export function reviewOrigin(prNumber: number): string {
  return `pr:${prNumber}:review`;
}

export function reviewTriageOrigin(prNumber: number): string {
  return `pr:${prNumber}:review-triage`;
}

export function reviewBranch(prNumber: number): string {
  return `review/pr-${prNumber}`;
}

export function reviewTargetPr(originRef: string | null, suffix: 'review' | 'review-triage'): number | null {
  if (originRef === null) return null;
  const match = new RegExp(`^pr:(\\d+):${suffix}$`).exec(originRef);
  return match ? Number(match[1]) : null;
}

export function reviewModeNames(policy: PrReviewPolicy): string[] {
  return Object.keys(policy.modes);
}

export function routesBetweenModes(policy: PrReviewPolicy): boolean {
  return reviewModeNames(policy).length > 1;
}

export function triageRuns(policy: PrReviewPolicy): boolean {
  return routesBetweenModes(policy) || policy.allowSkip;
}

export function reviewSkipped(route: PrReviewRoute | null, policy: PrReviewPolicy): boolean {
  return policy.allowSkip && route !== null && route.skipped;
}

export function defaultReviewMode(policy: PrReviewPolicy): string | null {
  const names = reviewModeNames(policy);
  if (names.length === 0) return null;
  const named = policy.defaultMode;
  return named !== null && names.includes(named) ? named : (names[0] ?? null);
}

export function resolvedReviewMode(route: PrReviewRoute | null, policy: PrReviewPolicy): string | null {
  const names = reviewModeNames(policy);
  if (route !== null && names.includes(route.mode)) return route.mode;
  return defaultReviewMode(policy);
}

export function needsFleetReview(pr: PullRequest, reading: PrReviewReading, policy: PrReviewPolicy): boolean {
  if (!policy.enabled) return false;
  if (pr.merged || reading.review !== null) return false;
  if (reviewSkipped(reading.route, policy)) return false;
  if (reading.elsewhere.has(pr.number)) return false;
  return pr.unresolvedComments.every((c) => c.handled);
}

export function reviewSatisfied(pr: PullRequest, reading: PrReviewReading, policy: PrReviewPolicy): boolean {
  if (!policy.enabled || !policy.blocking) return true;
  if (reviewSkipped(reading.route, policy)) return true;
  if (reading.elsewhere.has(pr.number)) return true;
  return reading.review !== null;
}

export function reviewPendingLabel(mode: string | null): string {
  return mode === null ? 'not yet reviewed by the fleet' : `not yet reviewed by the fleet (${mode})`;
}

export function triagePendingLabel(): string {
  return 'deciding how thoroughly to review it';
}

export function publishNote(publish: PrReviewPolicy['publish']): string {
  if (publish === 'none') {
    return (
      '\n\nDo not comment on the pull request. Your report through `review_report` is how this reaches ' +
      'the person who approves the merge; anything you post beside it is a second copy of it under ' +
      "somebody's name.\n"
    );
  }
  return (
    '\n\nAfter you report, post the same findings on the pull request with `reply_to_review` (omit the ' +
    'comment id — this is a comment on the pull request, not a reply to a thread). That tool is the only ' +
    'way you may write to it: the harness authorises what goes out and signs it as a machine, where a ' +
    "`gh` command from your shell posts under the operator's own name with nothing recording that it " +
    'happened. Report first — the comment is a copy of the record, not the record.\n'
  );
}

export function skipNote(policy: PrReviewPolicy): string {
  if (!policy.allowSkip) return '';
  return (
    '\n\nThis project also lets you decide that a pull request needs **no review at all** — pass ' +
    '`skip: true` to `review_route` instead of a mode. Reach for it only where reading the diff could ' +
    'not change anything: a version bump, a regenerated lockfile, a typo in a comment or a string. ' +
    'Anything that changes behaviour, however small the diff, gets a mode. A skip also releases the ' +
    'merge gate, so it is the one answer of yours that lets a change through unread — and your reason ' +
    'is the only account of why, for whoever finds it later.\n'
  );
}

export function charterNote(charter: string | null, heading: string): string {
  const text = charter?.trim() ?? '';
  if (text === '') return '';
  return `\n\n## ${heading}\n\nThis is committed in the repository by the team that works here. Read it as their standing instruction, and say so if what you find contradicts it.\n\n${text}\n`;
}

export function modeCharterHeading(mode: string | null): string {
  return mode === null
    ? 'What this project asks its reviewers to look at'
    : `What this project asks a "${mode}" review to look at`;
}

export interface PrReviewReading {
  review: PrReview | null;
  route: PrReviewRoute | null;
  elsewhere: ReadonlySet<number>;
}

export function reviewReading(
  rows: {
    prReviews: ReadonlyMap<number, PrReview>;
    prReviewRoutes: ReadonlyMap<number, PrReviewRoute>;
    prReviewedElsewhere: ReadonlySet<number>;
  },
  prNumber: number,
): PrReviewReading {
  return {
    review: rows.prReviews.get(prNumber) ?? null,
    route: rows.prReviewRoutes.get(prNumber) ?? null,
    elsewhere: rows.prReviewedElsewhere,
  };
}

export interface PrReviewCharters {
  routing: string | null;
  modes: Record<string, string | null>;
}
