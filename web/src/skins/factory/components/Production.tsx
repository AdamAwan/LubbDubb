import type { JSX } from 'react';
import { axisScale, type ProductionReading, type SeriesKey } from '../production.js';

/**
 * The production graph.
 *
 * Everything else on this floor is a snapshot; this is the only panel that reads
 * against time, which is the only way to answer whether the harness is
 * *producing* rather than merely busy. The churn ratio underneath is the point
 * of the whole panel: dispatches are effort and merges are output, and a rising
 * first line with a flat second one is a floor spinning.
 */

const SERIES_COLOR: Record<SeriesKey, string> = {
  dispatches: 'var(--blue)',
  merges: 'var(--green)',
  escalations: 'var(--red)',
};

const PLOT = { left: 38, right: 608, top: 12, bottom: 176 };

function pointsPath(points: readonly number[], peak: number): string {
  const span = points.length > 1 ? (PLOT.right - PLOT.left) / (points.length - 1) : 0;
  const height = PLOT.bottom - PLOT.top;
  return points
    .map((v, i) => {
      const x = PLOT.left + i * span;
      const y = PLOT.bottom - (v / peak) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function endpoint(points: readonly number[], peak: number): { x: number; y: number } {
  const last = points[points.length - 1] ?? 0;
  return {
    x: PLOT.right,
    y: PLOT.bottom - (last / peak) * (PLOT.bottom - PLOT.top),
  };
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
        <svg
          viewBox="0 0 620 200"
          role="img"
          aria-label={reading.series.map((s) => `${s.label} ${s.perHour.toFixed(1)} per hour`).join('; ')}
        >
          <g stroke="var(--border-lo)" strokeWidth="1">
            {gridLines.map((f) => {
              const y = PLOT.top + f * (PLOT.bottom - PLOT.top);
              return <path key={f} d={`M${PLOT.left} ${y}H${PLOT.right}`} />;
            })}
          </g>
          <g className="fx-mono" textAnchor="end">
            {gridLines.map((f) => {
              const y = PLOT.top + f * (PLOT.bottom - PLOT.top);
              return (
                <text key={f} x={PLOT.left - 8} y={y + 3}>
                  {Math.round(peak * (1 - f))}
                </text>
              );
            })}
          </g>
          <g className="fx-mono" textAnchor="middle">
            <text x={PLOT.left} y="194">
              {hours}h ago
            </text>
            <text x={(PLOT.left + PLOT.right) / 2} y="194">
              {Math.round(hours / 2)}h
            </text>
            <text x={PLOT.right} y="194">
              now
            </text>
          </g>

          {/* Dispatches carry an area fill — it is the baseline every other
              series is read against, so it reads as the ground rather than a
              third equal line. */}
          {reading.series.map((s) => {
            const path = pointsPath(s.points, peak);
            const end = endpoint(s.points, peak);
            return (
              <g key={s.key}>
                {s.key === 'dispatches' && (
                  <path
                    d={`${path} L${PLOT.right} ${PLOT.bottom} L${PLOT.left} ${PLOT.bottom} Z`}
                    fill={SERIES_COLOR[s.key]}
                    opacity=".13"
                  />
                )}
                <path
                  d={path}
                  fill="none"
                  stroke={SERIES_COLOR[s.key]}
                  strokeWidth={s.key === 'escalations' ? 1.8 : 2}
                  strokeDasharray={s.key === 'escalations' ? '4 3' : undefined}
                  strokeLinejoin="round"
                />
                <circle cx={end.x} cy={end.y} r="3.4" fill={SERIES_COLOR[s.key]} />
              </g>
            );
          })}
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

        <p className="fx-prod-note">
          {reading.churnRatio === null ? (
            <>Nothing has merged in this window — every dispatch so far is effort without output.</>
          ) : (
            <>
              <b>{reading.churnRatio.toFixed(1)}</b> dispatches per merge — the number that separates producing from
              churning.
            </>
          )}
        </p>
        {reading.truncated && (
          <p className="fx-empty">
            The decision log does not reach back {hours}h, so dispatch and escalation rates are a floor.
          </p>
        )}
      </div>
    </div>
  );
}
