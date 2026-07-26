/**
 * Pure helpers for enriching escalation context so the cockpit can present
 * enough to answer in-place. Kept dependency-free and unit-tested directly.
 */
import type { EscalationType } from '../types.js';

// The reserved control strings agents print; stripped from any displayed excerpt
// so a sentinel that slipped into the transcript never leaks onto a card.
const SENTINEL = /@@LUBBDUBB_(?:DONE|WAITING:[^@]*)@@/g;

/**
 * Which inbox type an `escalate` tool call's `kind` files as. Unknown or absent
 * kinds fall back to `answer_question` — exactly what the WAITING sentinel
 * produces — so an agent that ignores the field is no worse off than one whose
 * runtime has no tools at all.
 */
export function escalationTypeForAsk(kind: string | undefined): EscalationType {
  switch (kind) {
    case 'approve':
      return 'approve_change';
    case 'choose':
    case 'clarify':
      return 'resolve_ambiguity';
    case 'review':
      return 'review_reply';
    default:
      return 'answer_question';
  }
}

/**
 * The tail of an agent's transcript — the last few non-empty lines that led up
 * to the question. Sentinels are stripped and the result is bounded on both
 * lines and characters so a runaway transcript can't bloat the escalation
 * payload the whole cockpit refetches.
 */
export function recentOutputExcerpt(transcript: string, maxLines = 12, maxChars = 1200): string {
  const lines = transcript
    .replace(SENTINEL, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trimEnd())
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}
