import type { JSX } from 'react';
import type { AllowanceInsights, AllowanceProjection } from '../types.js';
import { fmtDuration } from './insightsFormat.js';
import { fmtPoints } from './allowanceChart.js';

const P = { left: 44, right: 596, top: 12, bottom: 96 };

export function Projection({ allowance }: { allowance: AllowanceInsights }): JSX.Element {
  const p = allowance.projection;
  if (p === null) {
    return (
      <div className="sp-well sp-graph">
        <p className="sp-note">
          No seven-day window has been reported — API-key auth, or a CLI too old to carry one. The five-hour reading
          above is all this account exposes.
        </p>
      </div>
    );
  }
  return <ProjectionChart p={p} />;
}

function ProjectionChart({ p }: { p: AllowanceProjection }): JSX.Element {
  const startMs = Date.parse(p.capturedAt);
  const ends = [p.resetsAt, p.exhaustsAt].filter((iso): iso is string => iso !== null).map((iso) => Date.parse(iso));
  const endMs = Math.max(startMs + 3_600_000, ...ends.map((ms) => startMs + (ms - startMs) * 1.08));
  const span = Math.max(1, endMs - startMs);
  const x = (ms: number): number => P.left + ((ms - startMs) / span) * (P.right - P.left);
  const y = (pct: number): number => P.bottom - (pct / 100) * (P.bottom - P.top);

  return (
    <div className="sp-graph sp-well">
      <svg viewBox={`0 0 620 ${P.bottom + 28}`} role="img" aria-label={verdict(p)}>
        <g className="al-grid">
          {[0, 25, 50, 75, 100].map((pct) => (
            <path key={pct} d={`M${P.left} ${y(pct)}H${P.right}`} />
          ))}
        </g>
        {/* The floor is not the bottom of a scale either: below it the fleet is
            parked, so the last stretch of headroom is drawn in the same alarm
            vocabulary the timeline's 100% line is. */}
        <rect className="al-parked" x={P.left} y={y(12)} width={P.right - P.left} height={P.bottom - y(12)} />
        <text className="al-park-label" x={P.left + 8} y={P.bottom - 5}>
          PARKED
        </text>
        <g className="sp-axis" textAnchor="end">
          <text x={P.left - 7} y={y(100) + 3}>
            full
          </text>
          <text x={P.left - 7} y={y(50) + 3}>
            50%
          </text>
          <text x={P.left - 7} y={y(0) + 3}>
            spent
          </text>
        </g>
        {/* Headroom, not usage: the question is what is left, and a reader should
            not have to subtract to answer it. */}
        <circle className="al-dot al-now" cx={x(startMs)} cy={y(100 - p.usedPercentage)} r="3" />
        {p.exhaustsAt !== null && (
          <path
            className="al-projection"
            d={`M${x(startMs)} ${y(100 - p.usedPercentage)}L${x(Date.parse(p.exhaustsAt))} ${y(0)}`}
          />
        )}
        {p.resetsAt !== null && (
          <g>
            <path className="al-reset" d={`M${x(Date.parse(p.resetsAt))} ${P.top - 4}V${P.bottom}`} />
            {/* Anchored inside the line rather than beyond it: the reset is often
                the right-hand end of the axis, and a label hung off it is a label
                half outside the viewBox. */}
            <text className="sp-axis" x={x(Date.parse(p.resetsAt)) - 5} y={P.top} textAnchor="end">
              resets
            </text>
          </g>
        )}
        {p.exhaustsAt !== null && p.beforeReset === true && (
          <circle className="al-spent" cx={x(Date.parse(p.exhaustsAt))} cy={y(0)} r="3.5" />
        )}
        {/* The line runs between two instants and drawing neither of them leaves a
            slope with no scale under it — a reader cannot tell a week from an
            afternoon. Spans rather than clock times, for `verdict`'s reason. */}
        <ProjectionSpans p={p} startMs={startMs} x={x} />
      </svg>
      <p className={p.beforeReset === true ? 'sp-note al-warn' : 'sp-note'}>{verdict(p)}</p>
      <p className="sp-note">
        {p.fittedFrom < 3
          ? 'Too few readings in the last two days to fit a rate — the fleet has been quiet.'
          : `Fitted over ${p.fittedFrom} readings from the last two days, and only since the most recent reset. ` +
            'A turn-bound series over a quiet stretch is a line through very few points.'}
      </p>
    </div>
  );
}

function ProjectionSpans({
  p,
  startMs,
  x,
}: {
  p: AllowanceProjection;
  startMs: number;
  x: (ms: number) => number;
}): JSX.Element {
  return (
    <g className="sp-axis">
      <text x={P.left} y={P.bottom + 15} textAnchor="start">
        now
      </text>
      {p.exhaustsAt !== null && (
        <text x={mark(x(Date.parse(p.exhaustsAt)))} y={P.bottom + 15} textAnchor="middle">
          out in {fmtDuration(Date.parse(p.exhaustsAt) - startMs)}
        </text>
      )}
      {p.resetsAt !== null && farApart(x(Date.parse(p.resetsAt)), p.exhaustsAt, x) && (
        <text x={x(Date.parse(p.resetsAt)) - 5} y={P.top + 12} textAnchor="end">
          in {fmtDuration(Date.parse(p.resetsAt) - startMs)}
        </text>
      )}
    </g>
  );
}

function mark(at: number): number {
  return Math.max(P.left + 46, at);
}

function farApart(resetX: number, exhaustsAt: string | null, x: (ms: number) => number): boolean {
  if (exhaustsAt === null) return true;
  return Math.abs(resetX - x(Date.parse(exhaustsAt))) > 80;
}

function verdict(p: AllowanceProjection): string {
  const left = `${fmtPoints(100 - p.usedPercentage)} of the weekly allowance is left`;
  if (p.exhaustsAt === null) return `${left}, and the last two days show no rise to project forward.`;
  const from = Date.parse(p.capturedAt);
  const inWhen = (iso: string): string => `in about ${fmtDuration(Math.max(0, Date.parse(iso) - from))}`;
  if (p.beforeReset === null)
    return `${left}. At this pace it is spent ${inWhen(p.exhaustsAt)}; the CLI reported no reset to compare that to.`;
  const resetsIn = inWhen(p.resetsAt ?? p.exhaustsAt);
  return p.beforeReset
    ? `${left}, and at this pace it is spent ${inWhen(p.exhaustsAt)} — before the window resets ${resetsIn}. Cut the cap or the fleet parks.`
    : `${left}, and at this pace the window resets ${resetsIn}, before it runs out.`;
}
