/**
 * What a lesson is allowed to be — the bound both writers share (issue #355).
 *
 * There are two writers as of phase 2: the operator typing into the cockpit, and
 * the retrospective proposing what its run taught. A bound written twice is a
 * bound that drifts, and it drifts in the direction that matters — whichever
 * writer is looser decides what an operator ends up being asked to read.
 *
 * Here rather than in `src/store/lessons.ts` because it is a rule about the
 * claim, not about the table: SQLite does not care how long the text is, and the
 * store would be the wrong place to look for the reason it is capped.
 */

/**
 * How long a lesson may be. Not a storage bound but a *readability* one: every
 * safeguard on this surface rests on a person having actually read the row before
 * promoting it, and a wall of text is the row nobody reads. Roughly a short
 * paragraph, which is what a lesson is.
 */
export const MAX_LESSON_CHARS = 2_000;

/**
 * Normalise one lesson, or say why it is not one.
 *
 * The caller decides what a refusal costs — the operator's route turns it into a
 * 400 the person retypes against, while a retrospective drops the lesson and
 * keeps the submission. Both need the same answer to "is this a lesson", which is
 * the whole reason it is a function rather than two `if`s.
 */
export function validateLessonText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return { ok: false, error: 'text is required' };
  if (text.length > MAX_LESSON_CHARS)
    return { ok: false, error: `text must be ${MAX_LESSON_CHARS} characters or fewer — a lesson is a line or two` };
  return { ok: true, text };
}
