/**
 * Pure helpers for enriching escalation context so the cockpit can present
 * enough to answer in-place. Kept dependency-free and unit-tested directly.
 */

// The reserved control strings agents print; stripped from any displayed excerpt
// so a sentinel that slipped into the transcript never leaks onto a card.
const SENTINEL = /@@LUBBDUBB_(?:DONE|WAITING:[^@]*)@@/g;

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
