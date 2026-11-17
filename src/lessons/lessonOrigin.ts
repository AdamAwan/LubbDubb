// → docs/spec/41-repo-lessons.md#drafting-a-lesson

export function lessonDraftOrigin(draftId: string): string {
  return `lessons:draft:${draftId}`;
}

export function lessonDraftId(originRef: string | null): string | null {
  const match = /^lessons:draft:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}

/** The branch a draft's agent commits to and its pull request is opened from. */
export function lessonBranch(draftId: string): string {
  return `lesson/${draftId}`;
}

/** What an open pull request for a group carries, and how the world is read for one. */
export function lessonMarker(groupKey: string): string {
  return `<!-- lubbdubb:lesson:${groupKey} -->`;
}

/** The ticket's search key: what a second filing for the same group would find. */
export function lessonSearchKey(groupKey: string): string {
  return `lesson:${groupKey}`;
}
