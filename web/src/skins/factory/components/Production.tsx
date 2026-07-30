import type { JSX } from 'react';
import { axisScale, type ProductionReading, type ProductionSeries, type SeriesKey } from '../production.js';

/**
 * The production graph.
 *
 * Everything else on this floor is a snapshot; this is the only panel that reads
 * against time, which is the only way to answer whether the harness is
 * *producing* rather than merely busy. The churn ratio underneath is the point
 * of the whole panel: dispatches are effort and merges are output, and a rising
 * first line with a flat second one is a floor spinning.
 *
 * It draws at two sizes off one set of plotting functions. The **spark** is the
 * face of the status bar's Output gauge — the shape alone, at the size a gauge
 * has — and the full panel, which only opens on a click, is where the axes, the
 * rates and the caveats live. Two components drawing the same series
 * independently would be two things to keep in step for no gain; the only
 * difference between them is the rectangle they plot into, how heavy the strokes
 * are in it, and whether the axes are labelled.
 */

const SERIES_COLOR: Record<SeriesKey, string> = {
  dispatches: 'var(--blue)',
  merges: 'var(--green)',
  escalations: 'var(--red)',
};

interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const FULL: Plot = { left: 38, right: 608, top: 12, bottom: 176 };
/**
 * Gauge-sized: no axis labels to leave room for, so the lines run the whole box.
 * The inset is the endpoint dot's radius, which would otherwise be clipped by
 * the sunk face at either end of the run.
 */
const SPARK: Plot = { left: 2.5, right: 61.5, top: 4, bottom: 22 };

function pointsPath(points: readonly number[], peak: number, plot: Plot): string {
  const span = points.length > 1 ? (plot.right - plot.left) / (points.length - 1) : 0;
  const height = plot.bottom - plot.top;
  return points
    .map((v, i) => {
      const x = plot.left + i * span;
      const y = plot.bottom - (v / peak) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function endpoint(points: readonly number[], peak: number, plot: Plot): { x: number; y: number } {
  const last = points[points.length - 1] ?? 0;
  return {
    x: plot.right,
    y: plot.bottom - (last / peak) * (plot.bottom - plot.top),
  };
}

/**
 * The series themselves. Dispatches carry an area fill — it is the baseline
 * every other series is read against, so it reads as the ground rather than a
 * third equal line.
 *
 * `weight` scales every stroke, dash and endpoint with the box. A 2px line is
 * right across 620 units and a smear across 64, so the spark would otherwise be
 * three overlapping bands rather than three lines — and the whole reason it
 * shares this function is that its shape must be the panel's shape.
 */
function Lines({
  series,
  peak,
  plot,
  weight = 1,
}: {
  series: readonly ProductionSeries[];
  peak: number;
  plot: Plot;
  weight?: number;
}): JSX.Element {
  return (
    <>
      {series.map((s) => {
        const path = pointsPath(s.points, peak, plot);
        const end = endpoint(s.points, peak, plot);
        return (
          <g key={s.key}>
            {s.key === 'dispatches' && (
              <path
                d={`${path} L${plot.right} ${plot.bottom} L${plot.left} ${plot.bottom} Z`}
                fill={SERIES_COLOR[s.key]}
                opacity=".13"
              />
            )}
            <path
              d={path}
              fill="none"
              stroke={SERIES_COLOR[s.key]}
              strokeWidth={(s.key === 'escalations' ? 1.8 : 2) * weight}
              strokeDasharray={s.key === 'escalations' ? `${4 * weight} ${3 * weight}` : undefined}
              strokeLinejoin="round"
            />
            <circle cx={end.x} cy={end.y} r={3.4 * weight} fill={SERIES_COLOR[s.key]} />
          </g>
        );
      })}
    </>
  );
}

function ariaLabel(reading: ProductionReading): string {
  return reading.series.map((s) => `${s.label} ${s.perHour.toFixed(1)} per hour`).join('; ');
}

function churnLine(reading: ProductionReading): JSX.Element {
  if (reading.churnRatio === null) {
    return <>Nothing has merged in this window — every dispatch so far is effort without output.</>;
  }
  return (
    <>
      <b>{reading.churnRatio.toFixed(1)}</b> dispatches per merge — the number that separates producing from churning.
    </>
  );
}

/**
 * The face of the Output gauge: effort against output, at gauge size.
 *
 * Two series, not three. Escalations belong to the graph, where there is room to
 * label them and a legend saying which line is which — in a 64-unit box a third
 * colour is a smudge, and the bar already speaks for them in a gauge of their
 * own, in red, four inches to the right. What is left is exactly the comparison
 * the churn ratio is a number for: the filled ground is dispatches, the line
 * over it is merges, and the two diverging is a floor spinning.
 *
 * The y-scale is the whole reading's peak, not these two series', so the shape
 * here and the shape in the graph are the same shape.
 */
export function ProductionSpark({ reading }: { reading: ProductionReading }): JSX.Element {
  const { max: peak } = axisScale(reading.peak);
  const series = reading.series.filter((s) => s.key !== 'escalations');

  return (
    <svg className="fx-prod-spark fx-sunk" viewBox="0 0 64 26" role="img" aria-label={ariaLabel(reading)}>
      <Lines series={series} peak={peak} plot={SPARK} weight={0.55} />
    </svg>
  );
}

function Delta({ pct }: { pct: number | null }): JSX.Element {
  if (pct === null) return <span className="dl flat">—</span>;
  if (pct === 0) return <span className="dl flat">— 0%</span>;
  return <span className={`dl ${pct > 0 ? 'up' : 'dn'}`}>{`${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`}</span>;
}

export function Production({ reading }: { reading: ProductionReading }): JSX.Element {
  const hours = Math.round(reading.windowMs / 3_600_000);
  const { max: peak, lines: gridLines } = axisScale(reading.peak);

  return (
    <div className="fx-prod">
      <div className="fx-prod-graph fx-sunk">
        <svg viewBox="0 0 620 200" role="img" aria-label={ariaLabel(reading)}>
          <g stroke="var(--border-lo)" strokeWidth="1">
            {gridLines.map((f) => {
              const y = FULL.top + f * (FULL.bottom - FULL.top);
              return <path key={f} d={`M${FULL.left} ${y}H${FULL.right}`} />;
            })}
          </g>
          <g className="fx-mono" textAnchor="end">
            {gridLines.map((f) => {
              const y = FULL.top + f * (FULL.bottom - FULL.top);
              return (
                <text key={f} x={FULL.left - 8} y={y + 3}>
                  {Math.round(peak * (1 - f))}
                </text>
              );
            })}
          </g>
          <g className="fx-mono" textAnchor="middle">
            <text x={FULL.left} y="194">
              {hours}h ago
            </text>
            <text x={(FULL.left + FULL.right) / 2} y="194">
              {Math.round(hours / 2)}h
            </text>
            <text x={FULL.right} y="194">
              now
            </text>
          </g>
          <Lines series={reading.series} peak={peak} plot={FULL} />
        </svg>
      </div>

      <div className="fx-prod-key fx-sunk">
        <p className="fx-sub">Per hour · {hours}h window</p>
        {reading.series.map((s) => (
          <div key={s.key} className="fx-krow">
            <span className="sw" style={{ background: SERIES_COLOR[s.key] }} />
            <span className="nm">{s.label}</span>
            <span className="rt">
              <b>{s.perHour.toFixed(1)}</b>/h
            </span>
            <Delta pct={s.deltaPct} />
          </div>
        ))}
        {reading.costPerHour !== null && (
          <div className="fx-krow">
            <span className="sw" style={{ background: 'var(--accent)' }} />
            <span className="nm">Spend</span>
            <span className="rt">
              <b>${reading.costPerHour.toFixed(2)}</b>/h
            </span>
            {/* No delta: the 5h window is a single total, not a series, so there
                are no halves to compare and an arrow here would be invented. */}
            <span className="dl flat">avg</span>
          </div>
        )}

        <p className="fx-prod-note">{churnLine(reading)}</p>
        {reading.truncated && (
          <p className="fx-empty">
            The decision log does not reach back {hours}h, so dispatch and escalation rates are a floor.
          </p>
        )}
      </div>
    </div>
  );
}
