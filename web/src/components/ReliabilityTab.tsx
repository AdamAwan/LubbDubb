import type { JSX } from 'react';
import type {
  CiHealth,
  CiSubject,
  ReliabilityInsights,
  RemedyInsights,
  RunOutcomeTotal,
  RunPhaseHealth,
  RunRepeat,
} from '../types.js';
import { fmtUsd, relTime } from './util.js';
import { fmtDuration, fmtRate, fmtShare, share, PLOT } from './insightsFormat.js';
import { causeRows } from './CausesTab.js';
import { toCsv } from './Downloads.js';
import { Ref } from './refs.js';
import { Label } from './label.js';

/**
 * Reliability: did the work finish, and did it go green?
 *
 * The Economics tab says what the window cost and what landed; this says what
 * happened to the runs in between. It was the Yield panel, and the two changes
 * that came with the move are both about honesty rather than layout.
 *
 * **It is measured over the page's window, both halves.** The run half used to
 * be all-time and the CI half a rolling fortnight, so a completion rate and a
 * red rate sat side by side describing two different stretches of the fleet's
 * life with nothing on the glass saying so.
 *
 * **The causes moved to a tab of their own.** They were the third block here,
 * read below two other readings, which is where an operator stops scrolling —
 * and they are the one surface that shows the taxonomy is being used rather than
 * guessed at.
 *
 * What the cockpit owns is presentation: the outcome colours, in the stylesheet
 * as `--rl-<outcome>`. Grey is doing real work in that palette — a killed run is
 * not a fault, and colouring it like one makes every steered fleet look broken.
 *
 * → docs/spec/17-cockpit.md#reliability
 */
export function ReliabilityTab({ insights }: { insights: ReliabilityInsights }): JSX.Element {
  const { runs, ci } = insights;
  // Nothing settled is a real state and not an empty one: a harness whose first
  // agents are still out has no outcomes yet, and every rate below would be a
  // zero standing in for "not yet". Say which it is.
  if (runs.settled === 0) {
    return (
      <p className="empty">
        {runs.live === 0
          ? 'No agent settled in this window, so there is nothing to judge.'
          : `${runs.live} run${runs.live === 1 ? '' : 's'} still out and none settled in this window — an outcome ` +
            'is only countable once a run ends.'}
      </p>
    );
  }

  return (
    <div className="rl">
      <Tiles insights={insights} />
      {/* One column per subject: runs on the left, CI on the right. They answer
          different questions, and interleaving them was how the method note
          ended up qualifying a column it was not about. */}
      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">How runs ended</p>
          <OutcomeBar outcomes={runs.byOutcome} total={runs.settled} />
          <OutcomeKey outcomes={runs.byOutcome} total={runs.settled} />
          {/* The note rides under the outcome table rather than at the foot of
              the tab, level with the figures it qualifies. */}
          <Method insights={insights} />
        </section>
        <section className="sp-col">
          <p className="sp-sub">CI verdicts</p>
          <CiTimeline ci={ci} />
          <p className="sp-sub">Reddest pull requests</p>
          <Flakiest ci={ci} />
        </section>
      </div>

      <p className="sp-sub">By phase</p>
      <Phases phases={runs.byPhase} />

      <p className="sp-sub">Ran more than once</p>
      <Repeats repeats={runs.repeats} repeatedOrigins={runs.repeatedOrigins} />
    </div>
  );
}

/**
 * The panel as a file: six sections in the order the panel draws them, parted by
 * blank lines and each headed by its own name. Spend's export read across, so
 * these two can be opened side by side — which is what the panels are for.
 *
 * **Figures go out raw**, and here that matters more than on the spend panel: a
 * rate is shipped as a fraction rather than the rounded percent on screen, and a
 * duration in milliseconds rather than `3.4h`. `fmtDuration` is the reading a
 * person wants and the one nothing can be recomputed from.
 *
 * The three caveats the panel argues in prose are rows here — the two halves
 * measured over different windows, a red being a verdict rather than a pull
 * request, and stopped not being failed. On paper there is no method note to read
 * them off.
 */
export function reliabilityCsv(insights: ReliabilityInsights, remedies: RemedyInsights | null): string {
  const { runs, ci } = insights;

  return toCsv([
    ['Tallies'],
    ['Measure', 'Value'],
    ['Runs settled', runs.settled],
    ['Runs still out', runs.live],
    ['Runs finished', runs.completed],
    ['Completion rate', runs.completionRate],
    ['Runs lost to faults', runs.lost],
    ['Runs stopped', runs.stopped],
    ['Total cost (USD)', runs.costUsd],
    ['Lost to faults (USD)', runs.lostCostUsd],
    ['Unmeasured settled runs', runs.unmeasuredRuns],
    ['CI verdicts red', ci.reds],
    ['CI verdicts green', ci.greens],
    ['CI red rate', ci.redRate],
    ['PRs that went red', ci.prsAffected],
    ['PRs observed', ci.prsObserved],
    ['Recoveries', ci.recoveries],
    ['Median back to green (ms)', ci.medianToGreenMs],
    ['Slowest back to green (ms)', ci.slowestToGreenMs],
    ['Still red', ci.unrecovered],
    ['Red checks cost (USD)', ci.ciCostUsd],
    ['Landing cost over the window (USD)', ci.landingCostUsd],
    // One window for both halves now, and the file says which — a reader six
    // months from now has no time bar beside it to work it out from.
    ['Window', insights.window.label],
    ['Window opened (ISO)', insights.window.since ?? 'no lower bound — all time'],
    // A red is a verdict, not a pull request: one PR that failed nine times is
    // nine reds, and a reader summing the red column needs to know which.
    ['A red is', 'one CI verdict, not one pull request'],
    // One CI agent often answers several reds at once, so a PR that went red four
    // times and was fixed once divides the same money four ways.
    ['Cost per red is', 'per verdict, not per fix — the price of breaking, not of repairing'],
    // Stopped is somebody's decision, and a fleet an operator steers is not an
    // unreliable one — only faults count against the rate.
    ['Counts against the completion rate', 'failed and crashed only — stopped runs do not'],
    ['Generated (ISO)', insights.generatedAt],
    [],

    ['Outcomes'],
    ['Outcome', 'Label', 'Definition', 'Runs', 'Cost (USD)'],
    ...runs.byOutcome.map((o) => [o.outcome, o.label, o.blurb, o.runs, o.costUsd]),
    [],

    // Rolling 24h buckets, so the label is the instant each one opens and never a
    // calendar date — the panel's `now` axis, written out.
    ['CI verdicts by day'],
    ['Bucket start (ISO)', 'Red', 'Green'],
    ...ci.timeline.buckets.map((b) => [b.startsAt, b.red, b.green]),
    [],

    ['Phases'],
    ['Phase', 'Label', 'Settled', 'Finished', 'Completion rate', 'Lost', 'Stopped', 'Lost (USD)', 'Median run (ms)'],
    ...runs.byPhase.map((p) => [
      p.phase,
      p.label,
      p.settled,
      p.completed,
      p.completionRate,
      p.lost,
      p.stopped,
      p.lostCostUsd,
      p.medianMs,
    ]),
    [],

    ['Reddest pull requests'],
    ['Ref', 'PR', 'Went red', 'Went green', 'Red for (ms)', 'Cost (USD)', 'Still red'],
    ...ci.flakiest.map((s) => [s.ref, s.prNumber, s.reds, s.greens, s.redMs, s.costUsd, s.stillRed ? 'yes' : 'no']),
    [`The ${ci.flakiest.length} reddest of ${ci.prsAffected} pull requests that went red.`],
    [],

    ['Ran more than once'],
    ['Origin', 'Title', 'Runs', 'Faults', 'Cost (USD)', 'Last (ISO)'],
    ...runs.repeats.map((r) => [r.originRef, r.title, r.runs, r.lost, r.costUsd, r.lastAt]),
    [`The ${runs.repeats.length} most-repeated of ${runs.repeatedOrigins} origins that ran more than once.`],
    [],

    // The Causes half, on the same file rather than one of its own: it is a
    // section of this panel and shares its window, and an operator taking two
    // files away would have two fortnights to reconcile.
    ...causeRows(remedies),
  ]);
}

/**
 * The four headline figures.
 *
 * Completion and red rate are the two the panel exists for. The other two are
 * their prices — money on runs that failed, and the time a pull request spends
 * unlandable — because a rate with no cost beside it is a statistic, and the
 * question an operator opened this on was whether to do something about it.
 */
function Tiles({ insights }: { insights: ReliabilityInsights }): JSX.Element {
  const { runs, ci } = insights;
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-well">
        <Label dense>Runs finished</Label>
        <span className="vl">{fmtRate(runs.completionRate)}</span>
        <span className="sb">
          {runs.completed} of {runs.settled} settled
          {runs.live > 0 && ` · ${runs.live} still out`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Lost to faults</Label>
        <span className="vl">{fmtUsd(runs.lostCostUsd)}</span>
        <span className="sb">
          {runs.lost} run{runs.lost === 1 ? '' : 's'} failed or crashed
          {runs.stopped > 0 && ` · ${runs.stopped} stopped`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>CI went red</Label>
        <span className="vl">{fmtRate(ci.redRate)}</span>
        <span className="sb">
          {ci.redRate === null
            ? 'no verdict observed yet'
            : `${ci.reds} of ${ci.reds + ci.greens} verdicts · ${ci.prsAffected}/${ci.prsObserved} PRs`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <Label dense>Back to green</Label>
        <span className="vl">{fmtDuration(ci.medianToGreenMs)}</span>
        <span className="sb">
          {ci.recoveries === 0
            ? ci.unrecovered > 0
              ? `${ci.unrecovered} still red`
              : 'nothing has had to recover'
            : `median of ${ci.recoveries} · slowest ${fmtDuration(ci.slowestToGreenMs)}`}
        </span>
      </div>
      {/* The tile the CI split exists for. A red rate says how often the pipeline
          breaks; this says what breaking costs, which is the form the question
          arrives in — and the per-red figure beside it is the one an operator can
          multiply by the reds they expect next week. */}
      <div className="sp-tile sp-well">
        <Label dense>Red checks cost</Label>
        <span className="vl">{fmtUsd(ci.ciCostUsd)}</span>
        <span className="sb">
          {ci.reds === 0
            ? 'nothing went red in this window'
            : `${fmtUsd(ci.ciCostUsd / ci.reds)} a red · ${fmtUsd(ci.landingCostUsd)} on the rest of landing`}
        </span>
      </div>
    </div>
  );
}

/** Every settled run as one bar, in the order the outcomes are worth reading. */
function OutcomeBar({ outcomes, total }: { outcomes: readonly RunOutcomeTotal[]; total: number }): JSX.Element {
  return (
    <div className="sp-bar sp-well" role="img" aria-label={outcomes.map((o) => `${o.label} ${o.runs}`).join(', ')}>
      {outcomes.map((o) => (
        <span
          key={o.outcome}
          className="sg"
          style={{ width: `${share(o.runs, total)}%`, background: `var(--rl-${o.outcome})` }}
          title={`${o.label}: ${o.runs} (${fmtShare(o.runs, total)})`}
        />
      ))}
    </div>
  );
}

/** The legend, which is also the table: what each ending is, and what it came to. */
function OutcomeKey({ outcomes, total }: { outcomes: readonly RunOutcomeTotal[]; total: number }): JSX.Element {
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          <th>Ending</th>
          <th className="n">Runs</th>
          <th className="n">Share</th>
          <th className="n">Cost</th>
        </tr>
      </thead>
      <tbody>
        {outcomes.map((o) => (
          <tr key={o.outcome}>
            <td>
              <span className="sw" style={{ background: `var(--rl-${o.outcome})` }} />
              <span className="nm" title={o.blurb}>
                {o.label}
              </span>
              <span className="bl">{o.blurb}</span>
            </td>
            <td className="n b">{o.runs}</td>
            <td className="n">{fmtShare(o.runs, total)}</td>
            <td className="n">{fmtUsd(o.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * CI verdicts a day at a time, red stacked on green.
 *
 * Stacked rather than two series, because the reading is a *ratio*: what matters
 * is how much of each day's bar is red, and two lines make that a comparison
 * instead of a glance. Bars for the spend graph's reason — these are counts over
 * a period, not samples of a rate, and a line between two days would imply the
 * pipeline ran smoothly between them.
 *
 * The buckets roll: the last one is the last 24 hours, not today, because a
 * calendar day needs a timezone the harness has no opinion about.
 */
function CiTimeline({ ci }: { ci: CiHealth }): JSX.Element {
  const { buckets } = ci.timeline;
  const days = buckets.length;
  const peak = Math.max(...buckets.map((b) => b.red + b.green), 0);
  // Counts, so the axis is whole verdicts — a gridline at 2.5 CI runs is a lie
  // about what is being measured.
  const top = Math.max(1, peak);
  const width = (PLOT.right - PLOT.left) / days;
  const height = PLOT.bottom - PLOT.top;

  return (
    <div className="sp-graph sp-well">
      <svg
        viewBox="0 0 620 176"
        role="img"
        aria-label={`CI verdicts over ${days} days: ${ci.reds} red, ${ci.greens} green`}
      >
        <g stroke="var(--border-lo)" strokeWidth="1">
          {[0, 0.5, 1].map((f) => (
            <path key={f} d={`M${PLOT.left} ${PLOT.top + f * height}H${PLOT.right}`} />
          ))}
        </g>
        <g className="sp-axis" textAnchor="end">
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PLOT.left - 7} y={PLOT.top + f * height + 3}>
              {Math.round(top * (1 - f))}
            </text>
          ))}
        </g>
        {buckets.map((b, i) => {
          const greenH = (b.green / top) * height;
          const redH = (b.red / top) * height;
          const x = PLOT.left + i * width + 1.5;
          const w = Math.max(1, width - 3);
          return (
            <g key={b.startsAt} opacity={i === days - 1 ? 1 : 0.78}>
              <rect x={x} y={PLOT.bottom - greenH} width={w} height={greenH} fill="var(--rl-green)">
                <title>{`${b.green} passed — the 24h from ${new Date(b.startsAt).toLocaleString()}`}</title>
              </rect>
              <rect x={x} y={PLOT.bottom - greenH - redH} width={w} height={redH} fill="var(--rl-red)">
                <title>{`${b.red} went red — the 24h from ${new Date(b.startsAt).toLocaleString()}`}</title>
              </rect>
            </g>
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

/**
 * Completion by phase — where a fleet-wide rate stops being one number.
 *
 * The phases are the spend panel's own, named by the server from the same
 * classifier, so a row here and a row there are about the same set of runs. That
 * is the join the two panels are built for: `landing` costing a fortune is a
 * question, and `landing` costing a fortune *while finishing 60% of the time* is
 * an answer.
 */
function Phases({ phases }: { phases: readonly RunPhaseHealth[] }): JSX.Element {
  if (phases.length === 0) return <p className="empty">Nothing has settled yet.</p>;
  return (
    <table className="sp-tbl wide">
      <thead>
        <tr>
          <th>Phase</th>
          <th className="n">Settled</th>
          <th className="n">Finished</th>
          <th className="bar">Rate</th>
          <th className="n">Faults</th>
          <th className="n">Stopped</th>
          <th className="n">Lost</th>
          <th className="n">Median run</th>
        </tr>
      </thead>
      <tbody>
        {phases.map((p) => (
          <tr key={p.phase}>
            <td>
              <span className="sw" style={{ background: `var(--sp-${p.phase})` }} />
              <span className="nm">{p.label}</span>
            </td>
            <td className="n">{p.settled}</td>
            <td className="n b">{fmtRate(p.completionRate)}</td>
            <td className="bar">
              <span className="rl-rate">
                <span
                  className="sg"
                  style={{ width: `${share(p.completed, p.settled)}%`, background: 'var(--rl-done)' }}
                />
                <span
                  className="sg"
                  style={{ width: `${share(p.lost, p.settled)}%`, background: 'var(--rl-failed)' }}
                />
                <span
                  className="sg"
                  style={{ width: `${share(p.stopped, p.settled)}%`, background: 'var(--rl-killed)' }}
                />
              </span>
            </td>
            <td className="n">{p.lost || '—'}</td>
            <td className="n">{p.stopped || '—'}</td>
            <td className="n">{p.lostCostUsd > 0 ? fmtUsd(p.lostCostUsd) : '—'}</td>
            <td className="n">{fmtDuration(p.medianMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The pull requests CI kept sending back, reddest first. */
function Flakiest({ ci }: { ci: CiHealth }): JSX.Element {
  if (ci.flakiest.length === 0) {
    return (
      <p className="empty">
        {ci.prsObserved === 0
          ? 'No pull request has reported a CI verdict in this window.'
          : `${ci.prsObserved} pull request${ci.prsObserved === 1 ? '' : 's'} reported a verdict and none went red.`}
      </p>
    );
  }
  return (
    <>
      <table className="sp-tbl wide">
        <thead>
          <tr>
            <th>Pull request</th>
            <th className="n">Went red</th>
            <th className="n">Went green</th>
            <th className="n">Red for</th>
            <th className="n">Cost</th>
            <th className="n">A red</th>
            <th className="n">Now</th>
          </tr>
        </thead>
        <tbody>
          {ci.flakiest.map((s: CiSubject) => (
            <tr key={s.ref}>
              <td>
                <span className="nm">{s.prNumber === null ? <Ref to={s.ref} /> : <Ref to={`pr:${s.prNumber}`} />}</span>
                <span className="bl mono">{s.ref}</span>
              </td>
              <td className="n b">{s.reds}</td>
              <td className="n">{s.greens}</td>
              <td className="n">{fmtDuration(s.redMs)}</td>
              {/* Zero is a real answer and an em dash is a different one: a pull
                  request can go red and be fixed by a human, or by an agent whose
                  spend fell outside this window, and neither is "cost nothing". */}
              <td className="n b">{s.costUsd > 0 ? fmtUsd(s.costUsd) : <span className="dim">—</span>}</td>
              <td className="n">{s.costUsd > 0 ? fmtUsd(s.costUsd / s.reds) : <span className="dim">—</span>}</td>
              <td className="n">
                {s.stillRed ? <span className="rl-still">still red</span> : <span className="dim">green</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ci.prsAffected > ci.flakiest.length && (
        <p className="empty">
          The {ci.flakiest.length} reddest of {ci.prsAffected} pull requests that went red.
        </p>
      )}
    </>
  );
}

/**
 * Origins the harness ran more than once.
 *
 * A ranking, never a count of mistakes — a part agent that lands and then answers
 * review comments legitimately runs twice. It earns a table because the expensive
 * kind of repetition is invisible everywhere else: a goal whose card shows one
 * number quietly went round four times.
 */
function Repeats({
  repeats,
  repeatedOrigins,
}: {
  repeats: readonly RunRepeat[];
  repeatedOrigins: number;
}): JSX.Element {
  if (repeats.length === 0) return <p className="empty">Every origin the harness dispatched ran exactly once.</p>;
  return (
    <>
      <table className="sp-tbl wide">
        <thead>
          <tr>
            <th>Origin</th>
            <th className="n">Runs</th>
            <th className="n">Faults</th>
            <th className="n">Cost</th>
            <th className="n">Last</th>
          </tr>
        </thead>
        <tbody>
          {repeats.map((r) => (
            <tr key={r.originRef}>
              <td>
                <span className="nm">{r.title ?? r.originRef}</span>
                <span className="bl mono">
                  <Ref to={r.originRef} label={r.originRef} />
                </span>
              </td>
              <td className="n b">{r.runs}</td>
              <td className="n">{r.lost || '—'}</td>
              <td className="n">{fmtUsd(r.costUsd)}</td>
              <td className="n">{r.lastAt ? relTime(r.lastAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {repeatedOrigins > repeats.length && (
        <p className="empty">
          The {repeats.length} most-repeated of {repeatedOrigins} origins that ran more than once.
        </p>
      )}
    </>
  );
}

/**
 * What the numbers are, stated where they are read.
 *
 * The sentence about the two halves being measured over different windows is
 * gone, because they no longer are — which was the point of the time bar. What
 * replaces it is the one thing a single window makes newly worth saying: a rate
 * over a short window is a rate over few runs, and the reader deciding whether
 * to act on 60% wants to know it is 60% of five.
 *
 * The rest stands: a red is a rate over CI *verdicts*, not over pull requests,
 * so a single pull request that failed nine times is nine reds; and stopped is
 * not failed. Both are the kind of thing a reader would otherwise discover by
 * disbelieving the tab.
 */
function Method({ insights }: { insights: ReliabilityInsights }): JSX.Element {
  const { runs, ci } = insights;
  return (
    <div className="sp-method sp-well">
      <p className="sp-sub">What these numbers are</p>
      <p>
        <b>
          Every figure here is {insights.window.label === 'All time' ? 'all-time' : `the last ${insights.window.label}`}
          , runs and CI alike.
        </b>{' '}
        A short window is a small denominator: {runs.settled} run{runs.settled === 1 ? '' : 's'} settled in it, so a
        rate here moves a long way on one more failure. Widen the window above to see whether it holds.
      </p>
      <p>
        <b>A red is a CI verdict, not a pull request.</b> One pull request that failed nine times is nine reds, which is
        the point — the table below names it. Runs still pending are not verdicts and are counted as neither.
      </p>
      <p>
        <b>Cost per red is per verdict, not per fix.</b> The money is what agents on{' '}
        <span className="mono">pr:&lt;n&gt;:ci</span> spent in this window, and one of them often answers several reds
        at once — so a pull request that went red four times and was fixed once divides the same money four ways. It is
        the price of the pipeline breaking, not the price of a repair.
        {ci.ciCostUsd > 0 && (
          <>
            {' '}
            Answering checks cost <b>{fmtUsd(ci.ciCostUsd)}</b> over this window; the rest of landing — review comments,
            retargets, the merge — cost <b>{fmtUsd(ci.landingCostUsd)}</b>.
          </>
        )}
      </p>
      <p>
        <b>Stopped is not failed.</b> A killed or interrupted run is someone&apos;s decision, and a fleet an operator
        steers is not an unreliable one. Only failures and crashes count against the rate — but stopped runs still cost
        what they cost.
      </p>
      {runs.unmeasuredRuns > 0 && (
        <p>
          <b>
            {runs.unmeasuredRuns} settled run{runs.unmeasuredRuns === 1 ? '' : 's'} reported no usage
          </b>{' '}
          — PTY agents report none. They count in every rate here and in no dollar.
        </p>
      )}
      <p className="dim">Read {relTime(insights.generatedAt)}.</p>
    </div>
  );
}
