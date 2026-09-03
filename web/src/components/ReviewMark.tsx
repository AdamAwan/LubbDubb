import { useCallback, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { PrReviewState, PrReviewStatus } from '../types.js';
import { Icon } from './icons.js';
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

/** The tone each status carries, in the shared family's names. */
const TONE: Record<PrReviewStatus, string> = {
  clear: 'rv-clear',
  findings: 'rv-findings',
  routed: 'rv-routed',
  deciding: 'rv-deciding',
  skipped: 'rv-skipped',
  elsewhere: 'rv-elsewhere',
};

/**
 * The badge on the glyph's shoulder, or null where the tint says it all.
 *
 * One slot, three meanings — how many findings, a dash for a review that will not
 * happen, an arrow for one that happened elsewhere. It is a badge rather than a
 * mark drawn *through* the lenses because a stroke across a 15px glyph is mud;
 * this holds at every size a row uses.
 */
function badge(review: PrReviewState): string | null {
  if (review.status === 'findings') return String(review.findings.length);
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
      return `Read ${inMode} — ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}`;
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
 * The mark itself. Null where the deployment has no fleet review, which is what
 * draws nothing at all: a grey "no review" glyph on every row of every default
 * deployment is a claim about a feature nobody turned on.
 *
 * **The one glyph in the cockpit that stands without a written label**, against
 * the rule in `icons.tsx`, and it earns the exception the way the CI ladder does:
 * a dense row of pull requests, one recurring subject, the words one hover away.
 * The `aria-label` carries the same sentence the tooltip heads with, and the
 * tooltip opens on keyboard focus, so the glyph is never the only channel.
 */
export function ReviewMark({
  review,
  now,
  reserve = false,
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
}): JSX.Element | null {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);

  /**
   * Where the tooltip goes, measured rather than declared.
   *
   * The mark is drawn in three places whose room runs out in opposite directions —
   * the rack's rows sit hard against the right edge, the pull-request masthead
   * sits hard against the left and a few pixels under the top of the window — so
   * any one CSS anchoring is a tooltip clipped off-screen on one of them. Fixed
   * positioning also takes it out of every card that clips its own overflow.
   */
  const place = useCallback(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (box === undefined) return;
    const width = 320;
    // From the mark's left edge, so the tooltip opens *into* the page rather than
    // back across whatever the mark is annotating; from its right where that
    // would leave the window, which is the rack's rows.
    const left = Math.max(8, Math.min(box.left - 6, window.innerWidth - width - 8));
    // Below by default, because that is where a tooltip can grow; above only
    // where there is no room below and there is room above.
    const below = window.innerHeight - box.bottom;
    const style: CSSProperties =
      below < 220 && box.top > below
        ? { left, bottom: window.innerHeight - box.top + 8, top: 'auto' }
        : { left, top: box.bottom + 8 };
    setAt(style);
  }, []);

  if (review === undefined) return reserve ? <span className="rv rv-none" aria-hidden="true" /> : null;
  const mark = badge(review);
  const more = reviewSaidMore(review);
  const stamp = review.reviewedAt ?? review.routedAt;
  return (
    <span
      ref={anchor}
      className={`rv ${TONE[review.status]}`}
      tabIndex={0}
      role="img"
      aria-label={`Fleet review: ${reviewSaid(review)}`}
      onMouseEnter={place}
      onFocus={place}
      onMouseLeave={() => setAt(null)}
      onBlur={() => setAt(null)}
    >
      <Icon name="review" size={15} />
      {mark !== null && <span className="rv-badge">{mark}</span>}
      {at !== null && (
        <span className="rv-tip" style={at}>
          <b>{reviewSaid(review)}</b>
          {more !== null && <span className="rv-said">{more}</span>}
          {review.routeReason !== null && review.status !== 'skipped' && (
            <span className="rv-why">
              <i>Routed</i> {review.routeReason}
            </span>
          )}
          {review.findings.length > 0 && (
            <ul>
              {review.findings.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <span className="rv-foot">
            {review.status === 'skipped'
              ? 'The merge is not held — a skip is a decision.'
              : stamp !== null
                ? `${review.reviewedAt !== null ? 'reviewed' : 'routed'} ${relTime(stamp, now)}`
                : 'nothing recorded yet'}
            {review.agentId !== null && ` · ${review.agentId}`}
            {review.headSha !== null && ` · head ${review.headSha.slice(0, 7)}`}
          </span>
        </span>
      )}
    </span>
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
          <span className={`rv-word ${TONE[review.status]}`}>{reviewSaid(review)}</span>
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
        <ul className="rv-found">
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
