import type { MirroredTicket } from '../store/tickets.js';

/**
 * The tracker items a filing agent should look at before it writes a new one
 * (issue #394).
 *
 * ## Why the harness shortlists rather than the agent searching
 *
 * Every filing prompt used to open with "search the existing open items for the
 * same thing", which is an instruction to go and do a cold search of a tracker the
 * agent reaches through a CLI — several turns, and the quality of it depends
 * entirely on the query the model happens to try. Meanwhile the harness keeps a
 * **local mirror** of the tracker (`src/tickets/sweep.ts`, issue #329) and holds
 * the open world besides. The candidates are computable, so computing them is
 * strictly better than asking: the agent starts from a list instead of a search
 * box, and what it was shown is in the prompt where anyone can read it afterwards.
 *
 * ## Why it is a shortlist and not a verdict
 *
 * Title-token overlap finds items worth *reading*; it does not decide that two
 * reports are the same thing, which needs both bodies and is exactly the judgement
 * the agent is kept for. So a candidate list is never empty-meaning-none — it is
 * "here is what looked adjacent", and the agent is told that plainly.
 *
 * Closed items are candidates too. A finding that duplicates a ticket somebody
 * closed last week is worth knowing about, and the mirror is the only place the
 * harness can see one at all: the world is open items by definition.
 */

/** Words that appear in every ticket title and so separate nothing. */
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

/** Terms worth matching on: lowercased, punctuation-free, no stopwords, no noise. */
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * The mirrored items whose titles share the most terms with `subject`, best first.
 *
 * Pure, so what an agent is shown is testable without a tracker or a server. An
 * item sharing nothing is dropped rather than ranked last: a list padded to a fixed
 * length with unrelated tickets teaches the reader to ignore the list.
 */
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

/**
 * The block appended to a filing prompt — **appended**, never interpolated into
 * it. A `{candidates}` placeholder would be dropped silently by every prompt
 * override that never learned about it, on exactly the deployments that customised
 * most; appending has no fallback to get wrong. → `CLAUDE.md`, "Prompts and
 * templates".
 *
 * Null when nothing looked adjacent, so the prompt says nothing rather than
 * printing an empty heading the agent has to interpret. That silence is honest:
 * the mirror can also be mid-backfill, which is why the wording never claims the
 * list is exhaustive.
 */
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
