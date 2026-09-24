import type { JSX } from 'react';
import type { SpendTrendComparison, SpendTrendBucket } from '../types.js';
import { fmtUsd } from './util.js';
import { Label } from './label.js';
import { PLOT, VIEW_BOX, fmtPct, fmtChange, toneOf, fmtPts, ptsTone, columns } from './spendTrendFormat.js';

// → docs/spec/17-cockpit.md

export function Landing({ buckets }: { buckets: readonly SpendTrendBucket[] }): JSX.Element {
  const { centre } = columns(buckets.length);
  const height = PLOT.bottom - PLOT.top;
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

export function LandingTiles({ comparison }: { comparison: SpendTrendComparison | null }): JSX.Element {
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
