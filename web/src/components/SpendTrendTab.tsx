import type { JSX } from 'react';
import type { SpendTrend, SpendTrendComparison, SpendTrendPhaseShift, SpendTrendBucket } from '../types.js';
import { fmtTokens, fmtUsd } from './util.js';
import { Label } from './label.js';
import { MethodNote } from './insightsMethod.js';
import { Landing, LandingTiles } from './SpendTrendLanding.js';
import {
  PHASE_ORDER,
  PLOT,
  VIEW_BOX,
  periodWord,
  fmtPct,
  fmtChange,
  toneOf,
  fmtPts,
  ptsTone,
  columns,
  ratio,
} from './spendTrendFormat.js';

// → docs/spec/17-cockpit.md

export function SpendTrendTab({ trend }: { trend: SpendTrend }): JSX.Element {
  const { buckets, comparison } = trend;
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

function Tiles({ trend }: { trend: SpendTrend }): JSX.Element {
  const { comparison } = trend;
  const closed = trend.buckets.reduce((n, w) => n + w.goalsClosed, 0);
  const doneNow = comparison?.recent.completionRate ?? null;
  const doneThen = comparison?.earlier.completionRate ?? null;

  return (
    <div className="sp-tiles">
      <MedianTile
        label="Per goal closed"
        now={comparison?.recent.medianCostUsd ?? null}
        then={comparison?.earlier.medianCostUsd ?? null}
        fmt={fmtUsd}
      />
      <MedianTile
        label="Input per goal"
        now={comparison?.recent.medianInputTokens ?? null}
        then={comparison?.earlier.medianInputTokens ?? null}
        fmt={fmtTokens}
      />
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

function MedianTile({
  label,
  now,
  then,
  fmt,
}: {
  label: string;
  now: number | null;
  then: number | null;
  fmt: (value: number) => string;
}): JSX.Element {
  const change = ratio(now, then);
  return (
    <div className="sp-tile sp-well">
      <Label dense>{label}</Label>
      <span className="vl">{now === null ? '—' : fmt(now)}</span>
      <span className="sb">{then !== null ? `median · was ${fmt(then)}` : 'median'}</span>
      <span className={`sb sp-delta ${toneOf(change, true)}`}>{fmtChange(change)}</span>
    </div>
  );
}

function CostPerGoal({ buckets }: { buckets: readonly SpendTrendBucket[] }): JSX.Element {
  const { width, centre } = columns(buckets.length);
  const height = PLOT.bottom - PLOT.top;
  const peak = Math.max(...buckets.flatMap((w) => w.costs), 0);
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

function Method({ trend }: { trend: SpendTrend }): JSX.Element {
  return (
    <MethodNote>
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
    </MethodNote>
  );
}
