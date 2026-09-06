import type { EscalationType } from '../types.js';

// → docs/spec/05-dispatcher.md

const SENTINEL = /@@LUBBDUBB_(?:DONE|WAITING:[^@]*)@@/g;

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

export function recentOutputExcerpt(transcript: string, maxLines = 12, maxChars = 1200): string {
  const lines = transcript
    .replace(SENTINEL, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trimEnd())
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}
