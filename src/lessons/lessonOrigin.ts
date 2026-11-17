import { createHash } from 'node:crypto';

// → docs/spec/41-repo-lessons.md#drafting-a-lesson

export function lessonDraftOrigin(draftId: string): string {
  return `lessons:draft:${draftId}`;
}

export function lessonDraftId(originRef: string | null): string | null {
  const match = /^lessons:draft:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}

const TAG_LENGTH = 10;
const TAGGED_BRANCH = new RegExp(`^lesson/([0-9a-f]{${String(TAG_LENGTH)}})/.+$`);

/** A group key in a form a branch name can carry: every fleet on the repository derives the same tag. */
export function lessonGroupTag(groupKey: string): string {
  return createHash('sha1').update(groupKey).digest('hex').slice(0, TAG_LENGTH);
}

/** The branch a draft's agent commits to and its pull request is opened from. */
export function lessonBranch(draftId: string, groupKey: string): string {
  return `lesson/${lessonGroupTag(groupKey)}/${draftId}`;
}

/** The group tag a lesson branch carries; null for one cut before branches carried it. */
export function lessonBranchTag(branch: string): string | null {
  return TAGGED_BRANCH.exec(branch)?.[1] ?? null;
}

export function isLessonBranch(branch: string): boolean {
  return /^lesson\/.+$/.test(branch);
}

/** What an open pull request for a group carries, and how the world is read for one. */
export function lessonMarker(groupKey: string): string {
  return `<!-- lubbdubb:lesson:${groupKey} -->`;
}

/** The ticket's search key: what a second filing for the same group would find. */
export function lessonSearchKey(groupKey: string): string {
  return `lesson:${groupKey}`;
}

/** The pull requests whose branch carries the group's tag. */
export function lessonPrsForGroup<T extends { branch: string }>(prs: readonly T[], groupKey: string): T[] {
  const tag = lessonGroupTag(groupKey);
  return prs.filter((pr) => lessonBranchTag(pr.branch) === tag);
}
