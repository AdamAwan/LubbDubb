import type { DiscussionDocument, DiscussionEntry } from '../types.js';
import { acceptedIdeas, answeredQuestions, notesNewestFirst, standingDecisions } from './entries.js';
import { discussionPair, type DiscussionReader } from './reader.js';

// → docs/spec/40-discussions.md#what-agents-read

const SECTION_BUDGET = 6000;

const CUT_LINE_ROOM = 200;

const NOTES_TITLE = 'Notes, newest first';

function entryBlock(entry: DiscussionEntry, from: string | null = null): string {
  const by = entry.unreadable
    ? [from, `heading not understood: ${entry.heading.replace(/^#+\s*/, '')}`]
    : [from, entry.date, entry.author, entry.id === null ? null : `^${entry.id}`];
  const head = `**${by.filter((x) => x !== null).join(' · ') || 'undated'}**`;
  const body = entry.body.trim();
  const answer = entry.answer === null ? '' : `\n\nAnswer: ${entry.answer.trim()}`;
  return `${head}\n\n${body}${answer}`.trim();
}

function group(title: string, blocks: string[]): string {
  return blocks.length === 0 ? '' : `\n\n#### ${title}\n\n${blocks.join('\n\n')}`;
}

function notesWithin(notes: string[], used: number, path: string): string {
  const kept: string[] = [];
  let length = used + NOTES_TITLE.length + 8;
  for (const note of notes) {
    if (length + note.length + 2 > SECTION_BUDGET - CUT_LINE_ROOM) break;
    kept.push(note);
    length += note.length + 2;
  }
  const left = notes.length - kept.length;
  const cut =
    left === 0
      ? ''
      : `\n\n_${left} older note${left === 1 ? '' : 's'} left out to keep this short — the whole discussion is in ${path}._`;
  return group(NOTES_TITLE, kept) + cut;
}

export function discussionSection(story: DiscussionDocument | null, feature: DiscussionDocument | null): string {
  const subject = story ?? feature;
  if (subject === null) return '';
  const own = story?.entries ?? [];
  const decisions = [
    ...standingDecisions(own).map((e) => entryBlock(e)),
    ...standingDecisions(feature?.entries ?? []).map((e) => entryBlock(e, 'the feature')),
  ];
  const ideas = acceptedIdeas(own).map((e) => entryBlock(e));
  const answered = answeredQuestions(own).map((e) => entryBlock(e));
  const notes = notesNewestFirst(own).map((e) => entryBlock(e));
  if (decisions.length + ideas.length + answered.length + notes.length === 0) return '';

  const fixed =
    `\n\n---\n\n**Discussion** — what has been settled and said about this work so far, kept by the operator in ` +
    `${subject.path}. Standing decisions are the operator's and stand: build on them rather than re-deciding. ` +
    `To leave a note, an idea or a question for the operator, call discussion_add; an open question holds the ` +
    `next dispatch on this story until it is answered, so ask rather than build on a guess.` +
    group('Standing decisions', decisions) +
    group('Accepted ideas', ideas) +
    group('Answered questions', answered);
  return fixed + notesWithin(notes, fixed.length, subject.path);
}

export function discussionNoteFor(
  read: DiscussionReader | undefined,
  issueNumber: number,
  parent: number | null,
): string {
  if (read === undefined) return '';
  const { story, feature } = discussionPair(read, issueNumber, parent);
  return discussionSection(story, feature);
}
