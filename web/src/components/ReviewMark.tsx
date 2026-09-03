import type { JSX } from 'react';
import type { PrReviewState, PrReviewStatus } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';
import { relTime } from './util.js';

/**
 * The fleet review, on a pull request's row and in its masthead: one glyph,
 * tinted by what the reviewer said, with everything it knows in the tooltip.
 *
 * **Shared components rather than console markup**, because the same reading is
 * drawn on three surfaces — the goal page's PR rows, the pull-request page's
 * masthead and its rail card — and a mark written three times is three chances
 * for one of them to say something the record does not. They style themselves
 * through `styles.css` tokens only, which is the contract for anything under
 * `components/` (`console.css` owns `.cn` and touches no shared class).
 *
 * **Nothing here decides anything.** Every arm is a rendering of
 * `PrReviewState`, folded once by `src/review/prReviewState.ts` off the rows the
 * merge gate itself reads — a second opinion taken in the browser is the drift
 * that outlives the change introducing it.
 * → `docs/spec/17-cockpit.md#the-fleet-reviews-mark`
 */

/**
 * The tone each status carries: the arm's own class, which is what the badge and
 * the word hang off, beside the shared family's tone alias, which is where the
 * hue, the border and the fill come from. Two classes rather than one because the
 * mark is the only thing here with descendants — the badge is tinted *by* the arm
 * — while the triple itself is the tag's, written once.
 * → docs/spec/17-cockpit.md#the-tag
 */
const TONE: Record<PrReviewStatus, string> = {
  clear: 'rv-clear t-green',
  findings: 'rv-findings t-red',
  routed: 'rv-routed t-amber',
  deciding: 'rv-deciding t-blue',
  skipped: 'rv-skipped',
  elsewhere: 'rv-elsewhere',
};

/**
 * The tone, which is the status' own except on one arm: findings somebody has
 * **dealt with** read green rather than red.
 *
 * The verdict is unchanged — the reviewer found four things and always will have
 * — but the mark is a call to look, and a row that keeps shouting after the thing
 * was handled is a row an operator learns to stop reading. What "dealt with"
 * means is the record, not a count of anything: the thread the fleet published
 * the findings into is resolved (`PrReviewState.addressed`).
 */
function tone(review: PrReviewState): string {
  return review.addressed ? TONE.clear : TONE[review.status];
}

/**
 * The badge on the glyph's shoulder, or null where the tint says it all.
 *
 * One slot, four meanings — how many findings, a tick where they have been dealt
 * with, a dash for a review that will not happen, an arrow for one that happened
 * elsewhere. It is a badge rather than a mark drawn *through* the lenses because a
 * stroke across a 15px glyph is mud; this holds at every size a row uses.
 */
function badge(review: PrReviewState): string | null {
  if (review.status === 'findings') return review.addressed ? '✓' : String(review.findings.length);
  if (review.status === 'skipped') return '–';
  if (review.status === 'elsewhere') return '↗';
  return null;
}

/** What the mark claims, in one line — the tooltip's heading and its accessible name. */
function reviewSaid(review: PrReviewState): string {
  const inMode = review.mode === null ? 'by the fleet' : `in ${review.mode} mode`;
  switch (review.status) {
    case 'clear':
      return `Read ${inMode} — clear`;
    case 'findings':
      return (
        `Read ${inMode} — ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}` +
        (review.addressed ? ', addressed' : '')
      );
    case 'routed':
      return review.mode === null ? 'Not yet reviewed by the fleet' : `Routed to ${review.mode} — not read yet`;
    case 'deciding':
      return 'Deciding how thoroughly to review it';
    case 'skipped':
      return 'Triage skipped the review';
    case 'elsewhere':
      return 'Reviewed outside the harness';
  }
}

/** The sentence under the heading: what was read, or why nothing will be. */
function reviewSaidMore(review: PrReviewState): string | null {
  switch (review.status) {
    case 'clear':
    case 'findings':
      return review.summary;
    case 'routed':
      return 'The triage chose the mode; the reviewer has not run.';
    case 'deciding':
      return 'A desk agent is choosing how thoroughly to read it, from the title, branch and base — no diff, no worktree.';
    case 'skipped':
      return review.routeReason;
    case 'elsewhere':
      return 'A check outside the harness reported this reviewed, so the fleet will not read it.';
  }
}

/**
 * How many findings the tooltip lists before it stops counting.
 *
 * A review's findings are written for a person reading the pull request, so each
 * one is a paragraph — four of them filled the tooltip past the height of the
 * window it was hovering in, and the heading it started with scrolled off the top.
 * The tooltip's job on a dense rack is to say *what this mark means*; the reading
 * itself belongs on the page the mark now opens.
 */
const TIP_FINDINGS = 2;

/**
 * The mark itself. Null where the deployment has no fleet review, which is what
 * draws nothing at all: a grey "no review" glyph on every row of every default
 * deployment is a claim about a feature nobody turned on.
 *
 * **The one glyph in the cockpit that stands without a written label**, against
 * the rule in `icons.tsx`, and it earns the exception the way `AgentOnIt` does: a
 * dense rack of pull requests, one recurring subject, the words one hover away.
 * The checks beside it are a *chip* and carry their name, because they are the
 * reading an operator has to act on and the one nobody should have to learn.
 * The `aria-label` carries the same sentence the tooltip heads with, and the
 * tooltip opens on keyboard focus, so the glyph is never the only channel.
 *
 * **The tooltip is a summary and the page is the record.** Given `onOpen` the mark
 * is a button onto the pull request's own page, where `ReviewDetail` draws the
 * same reading at full length — so the hover can be two findings and a line about
 * when, rather than the whole review in a 320px box that no pointer can reach into
 * and nothing can scroll. The two are one component precisely so they cannot come
 * to word one record differently.
 */
export function ReviewMark({
  review,
  now,
  reserve = false,
  onOpen,
}: {
  review: PrReviewState | undefined;
  now?: number;
  /**
   * Keep the mark's width where this row has no reading but its neighbours do —
   * a list whose glyphs are a column reads as one, and a row that collapses the
   * slot bends the column around it. Off by default, so a deployment with the
   * review off pays no gutter for a feature it does not have.
   */
  reserve?: boolean;
  /**
   * Open the pull request's page, where the whole reading is. Omitted on the
   * masthead of that very page — a control that goes where you already are is a
   * dead click — and on any surface that has nowhere to send you.
   */
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();

  if (review === undefined) return reserve ? <span className="rv rv-none" aria-hidden="true" /> : null;
  const mark = badge(review);
  const more = reviewSaidMore(review);
  const stamp = review.reviewedAt ?? review.routedAt;
  const shown = review.findings.slice(0, TIP_FINDINGS);
  const rest = review.findings.length - shown.length;
  // A button where there is somewhere to go, a span where there is not — rather
  // than a span with a click handler, which is a control no keyboard reaches and
  // no screen reader announces. Both carry the same tooltip and the same
  // accessible name; only the element and the cursor differ.
  const Tag = onOpen === undefined ? 'span' : 'button';
  return (
    <Tag
      ref={tip.anchor as never}
      className={`rv ${tone(review)}${onOpen === undefined ? '' : ' rv-open'}`}
      {...(onOpen === undefined ? { tabIndex: 0, role: 'img' as const } : { type: 'button' as const, onClick: onOpen })}
      aria-label={`Fleet review: ${reviewSaid(review)}${onOpen === undefined ? '' : ' — open the pull request'}`}
      onMouseEnter={tip.open}
      onFocus={tip.open}
      onMouseLeave={tip.close}
      onBlur={tip.close}
    >
      <Icon name="review" size={15} />
      {mark !== null && <span className="rv-badge">{mark}</span>}
      {tip.at !== null && (
        <Tip at={tip.at}>
          <b>{reviewSaid(review)}</b>
          {more !== null && <span className="rv-said">{more}</span>}
          {shown.length > 0 && (
            <ul className="rv-list">
              {shown.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {rest > 0 && <span className="rv-more">{`and ${rest} more`}</span>}
          <span className="rv-foot">
            {review.status === 'skipped'
              ? 'a skip is a decision — the merge is not held'
              : stamp !== null
                ? `${review.reviewedAt !== null ? 'reviewed' : 'routed'} ${relTime(stamp, now)}`
                : 'nothing recorded yet'}
            {onOpen !== undefined && ' · click for the whole reading'}
          </span>
        </Tip>
      )}
    </Tag>
  );
}

/**
 * The same record at full length, for the pull-request page: the mode, why the
 * triage chose it, what the reviewer understood the diff to do, and what it
 * found. The chrome around it belongs to whichever surface draws it — this is the
 * content, so the console keeps its own card vocabulary and the shared layer
 * keeps its own tokens.
 */
export function ReviewDetail({ review, now }: { review: PrReviewState; now?: number }): JSX.Element {
  const more = reviewSaidMore(review);
  return (
    <div className="rv-detail">
      <dl>
        <dt>Verdict</dt>
        <dd>
          {/* The same tone the mark takes, `addressed` included: the card and the
              glyph are one record, and a verdict drawn red beside a green mark is
              the two surfaces disagreeing in the smallest possible way. */}
          <span className={`rv-word ${tone(review)}`}>{reviewSaid(review)}</span>
        </dd>
        {review.mode !== null && (
          <>
            <dt>Mode</dt>
            <dd>{review.mode}</dd>
          </>
        )}
        {review.routeReason !== null && (
          <>
            <dt>Why</dt>
            <dd className="rv-quiet">{review.routeReason}</dd>
          </>
        )}
        {more !== null && (
          <>
            <dt>Read</dt>
            <dd className="rv-quiet">{more}</dd>
          </>
        )}
      </dl>
      {review.findings.length > 0 && (
        // The bars follow the verdict word above them: red while the findings
        // stand, green once the thread they were published into is resolved. Two
        // colours saying opposite things about one record is the smallest way for
        // a card to contradict itself.
        <ul className={`rv-found${review.addressed ? ' rv-found-done' : ''}`}>
          {review.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <p className="rv-detail-foot">
        {review.reviewedAt !== null && `reviewed ${relTime(review.reviewedAt, now)}`}
        {review.reviewedAt !== null && review.headSha !== null && ` at ${review.headSha.slice(0, 7)}`}
        {review.agentId !== null && ` · ${review.agentId}`}
        {review.routedAt !== null && ` · routed ${relTime(review.routedAt, now)}`}
        {review.routeAgentId !== null && ` by ${review.routeAgentId}`}
      </p>
    </div>
  );
}
