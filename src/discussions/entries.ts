import type { DiscussionEntry } from '../types.js';

// → docs/spec/40-discussions.md#what-agents-read

export function standingDecisions(entries: readonly DiscussionEntry[]): DiscussionEntry[] {
  const superseded = new Set(entries.flatMap((entry) => (entry.kind === 'decision' ? entry.supersedes : [])));
  return entries.filter((entry) => entry.kind === 'decision' && (entry.id === null || !superseded.has(entry.id)));
}

export function openQuestions(entries: readonly DiscussionEntry[]): DiscussionEntry[] {
  return entries.filter((entry) => entry.kind === 'question' && entry.state === 'open');
}

export function answeredQuestions(entries: readonly DiscussionEntry[]): DiscussionEntry[] {
  return entries.filter((entry) => entry.kind === 'question' && entry.state === 'answered');
}

export function acceptedIdeas(entries: readonly DiscussionEntry[]): DiscussionEntry[] {
  return entries.filter((entry) => entry.kind === 'idea' && entry.state === 'accepted');
}

export function notesNewestFirst(entries: readonly DiscussionEntry[]): DiscussionEntry[] {
  return entries.filter((entry) => entry.kind === 'note').reverse();
}
