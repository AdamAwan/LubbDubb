import type { Issue } from '../types.js';
import { openQuestions } from './entries.js';
import { discussionPair, type DiscussionReader } from './reader.js';

// → docs/spec/40-discussions.md#an-open-question-holds-the-story

export interface QuestionHold {
  count: number;
  /** The story's first. */
  paths: string[];
}

export function questionHold(
  read: DiscussionReader | undefined,
  issue: Pick<Issue, 'number' | 'parent'>,
  planned: boolean,
): QuestionHold | null {
  if (read === undefined) return null;
  const { story, feature } = planned
    ? { story: read(issue.number), feature: null }
    : discussionPair(read, issue.number, issue.parent?.number ?? null);
  let count = 0;
  const paths: string[] = [];
  for (const doc of [story, feature]) {
    const open = doc === null ? 0 : openQuestions(doc.entries).length;
    if (open === 0) continue;
    count += open;
    paths.push(doc!.path);
  }
  return count === 0 ? null : { count, paths };
}

export function questionHoldReason(hold: QuestionHold): string {
  const label = `waiting on ${hold.count} open question${hold.count === 1 ? '' : 's'}`;
  return `Held: ${label} — answer ${hold.count === 1 ? 'it' : 'them'} in ${hold.paths.join(' and ')}.`;
}
