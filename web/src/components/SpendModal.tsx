import { useEffect, useRef, useState, type JSX } from 'react';
import type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun } from '../types.js';
import { api } from '../api.js';
import { Downloads, toCsv } from './Downloads.js';
import { fmtTokens, fmtUsd, relTime } from './util.js';

/**
 * The spend breakdown: where the money on the cost gauges actually went.
 *
 * The gauges answer *how much* and cannot answer *where* — that is the whole
 * reason this panel exists, and why it opens from the Power gauge rather than
 * standing as a way in of its own. A reading and the reading behind it are one
 * subject, and the bar's rule is that a subject is stated once.
 *
 * **It lives here rather than under `console/` because it fetches.** The console
 * may not reach `api.js` — every capability it has is enumerated on `CockpitActions`,
 * asserted structurally in `test/console.test.ts` — so the sanctioned route is the
 * one the retrospective, the notepad and the settings modal all take: the reading
 * is console-side, the panel hangs off the shell, and `openSpend` on the seam is
 * the whole of what passes between them.
 *
 * Four pictures, in the order the questions arrive. **Phases** first, because it
 * is the one split no other surface in the cockpit can show: a goal's card folds
 * its planner and its parts into a single figure on purpose, so "half the budget
 * went on deciding what to build" is invisible everywhere else. Then the
 * **trend**, which is the only reading here that is dated. Then **goals**, the
 * per-issue totals the cards already carry, ranked and with the phase split
 * inside each row. Then the **costliest runs**, because at some point the answer
 * to "where did it go" is one agent.
 *
 * Fetched on open, three states, and the third is the point — a fetch that failed
 * must not render as a fleet that has spent nothing. `$0.00` is a real answer here
 * (a fresh harness, or one that has only ever run PTY agents), so it cannot also
 * be the failure mode.
 *
 * Phase colour lives in the stylesheet as `--sp-<phase>`, not here: this component
 * names a phase and the sheet decides what that looks like, which is the division
 * the rest of the cockpit keeps.
 */
export function SpendModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [insights, setInsights] = useState<SpendInsights | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The modal, not the breakdown inside it: the body is three different elements
  // across loading, failure and the all-unmeasured case, and a ref that is null
  // on two of them is a button that silently does nothing. The chrome it brings
  // along — the head, the close — is dropped by the print sheet's own rules.
  const modal = useRef<HTMLDivElement>(null);

  // Escape closes, as it does on every other panel that covers the cockpit: a
  // thing this large must not have exactly one exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    api
      .getSpend()
      .then((res) => {
        if (!live) return;
        setInsights(res.insights);
        setState('ready');
      })
      .catch(() => {
        if (live) setState('failed');
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="read-backdrop" onClick={onClose}>
      <div
        ref={modal}
        className="read-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Spend"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pm-head">
          <span className="pm-title">Spend</span>
          <span className="sp-note">the same money, split three ways</span>
          {/* Only once there is something to take. The control is drawn from the
              same `insights` the body is, so a failed fetch cannot offer a file
              of zeroes — which is the panel's own rule about `$0.00` applied to
              the one artefact that leaves the browser and outlives the tab. */}
          {insights !== null && (
            <Downloads
              name="lubbdubb-spend"
              files={[
                {
                  format: 'csv',
                  title: 'Every table on this panel, in the order it is drawn — totals, phases, days, goals, runs',
                  build: () => spendCsv(insights),
                },
                {
                  format: 'json',
                  title: 'The exact payload this panel drew, unrounded',
                  build: () => JSON.stringify(insights, null, 2),
                },
              ]}
              sheet={{
                heading: 'Spend',
                title: 'This panel as it stands, through the browser’s own print — choose “Save as PDF”',
                node: () => modal.current,
              }}
            />
          )}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>
        <Body insights={insights} state={state} />
      </div>
    </div>
  );
}

/** Everything below the head, so the three states are one readable switch. */
function Body({ insights, state }: { insights: SpendInsights | null; state: 'loading' | 'ready' | 'failed' }) {
  if (state === 'loading') return <p className="empty">Reading the meter…</p>;
  if (state === 'failed' || !insights) return <p className="empty">Could not read the spend log.</p>;

  const { totals } = insights;
  // Nothing measured is a real state and not an empty one: a fleet run entirely
  // in PTY mode reports no usage at all, and every figure below would be a zero
  // standing in for "unknown". Say which it is.
  if (totals.measuredRuns === 0) {
    return (
      <p className="empty">
        {totals.unmeasuredRuns === 0
          ? 'No agent has run yet, so there is nothing to break down.'
          : `${totals.unmeasuredRuns} run${totals.unmeasuredRuns === 1 ? '' : 's'}, none of which reported any usage — ` +
            'PTY agents report none. Nothing here is zero; it is unmeasured.'}
      </p>
    );
  }

  return (
    <div className="sp">
      <Tiles insights={insights} />
      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">Where it went</p>
          <PhaseBar phases={insights.phases} total={totals.costUsd} />
          <PhaseKey phases={insights.phases} total={totals.costUsd} />
        </section>
        <section className="sp-col">
          <p className="sp-sub">Last {insights.timeline.buckets.length} days</p>
          <Timeline insights={insights} />
          {/* The method note rides under the graph rather than at the foot of the
              panel. The phase table beside it is the tallest thing here, so this
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

/**
 * The panel as a file: five sections in the order the panel draws them, parted by
 * blank lines and each headed by its own name.
 *
 * Five tables rather than one grid, because that is what the panel is — a total,
 * a split, a trend, a ranking by goal and a ranking by run — and folding them
 * into a single sheet would lose which figure was a whole and which was a part.
 *
 * **Figures go out raw.** `fmtUsd` rounds to the cent and `fmtTokens` to three
 * significant figures, which is right for a glance and wrong for a sum: a
 * hundred rows of `$0.00` add up to real money. The formatting is presentation
 * and stops at the screen.
 *
 * The two truncations the panel states in prose are stated here as rows. A file
 * read six months from now has no panel beside it, so a cap it does not carry is
 * a cap nobody will know about.
 */
export function spendCsv(insights: SpendInsights): string {
  const { totals, windows, phases, goals, runs, timeline } = insights;
  const order = phases.map((p) => p.phase);

  return toCsv([
    ['Totals'],
    ['Measure', 'Value'],
    ['All-time cost (USD)', totals.costUsd],
    ['Last 5h cost (USD)', windows.fiveHourCostUsd],
    ['Last 7d cost (USD)', windows.sevenDayCostUsd],
    ['Input tokens', totals.inputTokens],
    ['Output tokens', totals.outputTokens],
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

    // Rolling 24h buckets, so the label is the instant each one opens and never a
    // calendar date — the panel's `now` axis, written out.
    ['Daily'],
    ['Bucket start (ISO)', 'Cost (USD)'],
    ...timeline.buckets.map((b) => [b.startsAt, b.costUsd]),
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
    // The remainder is a row here for the reason it is a row on the panel: these
    // figures are a partition, and one that does not carry its own remainder
    // reads as complete.
    ['', 'Reached no goal', insights.unattributedCostUsd],
    [],

    ['Runs'],
    [
      'Agent',
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
      r.agentId,
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
  ]);
}

/** A share of the whole, as a percentage — the reading every bar here is drawn from. */
function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** `12%`, and `<1%` rather than `0%` for a slice that is small but not absent. */
function fmtShare(part: number, whole: number): string {
  const pct = share(part, whole);
  if (pct === 0) return '0%';
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/**
 * The four headline figures.
 *
 * The two windows restate exactly what the gauge an operator just clicked says,
 * and they are here for that reason rather than for their own: a panel opened
 * from a chip must begin by agreeing with it, or the first thing it does is raise
 * a question about itself.
 */
function Tiles({ insights }: { insights: SpendInsights }): JSX.Element {
  const { totals, windows } = insights;
  const perRun = totals.costUsd / totals.measuredRuns;
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well">
        <span className="lb">All time</span>
        <span className="vl">{fmtUsd(totals.costUsd)}</span>
        <span className="sb">
          {totals.measuredRuns} run{totals.measuredRuns === 1 ? '' : 's'} · {fmtUsd(perRun)} each
        </span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Last 5h</span>
        <span className="vl">{fmtUsd(windows.fiveHourCostUsd)}</span>
        <span className="sb">{fmtUsd(windows.fiveHourCostUsd / 5)} an hour</span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Last 7d</span>
        <span className="vl">{fmtUsd(windows.sevenDayCostUsd)}</span>
        <span className="sb">{fmtUsd(windows.sevenDayCostUsd / 7)} a day</span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Tokens</span>
        <span className="vl">
          {fmtTokens(totals.inputTokens)}
          <small>→</small>
          {fmtTokens(totals.outputTokens)}
        </span>
        {/* Per *million* input tokens, and input rather than the pair, because
            input is what the cache acts on — this is the one number on the panel
            that moves when caching does. See the note at the foot. */}
        <span className="sb">
          {totals.inputTokens > 0
            ? `${fmtUsd(totals.costUsd / (totals.inputTokens / 1e6))}/Mtok in`
            : 'no input measured'}
        </span>
      </div>
    </div>
  );
}

/** The whole fleet's spend as one bar, in funnel order. */
function PhaseBar({ phases, total }: { phases: readonly SpendPhaseTotal[]; total: number }): JSX.Element {
  // A phase that cost nothing still has runs behind it (an agent that reported
  // tokens but no cost), and a zero-width segment is invisible rather than wrong.
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

/** The legend, which is also the table: what each phase is, and what it came to. */
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

const PLOT = { left: 34, right: 596, top: 10, bottom: 152 };

/**
 * Daily spend, as bars rather than the production graph's lines.
 *
 * Bars because these are *totals over a period* and not samples of a rate: a line
 * between two days implies the money moved smoothly between them, which is
 * exactly what a fleet that ran for one afternoon did not do.
 *
 * The buckets roll — the last one is the last 24 hours, not "today" — because a
 * calendar day needs a timezone the harness has no opinion about. The axis says
 * `now` for that reason rather than a date.
 */
function Timeline({ insights }: { insights: SpendInsights }): JSX.Element {
  const { buckets } = insights.timeline;
  const days = buckets.length;
  const peak = Math.max(...buckets.map((b) => b.costUsd), 0);
  // A flat zero window would divide by nothing and draw full-height bars; the
  // floor of one cent keeps an empty fortnight empty.
  const top = Math.max(peak, 0.01);
  const width = (PLOT.right - PLOT.left) / days;
  const height = PLOT.bottom - PLOT.top;
  const total = buckets.reduce((a, b) => a + b.costUsd, 0);

  return (
    <div className="sp-graph sp-well">
      <svg viewBox="0 0 620 176" role="img" aria-label={`Daily spend over ${days} days, ${fmtUsd(total)} in total`}>
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
              opacity={i === days - 1 ? 1 : 0.72}
            >
              <title>{`${fmtUsd(b.costUsd)} — the 24h from ${new Date(b.startsAt).toLocaleString()}`}</title>
            </rect>
          );
        })}
        <g className="sp-axis" textAnchor="middle">
          <text x={PLOT.left + width / 2} y="170">
            {days}d ago
          </text>
          <text x={PLOT.right - width / 2} y="170">
            now
          </text>
        </g>
      </svg>
    </div>
  );
}

/** The phase split inside one goal, as a bar the width of its share of the fleet. */
function GoalBar({ goal, total }: { goal: SpendGoal; total: number }): JSX.Element {
  const order: SpendPhase[] = ['deliberation', 'build', 'landing', 'evidence', 'job', 'other'];
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

/**
 * The goals, costliest first.
 *
 * The unattributed remainder is a row rather than a footnote, and it is the row
 * that keeps the rest honest: these figures are a *partition* of the fleet's
 * spend, and a remainder nothing draws would let them read as complete while it
 * grew behind them.
 */
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
                <b>#{g.issueNumber}</b> {g.title ?? <i className="sp-gone">no longer in the world</i>}
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

/** The individual runs behind the totals — a ranking, and it says so. */
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
            <tr key={r.agentId}>
              <td>
                <span className="nm">{r.title ?? r.originRef ?? r.agentId}</span>
                <span className="bl mono">{r.originRef ?? 'no origin'}</span>
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

/**
 * What the numbers are, stated where they are read.
 *
 * The cache sentence is the one that has to be here. Dollars come from the
 * provider's own `total_cost_usd`, which is already net of cache pricing; the
 * token count folds cache reads and writes into input, so it is gross. Both are
 * right and they are right about different things — and an operator dividing one
 * by the other, as the tile above deliberately does, will get a rate that looks
 * far too cheap unless something says why.
 */
function Method({ insights }: { insights: SpendInsights }): JSX.Element {
  const { totals } = insights;
  return (
    <div className="sp-method sp-well">
      <p className="sp-sub">What these numbers are</p>
      <p>
        <b>Cost is the provider&apos;s own figure and cache discounts are already in it.</b> Each run&apos;s dollars
        come from Claude Code&apos;s <span className="mono">total_cost_usd</span>, which prices a cache read at a
        fraction of a fresh input token and a cache write at a premium. Nothing here re-derives a price from tokens.
      </p>
      <p>
        <b>Tokens are gross, and cache reads and writes are counted as input.</b> That is why the rate per million input
        tokens above reads low on a fleet with warm caches: the discount lands in the numerator and never in the
        denominator. It is a measure of how much cache the fleet is getting, not a price list.
      </p>
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
    </div>
  );
}
