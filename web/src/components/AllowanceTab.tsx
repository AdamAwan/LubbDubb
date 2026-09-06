import { Fragment, useRef, useState, type JSX, type RefObject } from 'react';
import type {
  AllowanceApportionment,
  AllowanceGoal,
  AllowanceInsights,
  AllowanceLane,
  AllowancePayload,
  AllowanceProjection,
  AllowanceReading,
} from '../types.js';
import { fmtUsd, relAge, relTime } from './util.js';
import { fmtDuration, fmtShare, share } from './insightsFormat.js';
import { Ref, RefLinksExtended } from './refs.js';
import { Label } from './label.js';

// → docs/spec/17-cockpit.md

export function AllowanceTab({ payload }: { payload: AllowancePayload }): JSX.Element {
  const { allowance, refUrls } = payload;
  const now = Date.parse(allowance.generatedAt);
  const { apportionment } = allowance;

  if (allowance.readings.length < 2) {
    return (
      <p className="empty">
        {allowance.readings.length === 0
          ? 'No usage windows were reported in this window. A reading arrives only when an agent takes a turn, ' +
            'and API-key auth reports none at all — so this is a fleet that has not run, not an account at zero.'
          : 'One reading in this window, which is a level rather than a change. The next agent turn gives it ' +
            'something to be measured against.'}
      </p>
    );
  }

  return (
    <RefLinksExtended refUrls={refUrls}>
      <div className="sp al">
        <Headline allowance={allowance} now={now} />

        <p className="sp-sub">Over the window</p>
        <Timeline allowance={allowance} now={now} />

        <div className="sp-cols">
          <section className="sp-col">
            <p className="sp-sub">Where it went</p>
            <GoalBar apportionment={apportionment} />
            <Method allowance={allowance} />
          </section>
          <section className="sp-col">
            <p className="sp-sub">The week</p>
            <Projection allowance={allowance} />
          </section>
        </div>

        <p className="sp-sub">Per landed change</p>
        <Goals goals={apportionment.goals} unattributed={apportionment.unattributedPoints} />
      </div>
    </RefLinksExtended>
  );
}

function Headline({ allowance, now }: { allowance: AllowanceInsights; now: number }): JSX.Element {
  const { observedPoints, attributedPoints, unattributedPoints, pointsPerUsd } = allowance.apportionment;
  const observed = observedPoints ?? 0;
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well sp-key">
        <Label dense>Allowance spent</Label>
        <span className="vl">{fmtPoints(observed)}</span>
        <span className="sb">
          of the five-hour window, over {allowance.readings.length} readings · last {relTime(lastAt(allowance), now)}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Charged to a goal</Label>
        <span className="vl">{fmtPoints(attributedPoints)}</span>
        <span className="sb">{fmtShare(attributedPoints, observed)} of the rise, apportioned by cost share</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Unattributed</Label>
        <span className="vl">{fmtPoints(unattributedPoints)}</span>
        <span className="sb">moved with no fleet spend to explain it — your own sessions, and local runs</span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Per dollar</Label>
        <span className="vl">{pointsPerUsd === null ? '—' : fmtPoints(pointsPerUsd)}</span>
        <span className="sb">
          {pointsPerUsd === null
            ? 'nothing measured spent in this window'
            : 'of allowance per dollar — the rate the split rests on'}
        </span>
      </div>
    </div>
  );
}

const T = { left: 210, right: 962, top: 26, bottom: 196 };
const VIEW = 1000;
const MAX_ROWS = 8;

function pct(units: number): string {
  return `${(units / VIEW) * 100}%`;
}

function Timeline({ allowance, now }: { allowance: AllowanceInsights; now: number }): JSX.Element {
  const { readings } = allowance;
  const startMs = Date.parse(allowance.window.startsAt);
  const span = Math.max(1, now - startMs);
  const frac = (iso: string): number => (Date.parse(iso) - startMs) / span;
  const x = (iso: string): number => T.left + frac(iso) * (T.right - T.left);
  const y = (pctUsed: number): number => T.bottom - (pctUsed / 100) * (T.bottom - T.top);

  const allRows = laneRows(allowance);
  const rows = allRows.slice(0, MAX_ROWS);
  const { tip, show, hide, wrap } = useTip();

  const segments: AllowanceReading[][] = [];
  for (const reading of readings) {
    if (reading.fiveHour === null) continue;
    const open = segments.at(-1);
    if (open === undefined || reading.afterReset || reading.afterGap) segments.push([reading]);
    else open.push(reading);
  }
  const drawn = readings.filter((r): r is AllowanceReading & { fiveHour: number } => r.fiveHour !== null);
  const last = drawn.at(-1) ?? null;
  const held = tip?.at ?? null;
  const marked = held === null ? null : (drawn.find((r) => r.at === held) ?? null);

  const idle = readings.flatMap((reading, i) => {
    const previous = readings[i - 1];
    if (!reading.afterGap || previous === undefined) return [];
    return [{ key: reading.at, from: frac(previous.at), to: frac(reading.at), previous, reading }];
  });

  return (
    <div className="sp-graph al-wide sp-well">
      <div className="al-chart" ref={wrap}>
        <svg
          viewBox={`0 0 ${VIEW} ${T.bottom + 28}`}
          role="img"
          aria-label={`Account five-hour window over ${allowance.window.label.toLowerCase()}`}
          onMouseMove={(e) => {
            const at = readingAt(e, drawn, startMs, span);
            if (at === null) hide();
            else show(e, readingTip(at, now), at.at);
          }}
          onMouseLeave={hide}
        >
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

          {/* What the harness did not watch, drawn as one column: the rise across it
              is counted, and the shading says only that nothing was there to see it
              happen. Every lane track below shades the same fractions. */}
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

        <p className="al-cap al-band-cap">AGENTS RUNNING</p>
        <div className="al-band" style={{ gridTemplateColumns: `${pct(T.left - 12)} ${pct(T.right - T.left)}` }}>
          {rows.map((row) => (
            <Fragment key={row.key}>
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

interface Tip {
  x: number;
  y: number;
  lines: string[];
  at: string | null;
}

function useTip(): {
  tip: Tip | null;
  show: (e: { clientX: number; clientY: number }, lines: string[], at: string | null) => void;
  hide: () => void;
  wrap: RefObject<HTMLDivElement>;
} {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: { clientX: number; clientY: number }, lines: string[], at: string | null): void => {
    const box = wrap.current?.getBoundingClientRect();
    if (box === undefined) return;
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, lines, at });
  };
  return { tip, show, hide: () => setTip(null), wrap };
}

function TipLayer({ tip }: { tip: Tip | null }): JSX.Element | null {
  if (tip === null) return null;
  return (
    <div className="al-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }} role="status">
      {tip.lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

function showOn(
  el: HTMLElement,
  lines: string[],
  show: (e: { clientX: number; clientY: number }, lines: string[], at: string | null) => void,
): void {
  const box = el.getBoundingClientRect();
  show({ clientX: box.left + box.width / 2, clientY: box.top }, lines, null);
}

function readingAt(
  e: { clientX: number; currentTarget: SVGSVGElement },
  drawn: readonly (AllowanceReading & { fiveHour: number })[],
  startMs: number,
  span: number,
): (AllowanceReading & { fiveHour: number }) | null {
  const box = e.currentTarget.getBoundingClientRect();
  if (box.width === 0 || drawn.length === 0) return null;
  const units = ((e.clientX - box.left) / box.width) * VIEW;
  if (units < T.left || units > T.right) return null;
  const at = startMs + ((units - T.left) / (T.right - T.left)) * span;
  return drawn.reduce((best, reading) =>
    Math.abs(Date.parse(reading.at) - at) < Math.abs(Date.parse(best.at) - at) ? reading : best,
  );
}

function readingTip(reading: AllowanceReading & { fiveHour: number }, now: number): string[] {
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

function GoalBar({ apportionment }: { apportionment: AllowanceApportionment }): JSX.Element {
  const { goals, observedPoints, unattributedPoints } = apportionment;
  const total = observedPoints ?? 0;
  const { tip, show, hide, wrap } = useTip();
  return (
    <>
      <div className="al-chart" ref={wrap}>
        <div
          className="sp-bar sp-well"
          role="img"
          aria-label={goals
            .map((g) => `#${g.issueNumber} ${fmtPoints(g.points)}`)
            .concat(`unattributed ${fmtPoints(unattributedPoints)}`)
            .join(', ')}
        >
          {goals.map((goal) => (
            <span
              key={goal.issueNumber}
              className="sg"
              style={{ width: `${share(goal.points, total)}%`, background: `var(--al-goal-${goal.slot})` }}
              onMouseMove={(e) =>
                show(
                  e,
                  [
                    `#${goal.issueNumber} ${goal.title ?? 'no longer on the tracker'}`,
                    `${fmtPoints(goal.points)} of the window (${fmtShare(goal.points, total)})`,
                  ],
                  null,
                )
              }
              onMouseLeave={hide}
            />
          ))}
          <span
            className="sg al-residual"
            style={{ width: `${share(unattributedPoints, total)}%` }}
            onMouseMove={(e) =>
              show(
                e,
                [
                  `Unattributed: ${fmtPoints(unattributedPoints)}`,
                  'the account moved while no fleet agent was spending',
                ],
                null,
              )
            }
            onMouseLeave={hide}
          />
        </div>
        <TipLayer tip={tip} />
      </div>
      <p className="sp-note">
        {fmtPoints(total)} of the five-hour allowance went in this window. Hover a segment for the goal it is charged
        to.
      </p>
    </>
  );
}

const P = { left: 44, right: 596, top: 12, bottom: 96 };

function Projection({ allowance }: { allowance: AllowanceInsights }): JSX.Element {
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

function Goals({ goals, unattributed }: { goals: readonly AllowanceGoal[]; unattributed: number }): JSX.Element {
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Goal</th>
          <th className="n">Allowance</th>
          <th className="n">Cost</th>
          <th className="n">Landed</th>
          <th className="n">Per landed</th>
        </tr>
      </thead>
      <tbody>
        {goals.map((goal) => (
          <tr key={goal.issueNumber}>
            <td>
              <span className="al-swatch" style={{ background: `var(--al-goal-${goal.slot})` }} />
              <Ref to={goal.originRef} />
              <span className="al-title">{goal.title ?? 'no longer on the tracker'}</span>
            </td>
            <td className="n">{fmtPoints(goal.points)}</td>
            <td className="n">{fmtUsd(goal.costUsd)}</td>
            <td className="n">{goal.landed}</td>
            <td className={goal.pointsPerLanded === null ? 'n al-warn' : 'n'}>
              {goal.pointsPerLanded === null ? 'nothing landed' : fmtPoints(goal.pointsPerLanded)}
            </td>
          </tr>
        ))}
        <tr className="al-residual-row">
          <td>
            <span className="al-swatch al-residual" />
            <span className="al-title">Unattributed — no goal to charge it to</span>
          </td>
          <td className="n">{fmtPoints(unattributed)}</td>
          <td className="n">—</td>
          <td className="n">—</td>
          <td className="n">—</td>
        </tr>
      </tbody>
    </table>
  );
}

function Method({ allowance }: { allowance: AllowanceInsights }): JSX.Element {
  const { pointsPerUsd } = allowance.apportionment;
  return (
    <p className="sp-note">
      Apportioned, not measured. The account reports one percentage for the whole fleet, so a goal&rsquo;s share is its
      cost inside each interval between readings — never a figure the account attributed to it.
      {pointsPerUsd === null
        ? ' Nothing measured spent in this window, so there is no rate behind the split.'
        : ` The split rests on ${fmtPoints(pointsPerUsd)} of allowance per dollar over this window; it moves with the model mix.`}{' '}
      A reading arrives only when an agent takes a turn, so an idle stretch has none and your own Claude Code spends
      from the same account &mdash; which is what the unattributed segment is.
    </p>
  );
}

function lastAt(allowance: AllowanceInsights): string {
  return allowance.readings.at(-1)?.at ?? allowance.generatedAt;
}

function fmtPoints(points: number): string {
  return `${points < 0.05 && points > 0 ? '<0.1' : points.toFixed(1)}%`;
}
