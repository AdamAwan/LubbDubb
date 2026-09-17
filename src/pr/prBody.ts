import { PLAINNESS, plainnessRefusal, readingEase } from '../reviewPacks/plainness.js';

// → docs/spec/07-pull-requests.md#the-body-is-not-templated

export const PR_BODY = {
  bullets: 5,
  bulletChars: 100,
} as const;

/**
 * What a pull-request body is refused for, or null if it is five plain bullets.
 *
 * The shape the `body` argument describes, asserted rather than asked for. Every
 * arm names the exact line it caught, so the refusal is a fix rather than a
 * re-read of the description.
 */
export function prBodyRefusal(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return null;

  const stray = lines.find((l) => !/^[-*]\s+/.test(l));
  if (stray !== undefined) {
    return (
      `every line of the body is a bullet and this one is not: "${stray}". No headings and no prose ` +
      `paragraphs — a reviewer reads this before the diff, not instead of it.`
    );
  }
  if (lines.length > PR_BODY.bullets) {
    return (
      `the body has ${lines.length} bullets and the limit is ${PR_BODY.bullets}. Say why the change is ` +
      `needed first and what it does after, and leave the rest to the diff.`
    );
  }
  const long = lines.find((l) => l.length > PR_BODY.bulletChars);
  if (long !== undefined) {
    return (
      `a bullet runs ${long.length} characters and the limit is ${PR_BODY.bulletChars}. One line each: a ` +
      `bullet that needs a second line is a paragraph wearing a dash. Was: "${long}"`
    );
  }
  for (const [i, line] of lines.entries()) {
    const refusal = plainnessRefusal(`bullet ${i + 1}`, line);
    if (refusal !== null) return refusal;
  }
  const { ease: score, hardest } = readingEase(lines);
  if (score < PLAINNESS.readingEase) {
    return (
      `the body scores ${Math.round(score)} for reading ease and the floor is ${PLAINNESS.readingEase}, about ` +
      `a newspaper. Long words cost more than long sentences: use the plainest word that is still true, and ` +
      `put the identifiers in the code rather than the prose. These read hardest:\n` +
      hardest.map((s) => `- "${s}"`).join('\n')
    );
  }
  return null;
}
