import type { MirroredTicket } from '../store/tickets.js';

// → docs/spec/13-jobs-and-tickets.md

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'when',
  'what',
  'does',
  'not',
  'are',
  'was',
  'has',
  'have',
  'its',
  'their',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'is',
  'it',
  'be',
  'by',
  'as',
  'at',
  'or',
]);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function dedupeCandidates(
  items: readonly MirroredTicket[],
  subject: string,
  limit = 8,
): readonly MirroredTicket[] {
  const wanted = terms(subject);
  if (wanted.size === 0) return [];
  return items
    .map((item) => {
      const have = terms(item.title);
      let score = 0;
      for (const w of wanted) if (have.has(w)) score++;
      return { item, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.item.number - a.item.number)
    .slice(0, limit)
    .map((c) => c.item);
}

export function renderCandidates(candidates: readonly MirroredTicket[]): string | null {
  if (candidates.length === 0) return null;
  const rows = candidates.map((c) => `- issue:${c.number} (${c.state}) — ${c.title}`).join('\n');
  return (
    "Existing tracker items that look adjacent to this one, from the harness's own mirror of the " +
    'tracker — you do not need to go searching:\n\n' +
    `${rows}\n\n` +
    'They are ranked by title overlap alone, so read the ones that could be the same thing before ' +
    'you write yours. The list is neither exhaustive nor a verdict: if one of these already covers ' +
    'this, link it instead of filing a second; if none does, file.'
  );
}
