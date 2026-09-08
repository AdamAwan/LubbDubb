import type { JSX } from 'react';
import type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun, SpendTrend } from '../types.js';
import { fmtTokens, fmtUsd, relAge, relTime } from './util.js';
import { fmtShare, localPhaseCostUsd, share, PLOT } from './insightsFormat.js';
import { Ref } from './refs.js';
import { toCsv } from './Downloads.js';
import { Label } from './label.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/17-cockpit.md

export function EconomicsTab({ insights }: { insights: SpendInsights }): JSX.Element {
  const { totals } = insights;
  if (totals.measuredRuns === 0) {
    return (
      <p className="empty">
        {totals.unmeasuredRuns === 0
          ? `No agent ran in this window, so there is nothing to break down.`
          : `${totals.unmeasuredRuns} run${totals.unmeasuredRuns === 1 ? '' : 's'} in this window, none of which ` +
            'reported any usage — PTY agents report none. Nothing here is zero; it is unmeasured.'}
      </p>
    );
  }

  return (
    <div className="sp">
      <Ratio insights={insights} />
      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">Where it went</p>
          <PhaseBar phases={insights.phases} total={totals.costUsd} />
          <PhaseKey phases={insights.phases} total={totals.costUsd} />
        </section>
        <section className="sp-col">
          <p className="sp-sub">Cost over the window</p>
          <Timeline insights={insights} />
          {/* The method note rides under the graph rather than at the foot of the
              page. The phase table beside it is the tallest thing here, so this
              column has the room — and the caveats are worth more level with the
              figures they qualify than three screens below them. */}
          <Method insights={insights} />
        </section>
      </div>

      <p className="sp-sub">By goal</p>
      <Goals goals={insights.goals} unattributedCostUsd={insights.unattributedCostUsd} total={totals.costUsd} />

      <p className="sp-sub">Costliest runs</p>
      <Runs runs={insights.runs} rankedFrom={insights.rankedFrom} />
    </div>
  );
}

function Ratio({ insights }: { insights: SpendInsights }): JSX.Element {
  const { totals, landed, lostCostUsd } = insights;
  const perLanded = landed > 0 ? totals.costUsd / landed : null;
  return (
    <div className="sp-tiles sp-ratio">
      <div className="sp-tile sp-well">
        <Label dense>Spent</Label>
        <span className="vl">{fmtUsd(totals.costUsd)}</span>
        <span className="sb">
          {totals.measuredRuns} run{totals.measuredRuns === 1 ? '' : 's'} measured
        </span>
      </div>
      <div className="sp-op" aria-hidden="true">
        ÷
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Landed</Label>
        <span className="vl">{landed}</span>
        <span className="sb">pull requests merged in this window</span>
      </div>
      <div className="sp-op" aria-hidden="true">
        =
      </div>
      <div className="sp-tile sp-well sp-key">
        <Label dense>Per landed change</Label>
        <span className="vl">{perLanded === null ? '—' : fmtUsd(perLanded)}</span>
        <span className="sb">
          {perLanded === null ? 'nothing landed in this window' : 'what one merged change cost the fleet'}
        </span>
      </div>
      <div className="sp-tile sp-well sp-leak">
        <Label dense>Never landed</Label>
        <span className="vl">{fmtUsd(lostCostUsd)}</span>
        <span className="sb">
          {fmtShare(lostCostUsd, totals.costUsd)} of it — runs that failed or crashed. A killed run is a steer and is
          not counted here.
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Tokens</Label>
        <span className="vl">
          {fmtTokens(totals.inputTokens)}
          <small>→</small>
          {fmtTokens(totals.outputTokens)}
        </span>
        {/* The cached share of the input, not a rate per Mtok. Both move when
            caching does, but this one says so directly: the rate was only ever a
            proxy — cost already has the discount in it, so a warm fleet made the
            rate read cheap and left the reader to infer why. Denominator is the
            input of runs that reported a breakdown, never the fleet's whole
            input. See the note at the foot. */}
        <span className="sb">
          {totals.cacheMeasuredInputTokens > 0
            ? `${fmtShare(totals.cacheReadTokens, totals.cacheMeasuredInputTokens)} of input from cache`
            : totals.inputTokens > 0
              ? 'cache share unmeasured'
              : 'no input measured'}
        </span>
      </div>
    </div>
  );
}

export function spendCsv(insights: SpendInsights, trend: SpendTrend | null = null): string {
  const { totals, phases, goals, runs, timeline, taskTypes, checks } = insights;
  const order = phases.map((p) => p.phase);
  const localCost = localPhaseCostUsd(insights);

  return toCsv([
    ['Totals'],
    ['Measure', 'Value'],
    ['Window', insights.window.label],
    ['Window opened (ISO)', insights.window.since ?? 'no lower bound — all time'],
    ['Cost in window (USD)', totals.costUsd],
    ['Pull requests landed in window', insights.landed],
    ['Cost of runs that failed or crashed (USD)', insights.lostCostUsd],
    ['Input tokens', totals.inputTokens],
    ['Output tokens', totals.outputTokens],
    ['Cache read tokens', totals.cacheReadTokens],
    ['Cache write tokens', totals.cacheCreationTokens],
    ['Input tokens with a cache breakdown', totals.cacheMeasuredInputTokens],
    ['Turns', totals.turns],
    ['Measured runs', totals.measuredRuns],
    ['Unmeasured runs', totals.unmeasuredRuns],
    ['Reached no goal (USD)', insights.unattributedCostUsd],
    ['Generated (ISO)', insights.generatedAt],
    [],

    ['Phases'],
    ['Phase', 'Label', 'Definition', 'Cost (USD)', 'Runs', 'Input tokens', 'Output tokens'],
    ...phases.map((p) => [p.phase, p.label, p.blurb, p.costUsd, p.runs, p.inputTokens, p.outputTokens]),
    [],

    ['Daily'],
    ['Bucket start (ISO)', 'Cost (USD)'],
    ...timeline.buckets.map((b) => [b.startsAt, b.costUsd]),
    [],

    ['Task types'],
    ['Rule', 'Label', 'Rationale', 'Cost (USD)', 'Runs', 'Per run (USD)'],
    ...taskTypes.map((t) => [t.rule, t.label, t.description, t.costUsd, t.runs, t.perRunUsd]),
    ...(localCost > 0 ? [['', 'Local runs — no dispatch rule', localCost]] : []),
    [],

    ['Failing checks'],
    ['Check', 'Cost (USD)', 'Runs', 'Sole-cause runs', 'Per run (USD)', 'Last (ISO)'],
    ...checks.checks.map((c) => [c.name, c.costUsd, c.runs, c.soleRuns, c.perRunUsd, c.lastAt]),
    ['Named no check', checks.unnamedCostUsd],
    ['Attributed to a check', checks.attributedCostUsd],
    [
      `The ${checks.checks.length} costliest of ${checks.seen} checks seen. A run red on two checks splits its cost ` +
        'evenly between them, so these rows sum to the attributed total and never overstate it.',
    ],
    [],

    ['Goals'],
    ['Issue', 'Title', 'Cost (USD)', 'Runs', 'Input tokens', 'Output tokens', 'Last activity (ISO)', ...order],
    ...goals.map((g) => [
      g.issueNumber,
      g.title,
      g.costUsd,
      g.agents,
      g.inputTokens,
      g.outputTokens,
      g.lastAt,
      ...order.map((p) => g.byPhase[p]),
    ]),
    ['', 'Reached no goal', insights.unattributedCostUsd],
    [],

    ['Runs'],
    [
      'Run',
      'Kind',
      'Origin',
      'Title',
      'Phase',
      'Issue',
      'Cost (USD)',
      'Input tokens',
      'Output tokens',
      'Turns',
      'Started (ISO)',
      'Ended (ISO)',
    ],
    ...runs.map((r) => [
      r.id,
      r.kind,
      r.originRef,
      r.title,
      r.phase,
      r.issueNumber,
      r.costUsd,
      r.inputTokens,
      r.outputTokens,
      r.numTurns,
      r.startedAt,
      r.endedAt,
    ]),
    [`The ${runs.length} costliest of ${insights.rankedFrom} measured runs.`],

    ...(trend === null
      ? [[], ['Trend'], ['The trend tab was not opened, so its weeks are not in this file.']]
      : trendCsv(trend, order)),
  ]);
}

function trendCsv(trend: SpendTrend, order: readonly SpendPhase[]): (string | number | null)[][] {
  const { comparison } = trend;
  return [
    [],
    ['Trend — weeks'],
    [
      'Week start (ISO)',
      'Still filling',
      'Goals closed',
      'Goals with no spend',
      'Median cost (USD)',
      'Median input tokens',
      'Reopened',
      'Runs settled',
      'Runs finished',
      'Lost run cost (USD)',
      'CI reds',
      'Every goal cost (USD)',
      ...order.map((p) => `${p} per goal (USD)`),
    ],
    ...trend.buckets.map((w) => [
      w.startsAt,
      w.partial ? 'yes' : 'no',
      w.goalsClosed,
      w.goalsUnmeasured,
      w.medianCostUsd,
      w.medianInputTokens,
      w.reopened,
      w.settled,
      w.completed,
      w.lostCostUsd,
      w.reds,
      w.costs.join(' '),
      ...order.map((p) => w.byPhase[p]),
    ]),
    [
      'Cost, tokens, the stage split and reopens belong to the goals that closed that week. Runs settled and CI reds ' +
        'are what was observed inside the week itself. The last week is still filling.',
    ],
    [],

    ['Trend — halves'],
    ...(comparison === null
      ? [['Too few complete weeks to compare halves — two either side are needed.']]
      : [
          [
            'Half',
            'From (ISO)',
            'To (ISO)',
            'Weeks',
            'Goals closed',
            'Median cost (USD)',
            'Median input tokens',
            'Runs finished (rate)',
            'Lost run cost per goal (USD)',
            'CI reds per goal',
            'Reopened (rate)',
          ],
          ...([comparison.earlier, comparison.recent] as const).map((p, i) => [
            i === 0 ? 'earlier' : 'recent',
            p.startsAt,
            p.endsAt,
            p.weeks,
            p.goalsClosed,
            p.medianCostUsd,
            p.medianInputTokens,
            p.completionRate,
            p.lostCostPerGoalUsd,
            p.redsPerGoal,
            p.reopenedRate,
          ]),
          [],
          ['Trend — stage shift'],
          ['Stage', 'Share then', 'Share now', 'USD per goal then', 'USD per goal now', 'Change (ratio)'],
          ...comparison.phases.map((p) => [
            p.phase,
            p.earlierShare,
            p.recentShare,
            p.earlierUsd,
            p.recentUsd,
            p.changeRatio,
          ]),
          [
            'Read the dollar columns with the share columns: a stage whose share rose while its dollars fell did not ' +
              'get more expensive.',
          ],
        ]),
  ];
}

function PhaseBar({ phases, total }: { phases: readonly SpendPhaseTotal[]; total: number }): JSX.Element {
  return (
    <div
      className="sp-bar sp-well"
      role="img"
      aria-label={phases.map((p) => `${p.label} ${fmtUsd(p.costUsd)}`).join(', ')}
    >
      {phases.map((p) => (
        <span
          key={p.phase}
          className="sg"
          style={{ width: `${share(p.costUsd, total)}%`, background: `var(--sp-${p.phase})` }}
          title={`${p.label}: ${fmtUsd(p.costUsd)} (${fmtShare(p.costUsd, total)})`}
        />
      ))}
    </div>
  );
}

function PhaseKey({ phases, total }: { phases: readonly SpendPhaseTotal[]; total: number }): JSX.Element {
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Phase</th>
          <th className="n">Cost</th>
          <th className="n">Share</th>
          <th className="n">Runs</th>
          <th className="n">Each</th>
        </tr>
      </thead>
      <tbody>
        {phases.map((p) => (
          <tr key={p.phase}>
            <td>
              <span className="sw" style={{ background: `var(--sp-${p.phase})` }} />
              <span className="nm" title={p.blurb}>
                {p.label}
              </span>
              <span className="bl">{p.blurb}</span>
            </td>
            <td className="n b">{fmtUsd(p.costUsd)}</td>
            <td className="n">{fmtShare(p.costUsd, total)}</td>
            <td className="n">{p.runs}</td>
            <td className="n">{fmtUsd(p.costUsd / p.runs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Timeline({ insights }: { insights: SpendInsights }): JSX.Element {
  const { buckets } = insights.timeline;
  const count = buckets.length;
  const opened = relAge(insights.window.startsAt, Date.parse(insights.generatedAt));
  const each = fmtSpan(insights.window.bucketMs);
  const peak = Math.max(...buckets.map((b) => b.costUsd), 0);
  const top = Math.max(peak, 0.01);
  const width = (PLOT.right - PLOT.left) / count;
  const height = PLOT.bottom - PLOT.top;
  const total = buckets.reduce((a, b) => a + b.costUsd, 0);

  return (
    <div className="sp-graph sp-well">
      <svg
        viewBox="0 0 620 176"
        role="img"
        aria-label={`Spend from ${opened} to now in ${each} buckets, ${fmtUsd(total)} in total`}
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
        {buckets.map((b, i) => {
          const h = (b.costUsd / top) * height;
          return (
            <rect
              key={b.startsAt}
              x={PLOT.left + i * width + 1.5}
              y={PLOT.bottom - h}
              width={Math.max(1, width - 3)}
              height={Math.max(b.costUsd > 0 ? 1 : 0, h)}
              fill="var(--accent)"
              opacity={i === count - 1 ? 1 : 0.72}
            >
              <title>{`${fmtUsd(b.costUsd)} — the ${each} from ${new Date(b.startsAt).toLocaleString()}`}</title>
            </rect>
          );
        })}
        <g className="sp-axis" textAnchor="middle">
          <text x={PLOT.left + width / 2} y="170">
            {opened}
          </text>
          <text x={PLOT.right - width / 2} y="170">
            now
          </text>
        </g>
      </svg>
    </div>
  );
}

function fmtSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return hours < 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function GoalBar({ goal, total }: { goal: SpendGoal; total: number }): JSX.Element {
  const order: SpendPhase[] = ['deliberation', 'build', 'ci', 'landing', 'evidence', 'obstacle', 'job', 'other'];
  return (
    <span className="sp-gbar" style={{ width: `${Math.max(share(goal.costUsd, total), 1.5)}%` }}>
      {order
        .filter((p) => goal.byPhase[p] > 0)
        .map((p) => (
          <span
            key={p}
            className="sg"
            style={{ width: `${share(goal.byPhase[p], goal.costUsd)}%`, background: `var(--sp-${p})` }}
            title={`${p}: ${fmtUsd(goal.byPhase[p])}`}
          />
        ))}
    </span>
  );
}

function Goals({
  goals,
  unattributedCostUsd,
  total,
}: {
  goals: readonly SpendGoal[];
  unattributedCostUsd: number;
  total: number;
}): JSX.Element {
  if (goals.length === 0 && unattributedCostUsd === 0) {
    return <p className="empty">No goal has cost anything yet.</p>;
  }
  return (
    <table className="sp-tbl wide">
      <thead>
        <tr>
          <th>Goal</th>
          <th className="n">Cost</th>
          <th className="n">Share</th>
          <th className="bar">Split</th>
          <th className="n">Runs</th>
          <th className="n">Tokens</th>
          <th className="n">Last</th>
        </tr>
      </thead>
      <tbody>
        {goals.map((g) => (
          <tr key={g.originRef}>
            <td>
              <span className="nm">
                <b>
                  <Ref to={`issue:${g.issueNumber}`} />
                </b>{' '}
                {g.title ?? <i className="sp-gone">title not recorded</i>}
              </span>
            </td>
            <td className="n b">{fmtUsd(g.costUsd)}</td>
            <td className="n">{fmtShare(g.costUsd, total)}</td>
            <td className="bar">
              <GoalBar goal={g} total={total} />
            </td>
            <td className="n">{g.agents}</td>
            <td className="n">
              {fmtTokens(g.inputTokens)}→{fmtTokens(g.outputTokens)}
            </td>
            <td className="n">{g.lastAt ? relTime(g.lastAt) : '—'}</td>
          </tr>
        ))}
        {unattributedCostUsd > 0 && (
          <tr className="rest">
            <td>
              <span className="nm">Reached no goal</span>
              <span className="bl">A job nobody linked to a ticket, or an agent dispatched against no origin</span>
            </td>
            <td className="n b">{fmtUsd(unattributedCostUsd)}</td>
            <td className="n">{fmtShare(unattributedCostUsd, total)}</td>
            <td className="bar" />
            <td className="n">—</td>
            <td className="n">—</td>
            <td className="n">—</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Runs({ runs, rankedFrom }: { runs: readonly SpendRun[]; rankedFrom: number }): JSX.Element {
  if (runs.length === 0) return <p className="empty">Nothing has been measured yet.</p>;
  return (
    <>
      <table className="sp-tbl wide">
        <thead>
          <tr>
            <th>Run</th>
            <th>Phase</th>
            <th className="n">Cost</th>
            <th className="n">Tokens</th>
            <th className="n">Turns</th>
            <th className="n">When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="nm">{r.title ?? r.originRef ?? r.id}</span>
                <span className="bl mono">
                  {r.originRef === null ? 'no origin' : <Ref to={r.originRef} label={r.originRef} />}
                </span>
              </td>
              <td>
                <span className="sw" style={{ background: `var(--sp-${r.phase})` }} />
                <span className="ph">{r.phase}</span>
              </td>
              <td className="n b">{fmtUsd(r.costUsd)}</td>
              <td className="n">
                {fmtTokens(r.inputTokens)}→{fmtTokens(r.outputTokens)}
              </td>
              <td className="n">{r.numTurns ?? '—'}</td>
              <td className="n">{relTime(r.endedAt ?? r.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rankedFrom > runs.length && (
        <p className="empty">
          The {runs.length} costliest of {rankedFrom} measured runs. The rest are in the agent drawer.
        </p>
      )}
    </>
  );
}

function Method({ insights }: { insights: SpendInsights }): JSX.Element {
  const { totals } = insights;
  return (
    <MethodNote>
      <p>
        <b>Cost is the provider&apos;s own figure and cache discounts are already in it.</b> Each run&apos;s dollars
        come from Claude Code&apos;s <span className="mono">total_cost_usd</span>, which prices a cache read at a
        fraction of a fresh input token and a cache write at a premium. Nothing here re-derives a price from tokens.
      </p>
      <p>
        <b>Tokens are gross, and cache reads and writes are counted as input.</b> The share beside them is the part of
        that input the provider served from cache — the one figure here a fleet can act on, since cost arrives with the
        discount already applied and can never say whether the discount was earned. A read bills at a fraction of a
        fresh token and a write at a premium, so two fleets with identical token counts and very different bills are
        told apart here and nowhere else.
      </p>
      {totals.cacheMeasuredInputTokens < totals.inputTokens && (
        <p>
          <b>The share is over the runs that reported one</b>
          {totals.cacheMeasuredInputTokens > 0 ? (
            <>
              {' '}
              — {fmtTokens(totals.cacheMeasuredInputTokens)} of the {fmtTokens(totals.inputTokens)} input tokens above.
            </>
          ) : (
            <> — none of the {fmtTokens(totals.inputTokens)} input tokens above.</>
          )}{' '}
          Runs from before the breakdown was recorded measured a gross figure and nothing about its cache share; they
          are left out of the fraction rather than counted as cache misses.
        </p>
      )}
      {totals.unmeasuredRuns > 0 && (
        <p>
          <b>
            {totals.unmeasuredRuns} run{totals.unmeasuredRuns === 1 ? '' : 's'} reported no usage at all
          </b>{' '}
          and appear in no figure on this panel. PTY agents report none, and a run that ended before its first result
          event reports none either. They are unmeasured, not free.
        </p>
      )}
      <p className="dim">
        Everything above is all-time except the two windows and the graph. Read {relTime(insights.generatedAt)}.
      </p>
    </MethodNote>
  );
}
