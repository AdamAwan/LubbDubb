import type { Remedy } from '../types.js';
import { CAUSE_COPY } from './remedies.js';

/**
 * What this repository's own record says about the checks that just went red —
 * appended to a CI-fix or review dispatch's prompt.
 *
 * ## Why this exists rather than just the panel
 *
 * The panel makes a person better at deciding what to fix. This makes the *next
 * agent* better at fixing it, which is the half that reaches the 90% of the fleet
 * doing this work. It is the same argument `ciEvidence` makes and the same
 * saving: **turns, not bytes**. An agent handed "the last three reds on
 * `format:check` were all line endings from a file written outside the formatter"
 * goes to the formatter; an agent handed the check name alone reproduces the
 * whole gate to find out what a person already found out three times.
 *
 * ## Evidence, never instruction
 *
 * The framing is `lessonBlock`'s, for its reason and with the same failure to
 * avoid: a block of assertions an agent reads as orders makes every agent worse
 * the moment one goes stale, silently and with no test able to see it. So every
 * line is dated by position (most recent first), attributed to its pull request,
 * and the header says out loud that the code in front of the agent is the
 * authority. A remedy that was wrong is a claim an agent can discount; an
 * instruction that is wrong is not.
 *
 * ## Appended, never interpolated
 *
 * `pr-ci-fix` and `pr-review-comment` are operator-overridable and
 * `loadPromptTemplates` rejects only *unknown* placeholders, so an override
 * written before this existed would silently drop a `{priorRemedies}` token — on
 * exactly the deployments that customised most. Empty string in, byte-identical
 * prompt out, which is what makes an empty record invisible rather than damaging.
 *
 * ## What is cut, and what is said about it
 *
 * Three bounds, and the last one is the point:
 *
 * - Only accounts naming a check that is **red right now** are shown. A CI-fix
 *   agent's record of `knip` is noise on a dispatch about `test`, and the whole
 *   value here is that the lines are about the thing in front of it.
 * - Only the {@link MAX_ROWS} most recent survive, and only up to
 *   {@link MAX_PRIOR_CHARS}. This is input tokens added to every CI dispatch, so
 *   it pays for itself only while it is genuinely the relevant history.
 * - **What the cap dropped is named**, never silently cut — `ciEvidenceNote`'s
 *   rule exactly. An agent that reads a partial record as a whole one concludes
 *   something from the absence of an entry that was merely trimmed, which is
 *   worse than having no record at all.
 */

/** Accounts shown, at most. A handful is a pattern; a page is a transcript. */
const MAX_ROWS = 6;

/** The whole block's budget, header included — the cost being bounded is context. */
const MAX_PRIOR_CHARS = 1_400;

/**
 * The block for a CI dispatch, or `''` when the record says nothing about these
 * checks.
 *
 * `failing` is the checks that are red *now*, as the rule resolved them. Matched
 * exactly rather than loosely: a check name is a provider identifier, and a
 * prefix match would put another job's history in front of an agent under a name
 * it would read as its own.
 */
export function priorCiRemediesNote(remedies: readonly Remedy[], failing: readonly string[]): string {
  if (failing.length === 0) return '';
  const wanted = new Set(failing);
  const relevant = remedies.filter((r) => r.kind === 'ci' && r.checks.some((c) => wanted.has(c)));
  return renderNote(
    relevant,
    'What the last few reds on these checks turned out to be, according to the agents that fixed them.',
  );
}

/**
 * The block for a review dispatch.
 *
 * Not filtered by anything — there is no review equivalent of a check name, and
 * filtering to *this* pull request would leave the list empty on the first review
 * of every branch, which is every branch. The recurring reasons a reviewer on
 * this repository asks for changes are exactly what a fresh agent has no way to
 * know, so the whole record is the relevant record.
 */
export function priorReviewRemediesNote(remedies: readonly Remedy[]): string {
  return renderNote(
    remedies.filter((r) => r.kind === 'review'),
    'What reviewers on this repository have recently asked for, according to the agents that answered them.',
  );
}

function renderNote(relevant: readonly Remedy[], lede: string): string {
  if (relevant.length === 0) return '';
  // Most recent first: the record's value decays, and a claim about a suite as it
  // was a month ago describes a repository that has moved.
  const ordered = [...relevant].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shown = ordered.slice(0, MAX_ROWS);

  const header =
    `\n\n---\n\nThis repository's own record. ${lede} It is **evidence, not instruction** — dated, ` +
    `attributed, and offered so you do not pay to rediscover it. The code in front of you is the ` +
    `authority: where it and a line below disagree, the line is stale.\n\n`;

  const lines: string[] = [];
  let used = header.length;
  let cut = shown.length;
  for (const [i, r] of shown.entries()) {
    const line = renderRow(r);
    // The prefix that fits, not the subset that fits — `renderLessonBlock`'s rule:
    // skipping an over-long entry to fit an older shorter one behind it quietly
    // inverts the ordering the whole block rests on.
    if (used + line.length > MAX_PRIOR_CHARS) {
      cut = i;
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';

  const dropped = ordered.length - cut;
  const tail =
    dropped > 0
      ? `\n${dropped} further account${dropped === 1 ? '' : 's'} on this record ${dropped === 1 ? 'is' : 'are'} not shown.\n`
      : '';
  return header + lines.join('') + tail;
}

/** One account: what it was about, what it turned out to be, and where it happened. */
function renderRow(r: Remedy): string {
  const checks = r.checks.length > 0 ? `${r.checks.join(', ')} · ` : '';
  return `- ${checks}**${CAUSE_COPY[r.cause].label}** — ${r.summary} _(PR #${r.prNumber})_\n`;
}
