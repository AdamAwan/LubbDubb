import type { JSX } from 'react';
import type {
  ThroughputBucket,
  ThroughputConversation,
  ThroughputInsights,
  ThroughputLanding,
  ThroughputSubject,
  ThroughputTotal,
} from '../types.js';
import { relTime } from './util.js';
import { fmtDuration, fmtRate, PLOT } from './insightsFormat.js';
import { toCsv } from './Downloads.js';
import { Ref } from './refs.js';
import { Label } from './label.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/17-cockpit.md

export function ThroughputTab({ insights }: { insights: ThroughputInsights }): JSX.Element {
  const { totals, landing, conversation } = insights;
  const anything = totals.some((t) => t.count > 0);
  if (!anything) {
    return (
      <p className="empty">
        The world did nothing this harness could see in this window — no pull request opened, merged or commented on,
        and no issue opened or closed.
      </p>
    );
  }

  return (
    <div className="tp">
      <Tiles insights={insights} />

      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">Pull requests</p>
          <PrTimeline insights={insights} />
          <Method insights={insights} />
        </section>
        <section className="sp-col">
          <p className="sp-sub">Review conversation</p>
          <TalkTimeline insights={insights} />
          <p className="sp-sub">Busiest pull requests</p>
          <Busiest insights={insights} />
        </section>
      </div>

      <p className="sp-sub">Everything counted</p>
      <Totals totals={totals} landing={landing} conversation={conversation} />
    </div>
  );
}

export function throughputCsv(insights: ThroughputInsights): string {
  const { totals, landing, conversation, busiest, timeline } = insights;
  return toCsv([
    ['Tallies'],
    ['Measure', 'Count', 'Per day'],
    ...totals.map((t) => [t.label, t.count, t.perDay]),
    [],

    ['Landing'],
    ['Measure', 'Value'],
    ['PRs opened', landing.opened],
    ['PRs settled', landing.settled],
    ['PRs merged', landing.merged],
    ['PRs abandoned', landing.abandoned],
    ['Merge rate', landing.mergeRate],
    ['PRs opened and settled inside the window', landing.paired],
    ['Median opened to merged (ms)', landing.medianToMergeMs],
    ['Slowest opened to merged (ms)', landing.slowestToMergeMs],
    ['Review comments seen', conversation.received],
    ['Replies the fleet sent', conversation.replied],
    ['Replies per comment', conversation.replyRate],
    ['PRs that drew a comment', conversation.prsCommented],
    ['PRs touched at all', insights.prsTouched],
    ['Window', insights.window.label],
    ['Window opened (ISO)', insights.window.since ?? 'no lower bound — all time'],
    ['The merge rate denominator is', 'PRs that settled in the window, not PRs opened in it'],
    ['An opened event means', 'the pull request first appeared in the world model, not that it was created'],
    ['A reply is counted', 'from pr_replies_sent — one row per reply that actually left through the sink'],
    ['Generated (ISO)', insights.generatedAt],
    [],

    ['Over time'],
    ['Bucket start (ISO)', 'Opened', 'Merged', 'Abandoned', 'Comments', 'Replies'],
    ...timeline.buckets.map((b) => [b.startsAt, b.opened, b.merged, b.closed, b.comments, b.replies]),
    [],

    ['Busiest pull requests'],
    ['Ref', 'PR', 'Comments', 'Replies', 'Merged', 'Opened to merged (ms)', 'Last (ISO)'],
    ...busiest.map((s) => [
      s.ref,
      s.prNumber,
      s.commentsReceived,
      s.repliesSent,
      s.merged ? 'yes' : 'no',
      s.toMergeMs,
      s.lastAt,
    ]),
  ]);
}

function perDay(total: ThroughputTotal): string {
  if (total.perDay === null) return '—';
  if (total.perDay === 0) return '0';
  return total.perDay < 1 ? total.perDay.toFixed(1) : String(Math.round(total.perDay * 10) / 10);
}

function countOf(totals: readonly ThroughputTotal[], measure: string): ThroughputTotal | undefined {
  return totals.find((t) => t.measure === measure);
}

function Tiles({ insights }: { insights: ThroughputInsights }): JSX.Element {
  const { totals, landing, conversation } = insights;
  const merged = countOf(totals, 'pr-merged');
  const closedIssues = countOf(totals, 'issue-closed');
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well">
        <Label dense>PRs merged</Label>
        <span className="vl">{landing.merged}</span>
        <span className="sb">
          {merged === undefined || merged.perDay === null ? 'over this window' : `${perDay(merged)} a day`}
          {landing.opened > 0 && ` · ${landing.opened} opened`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Merge rate</Label>
        <span className="vl">{fmtRate(landing.mergeRate)}</span>
        <span className="sb">
          {landing.settled === 0
            ? 'nothing settled in this window'
            : `${landing.merged} of ${landing.settled} settled · ${landing.abandoned} abandoned`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Opened to merged</Label>
        <span className="vl">{fmtDuration(landing.medianToMergeMs)}</span>
        <span className="sb">
          {landing.paired === 0
            ? 'nothing both opened and merged in this window'
            : `median of ${landing.paired} · slowest ${fmtDuration(landing.slowestToMergeMs)}`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Review comments</Label>
        <span className="vl">{conversation.received}</span>
        <span className="sb">
          {conversation.received === 0
            ? 'nothing was commented on'
            : `on ${conversation.prsCommented} PR${conversation.prsCommented === 1 ? '' : 's'} · ${
                conversation.replied
              } repl${conversation.replied === 1 ? 'y' : 'ies'} sent`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Issues closed</Label>
        <span className="vl">{closedIssues?.count ?? 0}</span>
        <span className="sb">
          {countOf(totals, 'issue-opened')?.count ?? 0} opened · {countOf(totals, 'pr-approved')?.count ?? 0} approval
          {(countOf(totals, 'pr-approved')?.count ?? 0) === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}

interface Plot {
  x: (index: number) => number;
  w: number;
  y: (value: number) => number;
}

function plot(buckets: readonly ThroughputBucket[], top: number): Plot {
  const width = (PLOT.right - PLOT.left) / Math.max(1, buckets.length);
  const height = PLOT.bottom - PLOT.top;
  return {
    x: (index: number) => PLOT.left + index * width + 1.5,
    w: Math.max(1, width - 3),
    y: (value: number) => PLOT.bottom - (value / top) * height,
  };
}

function Axis({ top, buckets }: { top: number; buckets: number }): JSX.Element {
  const height = PLOT.bottom - PLOT.top;
  const width = (PLOT.right - PLOT.left) / Math.max(1, buckets);
  return (
    <>
      <g stroke="var(--border-lo)" strokeWidth="1">
        {[0, 0.5, 1].map((f) => (
          <path key={f} d={`M${PLOT.left} ${PLOT.top + f * height}H${PLOT.right}`} />
        ))}
      </g>
      <g className="sp-axis" textAnchor="end">
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={PLOT.left - 7} y={PLOT.top + f * height + 3}>
            {Math.round(top * (1 - f))}
          </text>
        ))}
      </g>
      <g className="sp-axis" textAnchor="middle">
        <text x={PLOT.left + width / 2} y="170">
          window opens
        </text>
        <text x={PLOT.right - width / 2} y="170">
          now
        </text>
      </g>
    </>
  );
}

/* Settled work is stacked, because merged and abandoned are two ends of one
   population and their sum is the bar an operator reads. Opened is a line over
   it rather than a third segment: it is a different population — what came in,
   not what went out — and stacking it would make the bar a total of nothing. */
function PrTimeline({ insights }: { insights: ThroughputInsights }): JSX.Element {
  const { buckets } = insights.timeline;
  const top = Math.max(1, ...buckets.map((b) => Math.max(b.merged + b.closed, b.opened)));
  const p = plot(buckets, top);
  const line = buckets.map((b, i) => `${p.x(i) + p.w / 2},${p.y(b.opened)}`).join(' ');
  return (
    <div className="sp-graph sp-well">
      <svg
        viewBox="0 0 620 176"
        role="img"
        aria-label={`Pull requests over ${buckets.length} buckets: ${insights.landing.opened} opened, ${insights.landing.merged} merged, ${insights.landing.abandoned} abandoned`}
      >
        <Axis top={top} buckets={buckets.length} />
        {buckets.map((b, i) => (
          <g key={b.startsAt} opacity={i === buckets.length - 1 ? 1 : 0.78}>
            <rect
              x={p.x(i)}
              y={p.y(b.merged)}
              width={p.w}
              height={PLOT.bottom - p.y(b.merged)}
              fill="var(--tp-pr-merged)"
            >
              <title>{`${b.merged} merged — from ${new Date(b.startsAt).toLocaleString()}`}</title>
            </rect>
            <rect
              x={p.x(i)}
              y={p.y(b.merged + b.closed)}
              width={p.w}
              height={PLOT.bottom - p.y(b.closed)}
              fill="var(--tp-pr-closed)"
            >
              <title>{`${b.closed} abandoned — from ${new Date(b.startsAt).toLocaleString()}`}</title>
            </rect>
          </g>
        ))}
        <polyline points={line} fill="none" stroke="var(--tp-pr-opened)" strokeWidth="2" />
      </svg>
      <p className="tp-key">
        <span className="sw" style={{ background: 'var(--tp-pr-merged)' }} /> merged
        <span className="sw" style={{ background: 'var(--tp-pr-closed)' }} /> abandoned
        <span className="sw" style={{ background: 'var(--tp-pr-opened)' }} /> opened
      </p>
    </div>
  );
}

function TalkTimeline({ insights }: { insights: ThroughputInsights }): JSX.Element {
  const { buckets } = insights.timeline;
  const top = Math.max(1, ...buckets.map((b) => b.comments + b.replies));
  const p = plot(buckets, top);
  return (
    <div className="sp-graph sp-well">
      <svg
        viewBox="0 0 620 176"
        role="img"
        aria-label={`Review conversation over ${buckets.length} buckets: ${insights.conversation.received} comments in, ${insights.conversation.replied} replies out`}
      >
        <Axis top={top} buckets={buckets.length} />
        {buckets.map((b, i) => (
          <g key={b.startsAt} opacity={i === buckets.length - 1 ? 1 : 0.78}>
            <rect
              x={p.x(i)}
              y={p.y(b.comments)}
              width={p.w}
              height={PLOT.bottom - p.y(b.comments)}
              fill="var(--tp-review-received)"
            >
              <title>{`${b.comments} review comments — from ${new Date(b.startsAt).toLocaleString()}`}</title>
            </rect>
            <rect
              x={p.x(i)}
              y={p.y(b.comments + b.replies)}
              width={p.w}
              height={PLOT.bottom - p.y(b.replies)}
              fill="var(--tp-reply-sent)"
            >
              <title>{`${b.replies} replies sent — from ${new Date(b.startsAt).toLocaleString()}`}</title>
            </rect>
          </g>
        ))}
      </svg>
      <p className="tp-key">
        <span className="sw" style={{ background: 'var(--tp-review-received)' }} /> comments in
        <span className="sw" style={{ background: 'var(--tp-reply-sent)' }} /> replies out
      </p>
    </div>
  );
}

function Busiest({ insights }: { insights: ThroughputInsights }): JSX.Element {
  const { busiest, conversation } = insights;
  if (busiest.length === 0) return <p className="empty">No pull request drew a comment or a reply in this window.</p>;
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Pull request</th>
          <th className="n">In</th>
          <th className="n">Out</th>
          <th className="n">Last</th>
        </tr>
      </thead>
      <tbody>
        {busiest.map((s: ThroughputSubject) => (
          <tr key={s.ref}>
            <td>
              <span className="nm">{s.prNumber === null ? <Ref to={s.ref} /> : <Ref to={`pr:${s.prNumber}`} />}</span>
              <span className="bl">
                {s.merged
                  ? `merged${s.toMergeMs === null ? '' : ` after ${fmtDuration(s.toMergeMs)}`}`
                  : s.closed
                    ? 'closed without merging'
                    : s.opened
                      ? 'opened in this window'
                      : 'still open'}
              </span>
            </td>
            <td className="n b">{s.commentsReceived}</td>
            <td className="n">{s.repliesSent}</td>
            <td className="n">{relTime(s.lastAt)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4} className="bl">
            The {busiest.length} busiest of {conversation.prsCommented} pull requests that drew a comment.
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function Totals({
  totals,
  landing,
  conversation,
}: {
  totals: readonly ThroughputTotal[];
  landing: ThroughputLanding;
  conversation: ThroughputConversation;
}): JSX.Element {
  const peak = Math.max(1, ...totals.map((t) => t.count));
  return (
    <table className="sp-tbl wide">
      <thead>
        <tr>
          <th>Measure</th>
          <th className="n">Count</th>
          <th className="bar">Against the busiest</th>
          <th className="n">A day</th>
          <th className="n">Rate</th>
        </tr>
      </thead>
      <tbody>
        {totals.map((t) => (
          <tr key={t.measure}>
            <td>
              <span className="nm" title={t.blurb}>
                {t.label}
                {t.ours && <span className="tp-ours">the fleet’s own</span>}
              </span>
              <span className="bl">{t.blurb}</span>
            </td>
            <td className="n b">{t.count}</td>
            <td className="bar">
              <span className="rl-rate">
                <span
                  className="sg"
                  style={{ width: `${(t.count / peak) * 100}%`, background: `var(--tp-${t.measure})` }}
                />
              </span>
            </td>
            <td className="n">{perDay(t)}</td>
            <td className="n">
              {t.measure === 'pr-merged'
                ? fmtRate(landing.mergeRate)
                : t.measure === 'reply-sent'
                  ? fmtRate(conversation.replyRate)
                  : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Method({ insights }: { insights: ThroughputInsights }): JSX.Element {
  return (
    <MethodNote>
      <p>
        Counts, never money — what the fleet <i>spent</i> producing this is the Economics tab, and a second opinion
        about it here would be one more figure to reconcile. <b>Opened</b> means the pull request first appeared in this
        harness&apos;s world model, which is not always when it was created: one that entered the watched set later —
        relabelled, or the watch widened — reads as opened on the cycle that first saw it. The <b>merge rate</b> is over
        what <i>settled</i> — {insights.landing.merged} merged and {insights.landing.abandoned} abandoned — not over
        what opened, because the two are different populations and a window that opens mid-flight would otherwise report
        a rate above one. <b>Replies sent</b> is the only row here that is unambiguously this fleet&apos;s: it is read
        from the record of replies that left through the sink, and every other row counts what the world did, whoever
        did it.
      </p>
    </MethodNote>
  );
}
