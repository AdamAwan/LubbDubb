import type { JSX } from 'react';
import type { SpendPhase, SpendTrend, SpendTrendComparison, SpendTrendPhaseShift, SpendTrendBucket } from '../types.js';
import { fmtTokens, fmtUsd } from './util.js';
import { Label } from './label.js';

/**
 * The trend behind the breakdown: three questions on one axis.
 *
 * The breakdown answers *where the money went* and every table on it is
 * all-time. This answers the question an operator has while actively trying to
 * spend less — **is what I did working** — which a total over time cannot, since
 * cost falls when a fleet is idle exactly as readily as when it is efficient.
 *
 * Three sections, in the order the questions arrive, and the shared axis is the
 * whole design: every chart is the same eight weeks at the same x, so a change
 * that shows up in one is read against the other two without a click.
 *
 * 1. **Are goals getting cheaper** — median cost of the goals that closed each
 *    week, with every goal drawn as a point beside it. The spread is drawn rather
 *    than summarised because goals differ in size, and a median alone would let a
 *    week that happened to close three small goals read as progress.
 * 2. **Which stages moved** — the cohort's phase split as a share band, and the
 *    same shift as **dollars** in the table beneath it. Both, always: a share
 *    column alone cannot tell planning-more-to-review-less from planning more for
 *    nothing, and that distinction is the reason this tab exists.
 * 3. **Did it still land** — completion rate and red checks per goal on the same
 *    weeks, plus the reading none of the others can make: goals that closed and
 *    came back. A fleet that got cheaper by giving up earlier looks like progress
 *    everywhere else here.
 *
 * The panel draws figures and never derives them. Medians, the two halves and
 * the phase shift are all `buildSpendTrend`'s — a second implementation of "the
 * median goal" a tab away from the first is exactly the disagreement the spend
 * module opens by refusing to have about a goal's cost.
 */

/** Reading order, matching the breakdown's — the legend and the band agree by construction. */
const PHASE_ORDER: readonly SpendPhase[] = [
  'deliberation',
  'build',
  'ci',
  'landing',
  'evidence',
  'obstacle',
  'job',
  'other',
];

/**
 * The plot box every chart shares, so one week sits at one x on all three — and
 * the viewBox they all draw into, which must be shared for the same reason. Two
 * charts at different widths scale to the same container at different rates, and
 * the shared axis this tab is built on quietly stops being shared.
 *
 * The right margin is wider than the box needs because one chart has a second
 * axis out there. Paying for it on all three is what keeps them aligned.
 */
const PLOT = { left: 44, right: 600, top: 12, bottom: 128 };
const VIEW_BOX = '0 0 646 150';

/**
 * What one bar on this axis is called.
 *
 * The axis is **eight of whatever window the page is set to**, so the word is
 * the window's rather than a fixed "week": at 24h the bars are days, at 7d they
 * are weeks. Derived from the shipped bucket length rather than from the key,
 * because the unbounded window's period is computed from the history the
 * deployment actually has and has no key to look up.
 */
function periodWord(trend: SpendTrend): string {
  const hours = trend.bucketMs / 3_600_000;
  if (hours <= 12) return `${Math.round(hours)}h period`;
  if (hours <= 36) return 'day';
  if (hours <= 24 * 10) return 'week';
  if (hours <= 24 * 45) return 'month';
  return 'quarter';
}

/** A share as a rounded percentage, with `<1%` for a slice that is small but not absent. */
function fmtPct(fraction: number): string {
  const pct = fraction * 100;
  if (pct === 0) return '0%';
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/**
 * A change as a signed percentage — `null` when there was nothing to change from.
 *
 * A phase that cost nothing earlier and something now has no ratio, and drawing
 * it as `+100%` or `—` would both be claims: the first arithmetic that is not
 * true, the second silence about a real new cost. It gets `new` instead.
 */
function fmtChange(ratio: number | null): string {
  if (ratio === null) return 'new';
  const pct = Math.round(ratio * 100);
  if (pct === 0) return 'level';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

/** Which way a change reads. Falling money is good; falling completion is not. */
function toneOf(ratio: number | null, fallingIsGood: boolean): string {
  if (ratio === null || Math.round(ratio * 100) === 0) return 'level';
  return ratio < 0 === fallingIsGood ? 'good' : 'bad';
}

/**
 * The gap between two rates, in points — **taken from the percentages actually
 * drawn**, never from the fractions behind them.
 *
 * Both tiles that use this put the two rates on screen right above the gap, and
 * rounding each of 0.0833 and 0.0769 to `8%` while reporting their difference as
 * `−1 pts` is a panel visibly disagreeing with itself. Subtracting after
 * rounding is the only version an operator can check by eye, which is the only
 * check this figure will ever get.
 */
function fmtPts(now: number | null, then: number | null): { text: string; delta: number | null } {
  if (now === null || then === null) return { text: 'no comparison', delta: null };
  const delta = Math.round(now * 100) - Math.round(then * 100);
  if (delta === 0) return { text: 'level', delta: 0 };
  return { text: `${delta > 0 ? '+' : '−'}${Math.abs(delta)} pts`, delta };
}

/** A points gap's tone, from the same rounded figure the text states. */
function ptsTone(delta: number | null, fallingIsGood: boolean): string {
  if (delta === null || delta === 0) return 'level';
  return delta < 0 === fallingIsGood ? 'good' : 'bad';
}

/** The x of a week's centre, and the width of its column. */
function columns(count: number): { width: number; centre: (i: number) => number } {
  const width = (PLOT.right - PLOT.left) / count;
  return { width, centre: (i: number) => PLOT.left + i * width + width / 2 };
}

export function SpendTrendTab({ trend }: { trend: SpendTrend }): JSX.Element {
  const { buckets, comparison } = trend;
  // Nothing has closed in the whole window, which is a real state and not an
  // empty one: a fleet can be busy for a fortnight and land nothing. Every figure
  // below would be a null standing in for "no goals yet", so say which it is
  // rather than drawing eight empty weeks.
  if (buckets.every((w) => w.goalsClosed === 0)) {
    const unmeasured = buckets.reduce((n, w) => n + w.goalsUnmeasured, 0);
    return (
      <p className="empty">
        No goal has closed in the last {trend.periods} {periodWord(trend)}s with any spend on it
        {unmeasured > 0 && `, though ${unmeasured} closed with none recorded`}. The trend is per closed goal, so there
        is nothing yet to trend.
      </p>
    );
  }

  return (
    <div className="sp">
      <Tiles trend={trend} />

      <p className="sp-sub">Are goals getting cheaper?</p>
      <CostPerGoal buckets={buckets} />
      <CostNote buckets={buckets} comparison={comparison} />

      <p className="sp-sub">Which stages cost more, and which less?</p>
      <PhaseBand buckets={buckets} />
      {comparison === null ? (
        <p className="empty">
          Not enough complete periods yet to compare halves — the shift table needs two either side, so a couple of
          periods cannot pass for a trend.
        </p>
      ) : (
        <PhaseShift phases={comparison.phases} />
      )}

      <p className="sp-sub">Has the success rate changed?</p>
      <Landing buckets={buckets} />
      <LandingTiles comparison={comparison} />

      <Method trend={trend} />
    </div>
  );
}

/**
 * The four headline figures, each the recent half against the earlier one.
 *
 * Deltas rather than levels, because a level is what the breakdown already
 * shows: an operator on this tab has the number and wants to know which way it is
 * going.
 */
function Tiles({ trend }: { trend: SpendTrend }): JSX.Element {
  const { comparison } = trend;
  const closed = trend.buckets.reduce((n, w) => n + w.goalsClosed, 0);
  const ratio = (now: number | null, then: number | null): number | null =>
    now === null || then === null || then === 0 ? null : (now - then) / then;

  const costRatio = ratio(comparison?.recent.medianCostUsd ?? null, comparison?.earlier.medianCostUsd ?? null);
  const tokenRatio = ratio(comparison?.recent.medianInputTokens ?? null, comparison?.earlier.medianInputTokens ?? null);
  const doneNow = comparison?.recent.completionRate ?? null;
  const doneThen = comparison?.earlier.completionRate ?? null;

  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well">
        <Label dense>Per goal closed</Label>
        <span className="vl">
          {comparison?.recent.medianCostUsd === null || comparison === null
            ? '—'
            : fmtUsd(comparison.recent.medianCostUsd)}
        </span>
        <span className="sb">
          {comparison?.earlier.medianCostUsd != null
            ? `median · was ${fmtUsd(comparison.earlier.medianCostUsd)}`
            : 'median'}
        </span>
        <span className={`sb sp-delta ${toneOf(costRatio, true)}`}>{fmtChange(costRatio)}</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Input per goal</Label>
        <span className="vl">
          {comparison?.recent.medianInputTokens == null ? '—' : fmtTokens(comparison.recent.medianInputTokens)}
        </span>
        <span className="sb">
          {comparison?.earlier.medianInputTokens != null
            ? `median · was ${fmtTokens(comparison.earlier.medianInputTokens)}`
            : 'median'}
        </span>
        <span className={`sb sp-delta ${toneOf(tokenRatio, true)}`}>{fmtChange(tokenRatio)}</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Goals closed</Label>
        <span className="vl">{closed}</span>
        <span className="sb">
          over {trend.periods} {periodWord(trend)}s · {(closed / trend.periods).toFixed(1)} a {periodWord(trend)}
        </span>
        {/* The denominator, stated where the medians above are read. A fleet
            closing two goals a week has medians that move on one goal. */}
        <span className="sb sp-delta level">the unit everything here is per</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Runs finished</Label>
        <span className="vl">{doneNow === null ? '—' : fmtPct(doneNow)}</span>
        <span className="sb">
          {doneThen === null ? 'of settled runs' : `of settled runs · was ${fmtPct(doneThen)}`}
        </span>
        {/* Rising is the good direction on this one tile, so `fallingIsGood` is
            false — the tone is about the reading, never the sign. */}
        <span className={`sb sp-delta ${ptsTone(fmtPts(doneNow, doneThen).delta, false)}`}>
          {fmtPts(doneNow, doneThen).text}
        </span>
      </div>
    </div>
  );
}

/**
 * Median cost per closed goal, with the cohort drawn as points.
 *
 * Bars for the medians because these are *totals for a period* rather than
 * samples of a rate — the breakdown's own argument for bars over a line, one
 * grain up. The partial week is outlined rather than filled: it is an under-count
 * by construction, and a hollow bar is the only way to draw a figure that is
 * going to grow.
 */
function CostPerGoal({ buckets }: { buckets: readonly SpendTrendBucket[] }): JSX.Element {
  const { width, centre } = columns(buckets.length);
  const height = PLOT.bottom - PLOT.top;
  const peak = Math.max(...buckets.flatMap((w) => w.costs), 0);
  // A floor, so a fortnight of very cheap goals does not draw full-height bars.
  const top = Math.max(peak, 0.01);
  const y = (cost: number) => PLOT.bottom - (cost / top) * height;

  return (
    <div className="sp-graph sp-well">
      <svg
        viewBox={VIEW_BOX}
        role="img"
        aria-label={`Median cost per closed goal over ${buckets.length} weeks, ${buckets
          .filter((w) => w.medianCostUsd !== null)
          .map((w) => fmtUsd(w.medianCostUsd ?? 0))
          .join(', ')}`}
      >
        <g stroke="var(--border-lo)" strokeWidth="1">
          {[0, 0.5, 1].map((f) => (
            <path key={f} d={`M${PLOT.left} ${PLOT.top + f * height}H${PLOT.right}`} />
          ))}
        </g>
        <g className="sp-axis" textAnchor="end">
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PLOT.left - 7} y={PLOT.top + f * height + 3}>
              {fmtUsd(top * (1 - f))}
            </text>
          ))}
        </g>

        {buckets.map((week, i) => {
          if (week.medianCostUsd === null) return null;
          const barTop = y(week.medianCostUsd);
          return (
            <rect
              key={week.startsAt}
              x={centre(i) - width / 2 + 3}
              y={barTop}
              width={Math.max(1, width - 6)}
              height={Math.max(1, PLOT.bottom - barTop)}
              fill={week.partial ? 'none' : 'var(--accent)'}
              stroke={week.partial ? 'var(--accent)' : 'none'}
              strokeDasharray={week.partial ? '3 3' : undefined}
              opacity={week.partial ? 1 : 0.82}
            >
              <title>
                {`${fmtUsd(week.medianCostUsd)} median over ${week.goalsClosed} goal${
                  week.goalsClosed === 1 ? '' : 's'
                }, week from ${new Date(week.startsAt).toLocaleDateString()}${week.partial ? ' — still filling' : ''}`}
              </title>
            </rect>
          );
        })}

        {/* Every goal, so the median is read as the middle of something. Spread
            across the column by index rather than jittered: a random offset would
            move on every re-render and turn a still picture into a shuffle. */}
        {buckets.map((week, i) =>
          week.costs.map((cost, k) => (
            <circle
              key={`${week.startsAt}-${k}`}
              cx={centre(i) + ((k % 5) - 2) * Math.min(6, width / 7)}
              cy={y(cost)}
              r="2"
              fill="var(--text)"
              opacity="0.5"
            >
              <title>{fmtUsd(cost)}</title>
            </circle>
          )),
        )}

        <g className="sp-axis">
          <text x={PLOT.left} y="144">
            {buckets.length}w ago
          </text>
          <text x={PLOT.right} y="144" textAnchor="end">
            this week
          </text>
        </g>
      </svg>
    </div>
  );
}

/** What the first chart says, in a sentence, with the caveat it cannot draw. */
function CostNote({
  buckets,
  comparison,
}: {
  buckets: readonly SpendTrendBucket[];
  comparison: SpendTrendComparison | null;
}): JSX.Element {
  const unmeasured = buckets.reduce((n, w) => n + w.goalsUnmeasured, 0);
  const recent = comparison?.recent.medianCostUsd ?? null;
  const earlier = comparison?.earlier.medianCostUsd ?? null;
  return (
    <p className="empty">
      {recent !== null && earlier !== null ? (
        <>
          <b>{fmtUsd(recent)} a goal</b>, against {fmtUsd(earlier)} over the earlier half.{' '}
        </>
      ) : null}
      Bars are the median and the points are the goals behind it — goals are not the same size, so the trend is the
      reading and no single week is. The current week is drawn hollow because goals are still closing into it.
      {unmeasured > 0 &&
        ` A further ${unmeasured} goal${unmeasured === 1 ? '' : 's'} closed with no spend recorded and ${
          unmeasured === 1 ? 'is' : 'are'
        } in no figure here.`}
    </p>
  );
}

/**
 * The cohort's phase split, as a share band per week.
 *
 * A share rather than dollars, deliberately, and it is the chart most able to
 * mislead on its own — which is why the table underneath is not optional. A phase
 * whose share doubles while its dollars fall is a fleet doing the same work more
 * cheaply everywhere else, and the band alone draws that as a regression.
 */
function PhaseBand({ buckets }: { buckets: readonly SpendTrendBucket[] }): JSX.Element {
  const { width, centre } = columns(buckets.length);
  const height = PLOT.bottom - PLOT.top;
  const drawn = PHASE_ORDER.filter((p) => buckets.some((w) => w.byPhase[p] > 0));

  return (
    <div className="sp-graph sp-well">
      <svg viewBox={VIEW_BOX} role="img" aria-label="Share of each closed goal's cost by phase, per week">
        <g className="sp-axis" textAnchor="end">
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PLOT.left - 7} y={PLOT.top + f * height + 3}>
              {fmtPct(1 - f)}
            </text>
          ))}
        </g>
        {buckets.map((week, i) => {
          const total = PHASE_ORDER.reduce((n, p) => n + week.byPhase[p], 0);
          if (total <= 0) return null;
          let offset = PLOT.top;
          return (
            <g key={week.startsAt} opacity={week.partial ? 0.5 : 1}>
              {drawn.map((phase) => {
                const slice = (week.byPhase[phase] / total) * height;
                const y = offset;
                offset += slice;
                if (slice <= 0) return null;
                return (
                  <rect
                    key={phase}
                    x={centre(i) - width / 2 + 3}
                    y={y}
                    width={Math.max(1, width - 6)}
                    height={slice}
                    fill={`var(--sp-${phase})`}
                  >
                    <title>{`${phase}: ${fmtUsd(week.byPhase[phase])} a goal, ${fmtPct(
                      week.byPhase[phase] / total,
                    )}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        <g className="sp-axis">
          {drawn.map((phase, i) => (
            <g key={phase}>
              <rect x={PLOT.left + i * 86} y="138" width="8" height="8" fill={`var(--sp-${phase})`} />
              <text x={PLOT.left + i * 86 + 12} y="146">
                {phase}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

/**
 * The same shift in dollars — the one table this tab exists for.
 *
 * Share and absolute side by side, because they answer different questions and
 * the interesting cases are the ones where they disagree: a phase taking a larger
 * share of a smaller goal is money *saved*, and a share column on its own reports
 * it as a rise.
 */
function PhaseShift({ phases }: { phases: readonly SpendTrendPhaseShift[] }): JSX.Element {
  const earlierTotal = phases.reduce((n, p) => n + p.earlierUsd, 0);
  const recentTotal = phases.reduce((n, p) => n + p.recentUsd, 0);
  return (
    <>
      <table className="sp-tbl wide">
        <thead>
          <tr>
            <th>Stage</th>
            <th className="n">Share, then</th>
            <th className="n">Share, now</th>
            <th className="n">$/goal, then</th>
            <th className="n">$/goal, now</th>
            <th className="n">Change</th>
          </tr>
        </thead>
        <tbody>
          {phases.map((p) => (
            <tr key={p.phase}>
              <td>
                <span className="sw" style={{ background: `var(--sp-${p.phase})` }} />
                <span className="nm">{p.label}</span>
              </td>
              <td className="n">{fmtPct(p.earlierShare)}</td>
              <td className="n">{fmtPct(p.recentShare)}</td>
              <td className="n">{fmtUsd(p.earlierUsd)}</td>
              <td className="n b">{fmtUsd(p.recentUsd)}</td>
              <td className={`n sp-delta ${toneOf(p.changeRatio, true)}`}>{fmtChange(p.changeRatio)}</td>
            </tr>
          ))}
          <tr className="rest">
            <td>
              <span className="nm">The whole goal</span>
              <span className="bl">Every stage above, per goal closed</span>
            </td>
            <td className="n">—</td>
            <td className="n">—</td>
            <td className="n">{fmtUsd(earlierTotal)}</td>
            <td className="n b">{fmtUsd(recentTotal)}</td>
            <td
              className={`n sp-delta ${toneOf(
                earlierTotal > 0 ? (recentTotal - earlierTotal) / earlierTotal : null,
                true,
              )}`}
            >
              {fmtChange(earlierTotal > 0 ? (recentTotal - earlierTotal) / earlierTotal : null)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="empty">
        <b>Read the two dollar columns together with the two share columns.</b> A stage whose share rose while its
        dollars fell did not get more expensive — everything around it got cheaper, which is what planning more in order
        to review less looks like. Share alone cannot tell that from planning more for nothing.
      </p>
    </>
  );
}

/**
 * Completion and red checks on the same weeks.
 *
 * Two axes, which is a thing to do sparingly and is earned here: the question is
 * whether these two move *together*, and that is a shape rather than a pair of
 * numbers. Completion is a rate on the left and reds are a count per goal on the
 * right, and neither is meaningful in the other's units.
 */
function Landing({ buckets }: { buckets: readonly SpendTrendBucket[] }): JSX.Element {
  const { centre } = columns(buckets.length);
  const height = PLOT.bottom - PLOT.top;
  // The left axis floors at 50% rather than 0: a completion rate that has never
  // been below half would otherwise draw as a flat line across the top, which is
  // a picture of nothing.
  const rateY = (rate: number) => PLOT.bottom - Math.max(0, (rate - 0.5) / 0.5) * height;
  const peakReds = Math.max(...buckets.map((w) => w.redsPerGoal ?? 0), 1);
  const redY = (reds: number) => PLOT.bottom - (reds / peakReds) * height;

  const path = (pick: (w: SpendTrendBucket) => number | null, y: (v: number) => number): string =>
    buckets
      .map((w, i) => ({ v: pick(w), i }))
      .filter((p): p is { v: number; i: number } => p.v !== null)
      .map((p, k) => `${k === 0 ? 'M' : 'L'}${centre(p.i)} ${y(p.v)}`)
      .join(' ');

  return (
    <div className="sp-graph sp-well">
      <svg viewBox={VIEW_BOX} role="img" aria-label="Completion rate and red checks per goal, by week">
        <g stroke="var(--border-lo)" strokeWidth="1">
          {[0, 0.5, 1].map((f) => (
            <path key={f} d={`M${PLOT.left} ${PLOT.top + f * height}H${PLOT.right}`} />
          ))}
        </g>
        <g className="sp-axis" textAnchor="end">
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PLOT.left - 7} y={PLOT.top + f * height + 3}>
              {fmtPct(1 - f * 0.5)}
            </text>
          ))}
        </g>
        <g className="sp-axis" textAnchor="start">
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PLOT.right + 7} y={PLOT.top + f * height + 3}>
              {(peakReds * (1 - f)).toFixed(1)}
            </text>
          ))}
        </g>

        <path d={path((w) => w.completionRate, rateY)} fill="none" stroke="var(--green)" strokeWidth="2" />
        <path
          d={path((w) => w.redsPerGoal, redY)}
          fill="none"
          stroke="var(--red)"
          strokeWidth="2"
          strokeDasharray="5 3"
        />
        {buckets.map((w, i) => (
          <g key={w.startsAt}>
            {w.completionRate !== null && (
              <circle cx={centre(i)} cy={rateY(w.completionRate)} r="2.5" fill="var(--green)">
                <title>{`${fmtPct(w.completionRate)} of ${w.settled} settled runs finished`}</title>
              </circle>
            )}
            {w.redsPerGoal !== null && (
              <circle cx={centre(i)} cy={redY(w.redsPerGoal)} r="2.5" fill="var(--red)">
                <title>{`${w.redsPerGoal.toFixed(1)} red checks per goal — ${w.reds} reds, ${w.goalsClosed} goals`}</title>
              </circle>
            )}
          </g>
        ))}

        <g className="sp-axis">
          <path d={`M${PLOT.left} 142H${PLOT.left + 16}`} stroke="var(--green)" strokeWidth="2" />
          <text x={PLOT.left + 21} y="146">
            runs finished (left)
          </text>
          <path
            d={`M${PLOT.left + 150} 142H${PLOT.left + 166}`}
            stroke="var(--red)"
            strokeWidth="2"
            strokeDasharray="5 3"
          />
          <text x={PLOT.left + 171} y="146">
            red checks per goal (right)
          </text>
        </g>
      </svg>
    </div>
  );
}

/** What cheapness cost, if anything — the four readings a cost chart cannot make. */
function LandingTiles({ comparison }: { comparison: SpendTrendComparison | null }): JSX.Element {
  if (comparison === null) {
    return <p className="empty">Not enough complete weeks yet to compare the halves.</p>;
  }
  const { earlier, recent } = comparison;
  const ratio = (now: number | null, then: number | null): number | null =>
    now === null || then === null || then === 0 ? null : (now - then) / then;

  return (
    <>
      <div className="sp-tiles">
        <div className="sp-tile sp-well">
          <Label dense>Red checks per goal</Label>
          <span className="vl">{recent.redsPerGoal === null ? '—' : recent.redsPerGoal.toFixed(1)}</span>
          <span className="sb">
            {earlier.redsPerGoal === null ? 'no comparison' : `was ${earlier.redsPerGoal.toFixed(1)}`}
          </span>
          <span className={`sb sp-delta ${toneOf(ratio(recent.redsPerGoal, earlier.redsPerGoal), true)}`}>
            {fmtChange(ratio(recent.redsPerGoal, earlier.redsPerGoal))}
          </span>
        </div>
        <div className="sp-tile sp-well">
          <Label dense>Spent on lost runs</Label>
          <span className="vl">{recent.lostCostPerGoalUsd === null ? '—' : fmtUsd(recent.lostCostPerGoalUsd)}</span>
          <span className="sb">
            per goal
            {earlier.lostCostPerGoalUsd !== null && ` · was ${fmtUsd(earlier.lostCostPerGoalUsd)}`}
          </span>
          <span className={`sb sp-delta ${toneOf(ratio(recent.lostCostPerGoalUsd, earlier.lostCostPerGoalUsd), true)}`}>
            {fmtChange(ratio(recent.lostCostPerGoalUsd, earlier.lostCostPerGoalUsd))}
          </span>
        </div>
        <div className="sp-tile sp-well">
          <Label dense>Reopened after close</Label>
          <span className="vl">{recent.reopenedRate === null ? '—' : fmtPct(recent.reopenedRate)}</span>
          <span className="sb">
            of goals{earlier.reopenedRate !== null && ` · was ${fmtPct(earlier.reopenedRate)}`}
          </span>
          {/* Rising is bad here and the tone says so — this is the one tile on the
              tab where a number going up is the finding. */}
          <span className={`sb sp-delta ${ptsTone(fmtPts(recent.reopenedRate, earlier.reopenedRate).delta, true)}`}>
            {fmtPts(recent.reopenedRate, earlier.reopenedRate).text}
          </span>
        </div>
        <div className="sp-tile sp-well">
          <Label dense>Goals closed</Label>
          <span className="vl">{recent.goalsClosed}</span>
          <span className="sb">
            in {recent.weeks} weeks · was {earlier.goalsClosed}
          </span>
          <span className={`sb sp-delta ${toneOf(ratio(recent.goalsClosed, earlier.goalsClosed), false)}`}>
            {fmtChange(ratio(recent.goalsClosed, earlier.goalsClosed))}
          </span>
        </div>
      </div>
      <p className="empty">
        <b>Cheaper only counts if this half held.</b> A fleet that spends less per goal because it abandons the hard
        ones looks like progress on every chart above and nowhere here — <b>reopened after close</b> is the reading that
        catches it, since a goal closed cheaply and reopened next week was never really delivered.
      </p>
    </>
  );
}

/**
 * What the numbers are, stated where they are read.
 *
 * The cohort/period distinction is the one that has to be here. Cost, tokens, the
 * phase split and reopens are properties of the goals that *closed* that week and
 * follow them back through however long they took; completion and reds are what
 * was observed *inside* the week. Both are right and they are right about
 * different spans — and a reader comparing a spike in one against a dip in the
 * other, which is exactly what the shared axis invites, will be comparing two
 * things unless something says so.
 */
function Method({ trend }: { trend: SpendTrend }): JSX.Element {
  return (
    <div className="sp-method sp-well">
      <p className="sp-sub">What these numbers are</p>
      <p>
        <b>The unit is a goal that closed, never a run.</b> Every per-run rate is gameable for nothing — split the same
        work across twice as many smaller agents and input-per-run halves while the bill does not move. A closed goal
        cannot be subdivided by a dispatch change, which is what makes it the denominator even though goals differ in
        size.
      </p>
      <p>
        <b>Two kinds of week share one axis.</b> Cost, tokens, the stage split and reopens belong to the goals that
        closed that week and count spend from wherever it happened — often weeks earlier. Completion and red checks are
        what was observed inside the week itself. So a stage cost moving in week five and completion moving in week five
        are not necessarily the same event.
      </p>
      <p>
        <b>Red checks are counted per goal delivered, not per goal caused.</b> Tying a red to the goal it eventually
        belonged to would need every red inside every goal&apos;s lead time, which reaches back further than this window
        — and would quietly under-report the early weeks it has no history for. This is a rate of pipeline noise against
        delivered work.
      </p>
      <p className="dim">
        {trend.periods} {periodWord(trend)}s, ending with the one still in progress. Goals with no recorded spend are in
        no figure here.
      </p>
    </div>
  );
}
