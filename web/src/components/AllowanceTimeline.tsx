import { Fragment, type JSX } from 'react';
import type { AllowanceInsights, AllowanceLane, AllowanceReading } from '../types.js';
import { relAge, relTime } from './util.js';
import { Ref } from './refs.js';
import { TipLayer, fmtPoints, showOn, useTip, type ShowTip } from './allowanceChart.js';

const T = { left: 210, right: 962, top: 26, bottom: 196 };
const VIEW = 1000;
const MAX_ROWS = 8;

function pct(units: number): string {
  return `${(units / VIEW) * 100}%`;
}

type Drawn = AllowanceReading & { fiveHour: number };

interface Scale {
  startMs: number;
  span: number;
  frac: (iso: string) => number;
  x: (iso: string) => number;
  y: (pctUsed: number) => number;
}

interface IdleStretch {
  key: string;
  from: number;
  to: number;
  previous: AllowanceReading;
  reading: AllowanceReading;
}

export function Timeline({ allowance, now }: { allowance: AllowanceInsights; now: number }): JSX.Element {
  const { readings } = allowance;
  const startMs = Date.parse(allowance.window.startsAt);
  const span = Math.max(1, now - startMs);
  const frac = (iso: string): number => (Date.parse(iso) - startMs) / span;
  const x = (iso: string): number => T.left + frac(iso) * (T.right - T.left);
  const y = (pctUsed: number): number => T.bottom - (pctUsed / 100) * (T.bottom - T.top);
  const scale: Scale = { startMs, span, frac, x, y };

  const allRows = laneRows(allowance);
  const rows = allRows.slice(0, MAX_ROWS);
  const { tip, show, hide, wrap } = useTip();

  const idle = readings.flatMap((reading, i) => {
    const previous = readings[i - 1];
    if (!reading.afterGap || previous === undefined) return [];
    return [{ key: reading.at, from: frac(previous.at), to: frac(reading.at), previous, reading }];
  });

  return (
    <div className="sp-graph al-wide sp-well">
      <div className="al-chart" ref={wrap}>
        <TimelinePlot
          allowance={allowance}
          now={now}
          scale={scale}
          idle={idle}
          held={tip?.at ?? null}
          show={show}
          hide={hide}
        />

        <p className="al-cap al-band-cap">AGENTS RUNNING</p>
        <LaneBand rows={rows} idle={idle} frac={frac} now={now} show={show} hide={hide} />
        <TipLayer tip={tip} />
      </div>
      <p className="sp-note">
        {rows.length === allRows.length
          ? `${allowance.lanes.length} run${allowance.lanes.length === 1 ? '' : 's'} in this window, one row per goal. `
          : `The ${MAX_ROWS} goals of ${allRows.length} that spent most. `}
        Hover the plot for the reading under the pointer, or a bar for the run behind it; the number in a gutter opens
        its goal. Which agents were running while it climbed — not which of them caused it.
      </p>
    </div>
  );
}

function TimelinePlot({
  allowance,
  now,
  scale,
  idle,
  held,
  show,
  hide,
}: {
  allowance: AllowanceInsights;
  now: number;
  scale: Scale;
  idle: IdleStretch[];
  held: string | null;
  show: ShowTip;
  hide: () => void;
}): JSX.Element {
  const { readings } = allowance;
  const { x, y } = scale;
  const segments: AllowanceReading[][] = [];
  for (const reading of readings) {
    if (reading.fiveHour === null) continue;
    const open = segments.at(-1);
    if (open === undefined || reading.afterReset || reading.afterGap) segments.push([reading]);
    else open.push(reading);
  }
  const drawn = readings.filter((r): r is Drawn => r.fiveHour !== null);
  const last = drawn.at(-1) ?? null;
  const marked = held === null ? null : (drawn.find((r) => r.at === held) ?? null);

  return (
    <svg
      viewBox={`0 0 ${VIEW} ${T.bottom + 28}`}
      role="img"
      aria-label={`Account five-hour window over ${allowance.window.label.toLowerCase()}`}
      onMouseMove={(e) => {
        const at = readingAt(e, drawn, scale.startMs, scale.span);
        if (at === null) hide();
        else show(e, readingTip(at, now), at.at);
      }}
      onMouseLeave={hide}
    >
      <TimelineFrame now={now} scale={scale} />

      {/* What the harness did not watch, drawn as one column: the rise across it
          is counted, and the shading says only that nothing was there to see it
          happen. Every lane track below shades the same fractions. */}
      <IdleColumns idle={idle} scale={scale} />

      {segments.map((segment, i) => (
        <g key={segment[0]?.at ?? i}>
          <path className="al-area" d={`${stepPath(segment, x, y)}V${T.bottom}H${x(segment[0]?.at ?? '')}Z`} />
          <path className="al-line" d={stepPath(segment, x, y)} />
          {segment.map((reading) => (
            <circle key={reading.at} className="al-dot" cx={x(reading.at)} cy={y(reading.fiveHour ?? 0)} r="3" />
          ))}
        </g>
      ))}
      {/* Where it stands now, said in the chart rather than only in the tile
          above it: the last dot is the one figure a reader came for. */}
      {last !== null && (
        <g>
          <circle className="al-dot al-now" cx={x(last.at)} cy={y(last.fiveHour)} r="5" />
          <text className="al-endpoint" x={x(last.at) - 14} y={y(last.fiveHour) + 36} textAnchor="end">
            {fmtPoints(last.fiveHour)}
          </text>
        </g>
      )}
      {/* The reading the readout is about, marked on the line: a tooltip that
          names a moment and does not say which one is a second reading to
          reconcile with the first. */}
      {marked !== null && (
        <g className="al-mark">
          <path d={`M${x(marked.at)} ${T.top}V${T.bottom}`} />
          <circle cx={x(marked.at)} cy={y(marked.fiveHour)} r="4.5" />
        </g>
      )}
    </svg>
  );
}

function TimelineFrame({ now, scale }: { now: number; scale: Scale }): JSX.Element {
  const { startMs, span, y } = scale;
  return (
    <>
      {/* A grid rather than three rules: the lanes below are read off the same x,
          so a reader tracing a run up to the line needs something to trace along. */}
      <g className="al-grid">
        {[0, 25, 50, 75, 100].map((level) => (
          <path key={level} d={`M${T.left} ${y(level)}H${T.right}`} />
        ))}
        {TICKS.map((f) => (
          <path key={f} d={`M${T.left + f * (T.right - T.left)} ${T.top}V${T.bottom}`} />
        ))}
      </g>
      {/* 100% is not the top of a scale, it is where the fleet stops — so it is
          drawn in the alarm vocabulary rather than as the last gridline. */}
      <path className="al-park" d={`M${T.left} ${y(100)}H${T.right}`} />
      <text className="al-park-label" x={T.left + 8} y={y(100) + 14}>
        PARKS THE FLEET
      </text>
      <g className="sp-axis" textAnchor="end">
        {[0, 25, 50, 75, 100].map((level) => (
          <text key={level} x={T.left - 12} y={y(level) + 4}>
            {level}%
          </text>
        ))}
      </g>
      {/* A timeline with no time on it asks the reader to take the lanes'
          alignment on trust. Ages rather than clock times, since every other
          span on the tab is one. */}
      <g className="sp-axis" textAnchor="middle">
        {TICKS.map((f) => (
          <text key={f} x={T.left + f * (T.right - T.left)} y={T.bottom + 20}>
            {f === 1 ? 'now' : relAge(new Date(startMs + f * span).toISOString(), now)}
          </text>
        ))}
      </g>
      <text className="al-cap" x={T.left} y={14}>
        ACCOUNT · FIVE-HOUR WINDOW USED
      </text>
    </>
  );
}

function IdleColumns({ idle, scale }: { idle: IdleStretch[]; scale: Scale }): JSX.Element {
  const { x, y } = scale;
  return (
    <>
      {idle.map((stretch) => {
        const from = T.left + stretch.from * (T.right - T.left);
        const width = (stretch.to - stretch.from) * (T.right - T.left);
        return (
          <g key={`idle-${stretch.key}`}>
            <rect className="al-idle" x={from} y={T.top} width={width} height={T.bottom - T.top} />
            {width > 150 && (
              <text className="al-idle-label" x={from + width / 2} y={T.top + 14} textAnchor="middle">
                FLEET IDLE · NO READINGS
              </text>
            )}
            {stretch.previous.fiveHour !== null && stretch.reading.fiveHour !== null && (
              <path
                className="al-gap"
                d={`M${from} ${y(stretch.previous.fiveHour)}L${x(stretch.reading.at)} ${y(stretch.reading.fiveHour)}`}
              />
            )}
          </g>
        );
      })}
    </>
  );
}

function LaneBand({
  rows,
  idle,
  frac,
  now,
  show,
  hide,
}: {
  rows: LaneRow[];
  idle: IdleStretch[];
  frac: (iso: string) => number;
  now: number;
  show: ShowTip;
  hide: () => void;
}): JSX.Element {
  return (
    <div className="al-band" style={{ gridTemplateColumns: `${pct(T.left - 12)} ${pct(T.right - T.left)}` }}>
      {rows.map((row) => (
        <Fragment key={row.key}>
          <LaneName row={row} />
          <div className="al-track">
            {idle.map((stretch) => (
              <span
                key={`idle-${stretch.key}`}
                className="al-idle-stripe"
                style={{ left: `${stretch.from * 100}%`, width: `${(stretch.to - stretch.from) * 100}%` }}
              />
            ))}
            {row.lanes.map((lane) => {
              const from = Math.max(0, frac(lane.startedAt));
              const to = Math.min(1, frac(lane.endedAt ?? new Date(now).toISOString()));
              const lines = laneTip(lane, now);
              return (
                <button
                  key={lane.agentId}
                  type="button"
                  className={lane.measured ? 'al-lane' : 'al-lane al-lane-unmeasured'}
                  style={{
                    left: `${from * 100}%`,
                    width: `max(4px, ${Math.max(0, to - from) * 100}%)`,
                    background: laneFill(lane),
                  }}
                  aria-label={lines.join(' · ')}
                  onMouseMove={(e) => show(e, lines, null)}
                  onMouseLeave={hide}
                  onFocus={(e) => showOn(e.currentTarget, lines, show)}
                  onBlur={hide}
                />
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function LaneName({ row }: { row: LaneRow }): JSX.Element {
  return (
    <div className={row.issueNumber === null ? 'al-row-name al-row-name-none' : 'al-row-name'}>
      {row.issueNumber === null ? (
        <span className="al-title">no goal</span>
      ) : (
        <>
          {/* The row's voice, or the residual's grey where the goal was
              apportioned nothing — never slot 0, which is another goal's
              colour and a legend that lies. */}
          <span
            className="al-swatch"
            style={{
              background: row.slot === null ? 'var(--al-unattributed)' : `var(--al-goal-${row.slot})`,
            }}
          />
          <Ref to={`issue:${row.issueNumber}`} />
          <span className="al-title">{row.title ?? 'no longer on the tracker'}</span>
        </>
      )}
    </div>
  );
}

function readingAt(
  e: { clientX: number; currentTarget: SVGSVGElement },
  drawn: readonly Drawn[],
  startMs: number,
  span: number,
): Drawn | null {
  const box = e.currentTarget.getBoundingClientRect();
  if (box.width === 0 || drawn.length === 0) return null;
  const units = ((e.clientX - box.left) / box.width) * VIEW;
  if (units < T.left || units > T.right) return null;
  const at = startMs + ((units - T.left) / (T.right - T.left)) * span;
  return drawn.reduce((best, reading) =>
    Math.abs(Date.parse(reading.at) - at) < Math.abs(Date.parse(best.at) - at) ? reading : best,
  );
}

function readingTip(reading: Drawn, now: number): string[] {
  const lines = [`${fmtPoints(reading.fiveHour)} of the five-hour window used`, relTime(reading.at, now)];
  if (reading.afterReset) lines.push('the window reset just before this');
  if (reading.afterGap) lines.push('the first reading after an idle stretch');
  return lines;
}

const TICKS = [0, 0.25, 0.5, 0.75, 1];

type LaneRow = {
  key: string;
  issueNumber: number | null;
  title: string | null;
  slot: number | null;
  lanes: AllowanceLane[];
};

function laneRows(allowance: AllowanceInsights): LaneRow[] {
  const rows = new Map<string, LaneRow>();
  const keyOf = (issue: number | null): string => (issue === null ? 'none' : `#${issue}`);
  for (const goal of allowance.apportionment.goals)
    rows.set(keyOf(goal.issueNumber), {
      key: keyOf(goal.issueNumber),
      issueNumber: goal.issueNumber,
      title: goal.title,
      slot: goal.slot,
      lanes: [],
    });
  for (const lane of allowance.lanes) {
    const key = keyOf(lane.issueNumber);
    const row = rows.get(key) ?? {
      key,
      issueNumber: lane.issueNumber,
      title: lane.issueNumber === null ? null : lane.title,
      slot: lane.issueNumber === null ? null : lane.slot,
      lanes: [],
    };
    row.lanes.push(lane);
    rows.set(key, row);
  }
  return [...rows.values()].filter((row) => row.lanes.length > 0);
}

function stepPath(
  segment: readonly AllowanceReading[],
  x: (iso: string) => number,
  y: (pct: number) => number,
): string {
  return segment
    .map((reading, i) => {
      const at = x(reading.at);
      const level = y(reading.fiveHour ?? 0);
      if (i === 0) return `M${at} ${level}`;
      return `L${at} ${y(segment[i - 1]?.fiveHour ?? 0)}L${at} ${level}`;
    })
    .join('');
}

function laneFill(lane: AllowanceLane): string {
  if (!lane.measured) return 'var(--al-unmeasured)';
  if (lane.slot === null) return 'var(--al-unattributed)';
  return `var(--al-goal-${lane.slot})`;
}

function laneTip(lane: AllowanceLane, now: number): string[] {
  const goal = lane.issueNumber === null ? 'reached no goal' : `#${lane.issueNumber}`;
  const when = lane.endedAt === null ? 'still running' : `ended ${relTime(lane.endedAt, now)}`;
  const lines = [lane.title ?? lane.agentId, `${goal} · started ${relTime(lane.startedAt, now)} · ${when}`];
  if (!lane.measured) lines.push('reported no usage (PTY)');
  return lines;
}
