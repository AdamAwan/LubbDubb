import type { DiscussionDocument, Issue } from '../types.js';
import { openQuestions } from './entries.js';

// → docs/spec/40-discussions.md#an-open-question-holds-the-story

/** `DiscussionFiles.read`, or a per-cycle memo of it. Null is off, absent or unreadable — all fail open. */
export type DiscussionReader = (issueNumber: number) => DiscussionDocument | null;

export interface QuestionHold {
  count: number;
  /** The files the open questions are in, the story's first. */
  paths: string[];
}

export function questionHold(
  read: DiscussionReader | undefined,
  issue: Pick<Issue, 'number' | 'parent'>,
  planned: boolean,
): QuestionHold | null {
  if (read === undefined) return null;
  const own = read(issue.number);
  const sources = [own];
  if (!planned) {
    const parent = issue.parent?.number ?? own?.frontMatter.parentNumber ?? null;
    if (parent !== null && parent !== issue.number) sources.push(read(parent));
  }
  let count = 0;
  const paths: string[] = [];
  for (const doc of sources) {
    const open = doc === null ? 0 : openQuestions(doc.entries).length;
    if (open === 0) continue;
    count += open;
    paths.push(doc!.path);
  }
  return count === 0 ? null : { count, paths };
}

function questionHoldLabel(hold: Pick<QuestionHold, 'count'>): string {
  return `waiting on ${hold.count} open question${hold.count === 1 ? '' : 's'}`;
}

export function questionHoldReason(hold: QuestionHold): string {
  return `Held: ${questionHoldLabel(hold)} — answer ${hold.count === 1 ? 'it' : 'them'} in ${hold.paths.join(' and ')}.`;
}

/** One read per issue per cycle, however many rules ask. */
export function memoReader(read: DiscussionReader): DiscussionReader {
  const seen = new Map<number, DiscussionDocument | null>();
  return (issueNumber) => {
    if (!seen.has(issueNumber)) seen.set(issueNumber, read(issueNumber));
    return seen.get(issueNumber)!;
  };
}
