import type { DiscussionDocument } from '../types.js';

// → docs/spec/40-discussions.md#what-agents-read

/** Null is off, absent or unreadable — all fail open. */
export type DiscussionReader = (issueNumber: number) => DiscussionDocument | null;

export function memoReader(read: DiscussionReader): DiscussionReader {
  const seen = new Map<number, DiscussionDocument | null>();
  return (issueNumber) => {
    if (!seen.has(issueNumber)) seen.set(issueNumber, read(issueNumber));
    return seen.get(issueNumber)!;
  };
}

export function discussionParent(
  issueNumber: number,
  issueParent: number | null,
  doc: DiscussionDocument | null,
): number | null {
  const parent = issueParent ?? doc?.frontMatter.parentNumber ?? null;
  return parent === issueNumber ? null : parent;
}

export function discussionPair(
  read: DiscussionReader,
  issueNumber: number,
  issueParent: number | null,
): { story: DiscussionDocument | null; feature: DiscussionDocument | null } {
  const story = read(issueNumber);
  const parent = discussionParent(issueNumber, issueParent, story);
  return { story, feature: parent === null ? null : read(parent) };
}
