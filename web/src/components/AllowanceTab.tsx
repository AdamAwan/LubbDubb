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

/**
 * Allowance: what the account has spent, when it went, and on what.
 *
 * The usage chip says how much of the five hours is gone and can say nothing
 * else, because `account_rate_limits` keeps one row and overwrites it on every
 * turn. This tab is the series behind that number
 * ([14](../../../docs/spec/14-persistence.md)) drawn four ways, in the order an
 * operator asks:
 *
 * 1. **The timeline** — the percentage over the window, with every agent that ran
 *    beneath it on the same axis.
 * 2. **Where it went** — the same rise apportioned to the goals that were
 *    spending while it happened, with the remainder carried rather than divided.
 * 3. **The week** — whether the current pace reaches the weekly limit before the
 *    limit resets.
 * 4. **Per landed change** — the Economics tab's one sentence, re-denominated in
 *    percentage of the account rather than in dollars.
 *
 * **Nothing here is derived in the browser**, `EconomicsTab`'s rule and for its
 * reason: the reset test, the gap threshold and the apportionment are statements
 * about what the readings *mean*, and a cockpit free to compute its own would
 * draw a line the server's own totals disagree with. What the cockpit owns is
 * presentation — the goal colours, which live in the stylesheet as `--al-*`.
 *
 * **A point is one percent of the window, and the word is used on purpose.** The
 * money on the Economics tab is measured; a percentage per goal is apportioned,
 * and every surface here says which it is rather than leaving a reader to assume
 * the two figures were arrived at the same way.
 *
 * → docs/spec/17-cockpit.md#allowance
 */
export function AllowanceTab({ payload }: { payload: AllowancePayload }): JSX.Element {
  const { allowance, refUrls } = payload;
  const now = Date.parse(allowance.generatedAt);
  const { apportionment } = allowance;

  // Two readings make a change; one makes a level. A window that caught fewer is
  // a real state on a paused fleet and not an empty one, and drawing zeros over
  // it would say the account did not move when what happened is that nothing
  // watched it.
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

  // The route's own URLs merged over the shell's, which is what makes the goal
  // numbers on this tab links: a goal that spent inside the window has usually
  // closed, and the snapshot's map is built from the world it has since left.
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

/**
 * What the window came to, in the three figures the rest of the tab breaks down.
 *
 * The calibration constant sits here rather than in the method note, because it
 * is the one reading on this tab that is *about* the apportionment rather than a
 * product of it: it moves with the model mix, and an operator who watches it
 * drift is being told that something outside the fleet is eating the account.
 */
function Headline({ allowance, now }: { allowance: AllowanceInsights; now: number }): JSX.Element {
  const { observedPoints, attributedPoints, unattributedPoints, pointsPerUsd } = allowance.apportionment;
  const observed = observedPoints ?? 0;
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well sp-key">
        <span className="lb">Allowance spent</span>
        <span className="vl">{fmtPoints(observed)}</span>
        <span className="sb">
          of the five-hour window, over {allowance.readings.length} readings · last {relTime(lastAt(allowance), now)}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Charged to a goal</span>
        <span className="vl">{fmtPoints(attributedPoints)}</span>
        <span className="sb">{fmtShare(attributedPoints, observed)} of the rise, apportioned by cost share</span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Unattributed</span>
        <span className="vl">{fmtPoints(unattributedPoints)}</span>
        <span className="sb">moved with no fleet spend to explain it — your own sessions, and local runs</span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Per dollar</span>
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

/**
 * Geometry of the plot. The lane band below it is HTML on the same fractions of
 * the same box, which is what lets a row carry a link and a readout that arrives
 * with the pointer rather than a second later.
 */
const T = { left: 210, right: 962, top: 26, bottom: 196 };
/** The viewBox the plot is laid out in. Wider than the page's others: it has a gutter to pay for. */
const VIEW = 1000;
/** How many goal rows are drawn before the rest are folded into a count. */
const MAX_ROWS = 8;

/** A fraction of the chart's width, as the percentage the band is laid out in. */
function pct(units: number): string {
  return `${(units / VIEW) * 100}%`;
}

/**
 * The percentage over the window, with the agent runs beneath it.
 *
 * **The lanes are the point.** They let a reader see which agents were running
 * while the line climbed without the chart ever claiming that the tallest one
 * caused it — adjacency drawn honestly, which is all the readings can support.
 * The apportionment below is where a number per goal is offered, and it is
 * labelled as apportioned there.
 *
 * **A row is a goal, not a run.** Two dispatches onto one goal are two bars in
 * one row, which is what lets the row carry a name in the gutter — and the name
 * is a `<Ref>`, so the row is a way *to* the goal rather than a mention of it.
 * Rows come in the apportionment's order, so the table at the foot of the tab
 * reads as the same list twice rather than two orders to reconcile.
 *
 * **The band is HTML and the plot is SVG, on one set of fractions.** The band is
 * a gutter and some bars on a linear time axis, which HTML draws as well as SVG
 * does — and drawing it in the document buys the two things SVG was costing: a
 * gutter that can hold a link, and a readout that is this cockpit's own rather
 * than the browser's `<title>` tooltip, which arrives after a second, cannot be
 * styled, and never arrives at all on a touch screen. Both are laid out in
 * percentages of the same box, so a bar still stands under the stretch of line it
 * ran during.
 *
 * Two things are deliberately *not* joined. A reset (the window refilling) breaks
 * the line rather than drawing a cliff, which would read as the fleet having
 * given something back. A gap — the fleet idle, so no reading arrived — is drawn
 * as a shaded column through both panels and a dashed connector: the rise across
 * it is real and counted, and what is unknown is what happened inside it.
 */
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

  // Each unbroken run of readings is its own path: a break is a reset or a gap,
  // and a single path through them would draw a line across a discontinuity the
  // data explicitly marks.
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

  // The idle stretches, as one list both panels read: the plot shades them and
  // every lane track shades the same fractions, which is the whole of why the
  // band can be a different element and still agree with the line above it.
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
          // The whole plot is the hover target, and the reading it answers with is
          // the nearest one: a dot is three units across, and a chart that asks a
          // pointer to find one is a chart with no hover at all.
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
                  // A run still going is drawn to now, which is where its money still is.
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
                      // A run is not a control — there is nowhere in the cockpit to
                      // send a click from here — but focus is how a reader without a
                      // pointer reaches the readout, and only a focusable element has
                      // any. The goal's own way through is the `<Ref>` in the gutter.
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

/** What the readout says and where it stands, in the chart's own coordinates. */
interface Tip {
  x: number;
  y: number;
  lines: string[];
  /** The reading it is about, so the plot can mark it. Null for a lane. */
  at: string | null;
}

/**
 * The chart's one readout.
 *
 * One for the plot and the band together, because two would be two answers on
 * one screen: a pointer is in one place, and the thing under it is either a
 * reading or a run.
 */
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

/**
 * The readout itself, drawn over whichever chart is holding it.
 *
 * It never takes the pointer: a tooltip that can be hovered is one that flickers
 * as the pointer crosses onto it and off again.
 */
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

/** The readout put on an element rather than under a pointer — what focus gets. */
function showOn(
  el: HTMLElement,
  lines: string[],
  show: (e: { clientX: number; clientY: number }, lines: string[], at: string | null) => void,
): void {
  const box = el.getBoundingClientRect();
  show({ clientX: box.left + box.width / 2, clientY: box.top }, lines, null);
}

/** The reading nearest the pointer, or null where the pointer is off the plot. */
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

/** What the readout says about one reading. */
function readingTip(reading: AllowanceReading & { fiveHour: number }, now: number): string[] {
  const lines = [`${fmtPoints(reading.fiveHour)} of the five-hour window used`, relTime(reading.at, now)];
  if (reading.afterReset) lines.push('the window reset just before this');
  if (reading.afterGap) lines.push('the first reading after an idle stretch');
  return lines;
}

/** Where the grid stands and the axis is labelled, as fractions of the window. */
const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** One row of the lane band: a goal, and every run of the window that reached it. */
type LaneRow = {
  key: string;
  /** Null on the row the runs that reached no goal share — an absence has no ref. */
  issueNumber: number | null;
  title: string | null;
  slot: number | null;
  lanes: AllowanceLane[];
};

/**
 * The window's runs, gathered into one row per goal.
 *
 * Ordered by the apportionment rather than by when a run started, so the band and
 * the table at the foot of the tab are the same list in the same order — a reader
 * who has just read one is not re-learning the other. Goals the apportionment
 * does not carry (a run that spent nothing measurable) follow, and the runs that
 * reached no goal at all share the last row: they are an absence, and an absence
 * is one row however many agents are in it.
 */
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
  // A goal with no run in this window is a row of empty track, which says nothing
  // the table does not; the band is about what ran.
  return [...rows.values()].filter((row) => row.lanes.length > 0);
}

/**
 * A step path through one unbroken run of readings.
 *
 * Steps rather than a smooth line, because that is what the data is: the
 * percentage is known at each reading and unknown between two, so a diagonal
 * would draw a rate of consumption nothing measured.
 */
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

/** A lane's colour: its goal's slot, or the muted one where it reached none. */
function laneFill(lane: AllowanceLane): string {
  if (!lane.measured) return 'var(--al-unmeasured)';
  if (lane.slot === null) return 'var(--al-unattributed)';
  return `var(--al-goal-${lane.slot})`;
}

/**
 * What the readout says about one run — a line at a time, because the readout is
 * this cockpit's own element rather than a browser tooltip and can hold them.
 */
function laneTip(lane: AllowanceLane, now: number): string[] {
  const goal = lane.issueNumber === null ? 'reached no goal' : `#${lane.issueNumber}`;
  const when = lane.endedAt === null ? 'still running' : `ended ${relTime(lane.endedAt, now)}`;
  const lines = [lane.title ?? lane.agentId, `${goal} · started ${relTime(lane.startedAt, now)} · ${when}`];
  if (!lane.measured) lines.push('reported no usage (PTY)');
  return lines;
}

/**
 * The rise, split — one bar rather than a second graph over time.
 *
 * The time dimension is the timeline's, above, and drawing it twice would put two
 * x axes on one tab for a reader to reconcile. What this adds is the split, and a
 * bar is the shortest way to say it. `EconomicsTab`'s phase bar is the same
 * component decision about the same kind of partition.
 *
 * **The residual is a segment, not a rounding error.** It is the part of the rise
 * that no fleet spend explains, and it is drawn at the end of the bar at full
 * width rather than folded into the goals — dividing it among them is the one
 * thing the readings cannot support.
 */
function GoalBar({ apportionment }: { apportionment: AllowanceApportionment }): JSX.Element {
  const { goals, observedPoints, unattributedPoints } = apportionment;
  const total = observedPoints ?? 0;
  // The timeline's readout, on the timeline's reasoning: a segment is a few
  // pixels tall, and a browser tooltip over it arrives a second late, unstyled,
  // and never at all under a finger.
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

/** Geometry for the burn-down, which is a different shape from the timeline's. */
const P = { left: 44, right: 596, top: 12, bottom: 96 };

/**
 * The weekly burn-down: does this pace reach the limit before the limit resets.
 *
 * The only reading on this tab that can be acted on **before** the fact, which is
 * why it is always about the seven-day window whatever span the page is on — an
 * operator who cuts the cap because of it cuts it for the week.
 *
 * The projection is drawn dashed and its fit is stated, because a rate taken over
 * a turn-bound series across a quiet weekend is a line through very few dots. A
 * verdict this confident has to carry how much it is standing on.
 */
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
  // A margin past the last mark, so the reset line is never *on* the right edge —
  // its label has to sit somewhere, and a label on the boundary is a label half
  // outside the viewBox whichever way it is anchored.
  const endMs = Math.max(startMs + 3_600_000, ...ends.map((ms) => startMs + (ms - startMs) * 1.08));
  const span = Math.max(1, endMs - startMs);
  const x = (ms: number): number => P.left + ((ms - startMs) / span) * (P.right - P.left);
  // Headroom down the panel the way a tank empties: full at the top, spent at the
  // floor. Inverted, a line running *out* of allowance climbs — which reads as
  // the one thing it is not.
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

/** Kept off the left edge, where a centred label would collide with `now`. */
function mark(at: number): number {
  return Math.max(P.left + 46, at);
}

/**
 * True when the reset line has room for its own span beside the exhaustion mark.
 *
 * The two are often within a day of each other, which is the whole of what the
 * verdict below is about — and two spans a few pixels apart read as one figure
 * disagreeing with itself. The sentence carries both either way, so the chart
 * drops the second rather than crowding it.
 */
function farApart(resetX: number, exhaustsAt: string | null, x: (ms: number) => number): boolean {
  if (exhaustsAt === null) return true;
  return Math.abs(resetX - x(Date.parse(exhaustsAt))) > 80;
}

/**
 * The burn-down in one sentence — the thing an operator reads and acts on.
 *
 * The spans are `fmtDuration`, not the cockpit's usual `untilTime`: these are days
 * and hours away, and a countdown that stops at minutes turns "about a day and a
 * half" into a four-digit number of minutes nobody reads at a glance.
 */
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

/**
 * The Economics tab's sentence in percentage rather than dollars.
 *
 * A goal that consumed a tenth of the account and landed nothing is the most
 * important row here, so it renders as that sentence rather than as a symbol —
 * `pointsPerLanded` is null rather than `Infinity` on the wire for exactly this.
 */
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

/**
 * What the figures on this tab are, said where they are read rather than at the
 * foot of the page.
 *
 * The caveats are worth more level with the numbers they qualify: an apportioned
 * percentage read as a measured one is the single misreading this tab can cause,
 * and it is the operator's own Claude Code that makes it likely — that spend is
 * real, it is on the same account, and no goal here can be charged for it.
 */
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

/** The most recent reading's instant — what the headline dates itself by. */
function lastAt(allowance: AllowanceInsights): string {
  return allowance.readings.at(-1)?.at ?? allowance.generatedAt;
}

/**
 * A point, to one place.
 *
 * One place rather than the wire's six: the readings themselves arrive at two
 * decimal places at best, and a share printed to more than the source carries
 * claims a precision the account never reported.
 */
function fmtPoints(points: number): string {
  return `${points < 0.05 && points > 0 ? '<0.1' : points.toFixed(1)}%`;
}
