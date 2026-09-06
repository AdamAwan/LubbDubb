import type { JSX } from 'react';
import type { PrReviewState, PrReviewStatus } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';
import { relTime } from './util.js';

// → docs/spec/17-cockpit.md

const TONE: Record<PrReviewStatus, string> = {
  clear: 'rv-clear t-green',
  findings: 'rv-findings t-red',
  routed: 'rv-routed',
  deciding: 'rv-deciding t-blue',
  skipped: 'rv-skipped',
  elsewhere: 'rv-elsewhere',
};

function tone(review: PrReviewState): string {
  return review.addressed ? TONE.clear : TONE[review.status];
}

function badge(review: PrReviewState): string | null {
  if (review.status === 'findings') return review.addressed ? '✓' : String(review.findings.length);
  if (review.status === 'skipped') return '–';
  if (review.status === 'elsewhere') return '↗';
  return null;
}

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

const TIP_FINDINGS = 2;

export function ReviewMark({
  review,
  now,
  reserve = false,
  onOpen,
}: {
  review: PrReviewState | undefined;
  now?: number;
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();

  if (review === undefined) return reserve ? <span className="rv rv-none" aria-hidden="true" /> : null;
  const mark = badge(review);
  const more = reviewSaidMore(review);
  const stamp = review.reviewedAt ?? review.routedAt;
  const shown = review.findings.slice(0, TIP_FINDINGS);
  const rest = review.findings.length - shown.length;
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
