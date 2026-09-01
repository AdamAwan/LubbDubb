import type { JSX } from 'react';
import type {
  AllowanceApportionment,
  AllowanceInsights,
  AllowanceLane,
  AllowanceProjection,
  AllowanceReading,
} from '../types.js';
import { fmtUsd, relAge, relTime } from './util.js';
import { fmtDuration, fmtShare, share } from './insightsFormat.js';
import { Ref } from './refs.js';

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
export function AllowanceTab({ allowance }: { allowance: AllowanceInsights }): JSX.Element {
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

  return (
    <div className="sp al">
      <Headline allowance={allowance} now={now} />

      <p className="sp-sub">Over the window</p>
      <Timeline allowance={allowance} now={now} />

      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">Where it went</p>
          <GoalBar allowance={allowance} />
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

/** Geometry. Two stacked panels on one x axis, which is the timeline's whole argument. */
const T = { left: 44, right: 596, top: 12, bottom: 112, laneTop: 146, laneHeight: 13, laneGap: 3 };
/** How many lanes are drawn before the rest are folded into a count. */
const MAX_LANES = 8;

/**
 * The percentage over the window, with the agent runs beneath it.
 *
 * **The lanes are the point.** They let a reader see which agents were running
 * while the line climbed without the chart ever claiming that the tallest one
 * caused it — adjacency drawn honestly, which is all the readings can support.
 * The apportionment below is where a number per goal is offered, and it is
 * labelled as apportioned there.
 *
 * Two things are deliberately *not* joined. A reset (the window refilling) breaks
 * the line rather than drawing a cliff, which would read as the fleet having
 * given something back. A gap — the fleet idle, so no reading arrived — is drawn
 * dashed: the rise across it is real and counted, and what is unknown is what
 * happened inside it.
 */
function Timeline({ allowance, now }: { allowance: AllowanceInsights; now: number }): JSX.Element {
  const { readings } = allowance;
  const startMs = Date.parse(allowance.window.startsAt);
  const endMs = now;
  const span = Math.max(1, endMs - startMs);
  const x = (iso: string): number => T.left + ((Date.parse(iso) - startMs) / span) * (T.right - T.left);
  const y = (pct: number): number => T.bottom - (pct / 100) * (T.bottom - T.top);

  const lanes = allowance.lanes.slice(0, MAX_LANES);
  const height = T.laneTop + Math.max(1, lanes.length) * (T.laneHeight + T.laneGap) + 6;

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

  return (
    <div className="sp-graph sp-well">
      <svg
        viewBox={`0 0 620 ${height}`}
        role="img"
        aria-label={`Account five-hour window over ${allowance.window.label.toLowerCase()}, with ${lanes.length} agent runs beneath`}
      >
        <g stroke="var(--border-lo)" strokeWidth="1">
          {[0, 0.5, 1].map((f) => (
            <path key={f} d={`M${T.left} ${T.top + f * (T.bottom - T.top)}H${T.right}`} />
          ))}
        </g>
        <g className="sp-axis" textAnchor="end">
          {[0, 50, 100].map((pct) => (
            <text key={pct} x={T.left - 7} y={y(pct) + 3}>
              {pct}%
            </text>
          ))}
        </g>
        {/* A timeline with no time on it asks the reader to take the lanes'
            alignment on trust. Three marks rather than a full axis: the readings
            carry their own instants on hover, and what the eye needs here is
            where the window opened, its middle, and now. */}
        <g className="sp-axis">
          <text x={T.left} y={T.bottom + 14} textAnchor="start">
            {relAge(allowance.window.startsAt, now)}
          </text>
          <text x={(T.left + T.right) / 2} y={T.bottom + 14} textAnchor="middle">
            {relAge(new Date(startMs + span / 2).toISOString(), now)}
          </text>
          <text x={T.right} y={T.bottom + 14} textAnchor="end">
            now
          </text>
        </g>

        {segments.map((segment, i) => (
          <g key={segment[0]?.at ?? i}>
            <path className="al-line" d={stepPath(segment, x, y)} />
            {segment.map((reading) => (
              <circle key={reading.at} className="al-dot" cx={x(reading.at)} cy={y(reading.fiveHour ?? 0)} r="1.8">
                <title>
                  {`${fmtPoints(reading.fiveHour ?? 0)} used · ${relTime(reading.at, now)}`}
                  {reading.afterReset ? ' · the window reset just before this' : ''}
                  {reading.afterGap ? ' · the first reading after an idle stretch' : ''}
                </title>
              </circle>
            ))}
          </g>
        ))}
        {/* What the harness does not know, drawn as not knowing it: the rise across
            an idle stretch happened and is counted, and the dashes say only that
            nothing watched it happen. */}
        {readings.map((reading, i) => {
          const previous = readings[i - 1];
          if (!reading.afterGap || previous === undefined) return null;
          if (previous.fiveHour === null || reading.fiveHour === null) return null;
          return (
            <path
              key={`gap-${reading.at}`}
              className="al-gap"
              d={`M${x(previous.at)} ${y(previous.fiveHour)}L${x(reading.at)} ${y(reading.fiveHour)}`}
            />
          );
        })}

        <g>
          {lanes.map((lane, i) => {
            const top = T.laneTop + i * (T.laneHeight + T.laneGap);
            const from = x(lane.startedAt);
            // A run still going is drawn to now, which is where its money still is.
            const to = x(lane.endedAt ?? new Date(now).toISOString());
            return (
              <rect
                key={lane.agentId}
                className={lane.measured ? 'al-lane' : 'al-lane al-lane-unmeasured'}
                x={Math.max(T.left, from)}
                y={top}
                width={Math.max(2, Math.min(T.right, to) - Math.max(T.left, from))}
                height={T.laneHeight - 2}
                rx="2"
                fill={laneFill(lane)}
              >
                <title>{laneTitle(lane, now)}</title>
              </rect>
            );
          })}
        </g>
      </svg>
      <p className="sp-note">
        {lanes.length === allowance.lanes.length
          ? `${lanes.length} run${lanes.length === 1 ? '' : 's'} in this window, one lane each. `
          : `The ${MAX_LANES} most recent of ${allowance.lanes.length} runs. `}
        Which agents were running while it climbed — not which of them caused it.
      </p>
    </div>
  );
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

function laneTitle(lane: AllowanceLane, now: number): string {
  const what = lane.title ?? lane.agentId;
  const goal = lane.issueNumber === null ? 'reached no goal' : `#${lane.issueNumber}`;
  const when = lane.endedAt === null ? 'still running' : `ended ${relTime(lane.endedAt, now)}`;
  return `${what} · ${goal} · ${when}${lane.measured ? '' : ' · reported no usage (PTY)'}`;
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
function GoalBar({ allowance }: { allowance: AllowanceInsights }): JSX.Element {
  const { goals, observedPoints, unattributedPoints } = allowance.apportionment;
  const total = observedPoints ?? 0;
  return (
    <>
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
            title={`#${goal.issueNumber} ${goal.title ?? ''}: ${fmtPoints(goal.points)} of the window (${fmtShare(goal.points, total)})`}
          />
        ))}
        <span
          className="sg al-residual"
          style={{ width: `${share(unattributedPoints, total)}%` }}
          title={`Unattributed: ${fmtPoints(unattributedPoints)} — the account moved while no fleet agent was spending`}
        />
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
        <g stroke="var(--border-lo)" strokeWidth="1">
          {[0, 100].map((pct) => (
            <path key={pct} d={`M${P.left} ${y(pct)}H${P.right}`} />
          ))}
        </g>
        <g className="sp-axis" textAnchor="end">
          <text x={P.left - 7} y={y(100) + 3}>
            full
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
function Goals({ goals, unattributed }: { goals: AllowanceApportionment['goals']; unattributed: number }): JSX.Element {
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
