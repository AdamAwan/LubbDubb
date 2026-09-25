import type { PrPerson, ViewerAssignment } from '../../types.js';
import { sameIdentity } from '../../pr/prOwnership.js';
import type { AzReviewer } from './azureDevOpsApi.js';

// → docs/spec/15-integrations.md#the-azure-provider

export function viewerAssignment(reviewers: readonly AzReviewer[], viewer: string): ViewerAssignment | undefined {
  if (viewer === '') return undefined;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  if (mine === undefined) return undefined;
  return mine.isRequired ? 'reviewer-required' : 'reviewer-optional';
}

export function namedReviewers(reviewers: readonly AzReviewer[]): PrPerson[] {
  return reviewers.flatMap((r) =>
    r.isContainer || r.id === undefined ? [] : [{ id: r.id, name: r.displayName ?? r.uniqueName }],
  );
}

export function viewerApproved(reviewers: readonly AzReviewer[], viewer: string): boolean {
  if (viewer === '') return false;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  return mine !== undefined && mine.vote >= 5;
}

export function computeApproved(votes: number[]): boolean {
  if (votes.some((v) => v < 0)) return false;
  return votes.some((v) => v >= 5);
}
