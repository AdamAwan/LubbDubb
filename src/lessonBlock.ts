import type { Lesson } from './types.js';

/**
 * What promoted lessons look like when an agent reads them (issue #355, phase 3).
 *
 * This is the half the ticket is hedged against: "and then agents know more" is
 * the argument for the whole feature, and the failure it has to avoid is a block
 * of forty stale assertions nobody has read, silently making every agent worse,
 * with no test able to see it. Two properties of this module are what bound
 * that, and neither is decoration:
 *
 * - **The block is claims, not instructions.** Every line carries the goal it was
 *   learned on and the date it was written, and the header says out loud that the
 *   repository is the authority. An agent that finds a lesson contradicted by
 *   what is actually in front of it must be able to discount it — a bare block of
 *   assertions strips exactly the provenance that lets it.
 * - **The cap drops whole lessons, oldest-vouched first.** Half a claim is a
 *   *different* claim, and one an operator never vouched for.
 *
 * Pure, and it takes the cap as an argument rather than reading config, because
 * two callers need the same answer: the launch (which wants the string) and the
 * cockpit (which wants to draw, per row, what is not reaching agents). The drop
 * is *returned* rather than recomputed there — a second implementation of "what
 * fits" would be free to disagree with the one that actually ran.
 *
 * Beside `src/lessons.ts` rather than inside it for that file's own reason: the
 * 2,000-character bound is a rule about what a *claim* may be, and this is a rule
 * about what the *fleet's context* may cost. They move for different reasons.
 */

/** The block, plus which promoted lessons made it in and which the cap left out. */
interface LessonBlock {
  /**
   * What is appended to the system prompt, or `''` when nothing renders — and
   * empty means **empty**: no header, no trailing newline, nothing. With no
   * promoted lessons the launch arguments have to be byte-identical to a build
   * without this feature, which an "empty" block with a header on it is not.
   */
  text: string;
  /** The lessons the block carries, newest-vouched first. */
  rendered: Lesson[];
  /** Promoted lessons the cap left out, in the same order. Never partially rendered. */
  dropped: Lesson[];
}

/**
 * The block's own preamble — fixed text, so it costs the fleet once.
 *
 * It frames what follows as *evidence* rather than as orders, which is the whole
 * safeguard on a surface no test can check the truth of. An agent told "always do
 * X" by a stale line does X; an agent told "an operator vouched for this claim in
 * March, learned on issue 41" can weigh it against the code in front of it and
 * say so.
 */
const BLOCK_HEADER = [
  '',
  'What working this repository has taught the fleet, according to operators who vouched for each',
  'claim below. This is not part of your task and not an instruction: it is prior evidence, dated and',
  'attributed to the goal it was learned on, offered so you do not pay to rediscover it. The',
  'repository in front of you is the authority — where it and a claim disagree, the claim is stale.',
  'Say so in your retrospective when you find one, so an operator can retire it.',
  '',
  '',
].join('\n');

/**
 * Render the promoted lessons that fit into `maxChars`.
 *
 * Takes every lesson and filters to `promoted` itself rather than trusting the
 * caller to have done it: the gate is the reason this store is allowed to exist,
 * and a caller that passed the wrong list would hand agents claims nobody vouched
 * for, which is precisely the failure the three statuses exist to prevent.
 *
 * `maxChars` bounds the **whole** block, header included — the cost being bounded
 * is context, and the header is context. `0` (or less) renders nothing at all,
 * which is how an operator turns the feature off without retiring anything.
 */
export function renderLessonBlock(lessons: Lesson[], maxChars: number): LessonBlock {
  const promoted = lessons.filter((l) => l.status === 'promoted').sort(newestVouchedFirst);
  let text = '';
  // The prefix that fits, not the subset that fits: dropping the oldest-vouched
  // claim is the point of the ordering, and skipping past an over-long lesson to
  // fit an older shorter one behind it would quietly invert it.
  let cut = promoted.length;
  for (const [i, lesson] of promoted.entries()) {
    const next = (text || BLOCK_HEADER) + renderLesson(lesson);
    if (next.length > maxChars) {
      cut = i;
      break;
    }
    text = next;
  }
  return { text, rendered: promoted.slice(0, cut), dropped: promoted.slice(cut) };
}

/**
 * Newest promotion first, so the claim dropped at the cap is the oldest-vouched
 * one — the one most likely to have gone stale.
 *
 * `updatedAt` **is** the promotion time for a promoted row: the only transitions
 * are propose → promote and → retire, and a retired row is not here.
 *
 * Two lessons promoted in the same millisecond are ordinary — an operator ruling
 * on a list, a store whose clock is a fixture — and the tie is resolved by the
 * sort being **stable**, so they keep the order they arrived in. That is a real
 * order rather than an accident: every caller reads them from `listLessons`,
 * which is newest-written first. What it must never be is the row *id*, which is
 * a nanoid: an order that turned on one would differ between two databases
 * holding the same lessons, and a block that differs is a block that never
 * caches.
 */
function newestVouchedFirst(a: Lesson, b: Lesson): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);
}

/**
 * One lesson: the claim, then its provenance on its own line.
 *
 * Continuation lines are indented so a multi-line or markdown lesson stays inside
 * its own bullet — an unindented second paragraph reads as a new claim, and a
 * lesson that swallowed the one under it would be a claim nobody wrote.
 *
 * Nothing here varies per dispatch. Every value comes off the row itself: no goal
 * name, no branch, no agent id, and the date is the lesson's own `createdAt`
 * rather than "now". A block that churns is a block that never caches, and the
 * cache is the entire reason lessons live in the system prompt instead of in the
 * task prompt.
 */
function renderLesson(lesson: Lesson): string {
  const claim = lesson.text
    .trim()
    .split('\n')
    // A blank line inside a lesson stays blank rather than becoming two spaces:
    // trailing whitespace is invisible here and noise in the transcript.
    .map((line, i) => (i === 0 ? `- ${line}` : line.trim() === '' ? '' : `  ${line}`))
    .join('\n');
  const learned = lesson.originRef ? `learned on ${lesson.originRef}` : 'not learned on a goal';
  return `${claim}\n  (${learned}, written ${writtenOn(lesson.createdAt)})\n`;
}

/**
 * The date half of an ISO timestamp. Date rather than instant because the hour a
 * claim was written on is noise to a reader dating it, and because it is one less
 * thing on a line an agent reads before it reads any code.
 */
function writtenOn(createdAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : createdAt;
}
