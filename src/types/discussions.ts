export type DiscussionKind = 'note' | 'idea' | 'question' | 'decision';

/** An idea is `open`, `accepted`, `parked` or `dropped`; a question `open` or `answered`. */
export type DiscussionEntryState = 'open' | 'accepted' | 'parked' | 'dropped' | 'answered';

/** One `## ` entry of a discussion file. An unreadable heading is a note with `unreadable` set, never dropped. */
export interface DiscussionEntry {
  kind: DiscussionKind;
  state: DiscussionEntryState | null;
  date: string | null;
  author: string | null;
  /** The Obsidian block id, without its `^`; null when the heading carries none yet. */
  id: string | null;
  heading: string;
  body: string;
  answer: string | null;
  supersedes: string[];
  unreadable: boolean;
}

export type DiscussionSubjectKind = 'story' | 'feature';

export interface DiscussionFrontMatter {
  ref: string | null;
  kind: DiscussionSubjectKind | null;
  title: string | null;
  parent: string | null;
  /** The issue number the Obsidian `[[link]]` in `parent` leads with. */
  parentNumber: number | null;
  published: string | null;
  pulled: string | null;
}

export interface DiscussionDocument {
  path: string;
  frontMatter: DiscussionFrontMatter;
  entries: DiscussionEntry[];
}
