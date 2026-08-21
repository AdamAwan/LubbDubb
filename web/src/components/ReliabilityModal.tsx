import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  CiHealth,
  CiSubject,
  ReliabilityInsights,
  RemedyCauseTotal,
  RemedyInsights,
  RemedyKindHealth,
  RunOutcomeTotal,
  RunPhaseHealth,
  RunRepeat,
} from '../types.js';
import { api } from '../api.js';
import { Downloads, toCsv } from './Downloads.js';
import { fmtUsd, relTime } from './util.js';
import { Ref } from './refs.js';

/**
 * The reliability breakdown: whether the work finished, and whether it went green.
 *
 * The Yield gauge answers *how much finished* and, like every gauge on the bar,
 * cannot answer why — which is this panel's whole reason, and why it opens from
 * that gauge rather than standing as a way in of its own. It is the Spend panel's
 * twin and is built as one deliberately: the same chrome, the same tables, the
 * same phase vocabulary. Read side by side, one says where the money went and the
 * other says what it bought.
 *
 * **It lives here rather than under `console/` because it fetches** — the console
 * may not reach `api.js`, so the reading is console-side and `openReliability` on
 * the seam is the whole of what passes between them. Exactly the route the spend
 * panel, the retrospective and the notepad take.
 *
 * Four pictures. **Outcomes** first, because a completion rate is the one figure
 * that re-reads every other panel in the cockpit: a fleet losing a third of its
 * runs is not a fleet that is merely slow. Then the **CI trend**, the only dated
 * half. Then **by phase**, which is where a completion rate stops being one
 * number and starts naming a suspect. Then the two rankings — the reddest pull
 * requests, and the origins the harness went round more than once.
 *
 * Fetched on open, three states, and the third is the point: a fetch that failed
 * must not render as a fleet that never fails. 100% is a real answer here.
 */
export function ReliabilityModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [insights, setInsights] = useState<ReliabilityInsights | null>(null);
  const [remedies, setRemedies] = useState<RemedyInsights | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The modal, for the reason the spend panel refs the modal: the body is three
  // different elements across loading, failure and nothing-settled, and a ref
  // that is null on two of them is a button that silently does nothing.
  const modal = useRef<HTMLDivElement>(null);

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
      .getReliability()
      .then((res) => {
        if (!live) return;
        setInsights(res.insights);
        setRemedies(res.remedies);
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
        aria-label="Yield"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pm-head">
          <span className="pm-title">Yield</span>
          <span className="sp-note">did it finish, and did it go green</span>
          {/* Only once there is something to take, as on the spend panel: a fetch
              that failed must not leave with a file saying the fleet never fails. */}
          {insights !== null && (
            <Downloads
              name="lubbdubb-yield"
              files={[
                {
                  format: 'csv',
                  title:
                    'Every table on this panel, in the order it is drawn — tallies, outcomes, CI days, phases, PRs, repeats, causes',
                  build: () => reliabilityCsv(insights, remedies),
                },
                {
                  format: 'json',
                  title: 'The exact payload this panel drew, unrounded',
                  build: () => JSON.stringify({ insights, remedies }, null, 2),
                },
              ]}
              sheet={{
                heading: 'Yield',
                title: 'This panel as it stands, through the browser’s own print — choose “Save as PDF”',
                node: () => modal.current,
              }}
            />
          )}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>
        <Body insights={insights} remedies={remedies} state={state} />
      </div>
    </div>
  );
}

function Body({
  insights,
  remedies,
  state,
}: {
  insights: ReliabilityInsights | null;
  remedies: RemedyInsights | null;
  state: 'loading' | 'ready' | 'failed';
}): JSX.Element {
  if (state === 'loading') return <p className="empty">Reading the log…</p>;
  if (state === 'failed' || !insights) return <p className="empty">Could not read the run log.</p>;

  const { runs, ci } = insights;
  // Nothing settled is a real state and not an empty one: a harness whose first
  // agents are still out has no outcomes yet, and every rate below would be a
  // zero standing in for "not yet". Say which it is.
  if (runs.settled === 0) {
    return (
      <p className="empty">
        {runs.live === 0
          ? 'No agent has run yet, so there is nothing to judge.'
          : `${runs.live} run${runs.live === 1 ? '' : 's'} still out and none finished yet — an outcome is only ` +
            'countable once a run ends.'}
      </p>
    );
  }

  return (
    <div className="rl">
      <Tiles insights={insights} />
      {/* One column per subject: runs on the left, CI on the right. The panel's
          two halves are measured over different windows and answer different
          questions, and interleaving them was how the method note ended up
          qualifying a column it was not about. */}
      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">How runs ended</p>
          <OutcomeBar outcomes={runs.byOutcome} total={runs.settled} />
          <OutcomeKey outcomes={runs.byOutcome} total={runs.settled} />
          {/* The note rides under the outcome table rather than at the foot of
              the panel, level with the figures it qualifies: three of its four
              paragraphs are about *these* rows — what counts as a fault, what an
              unmeasured run does to the dollars beside it. */}
          <Method insights={insights} />
        </section>
        <section className="sp-col">
          <p className="sp-sub">CI verdicts, last {insights.windowDays} days</p>
          <CiTimeline ci={ci} />
          <p className="sp-sub">Reddest pull requests</p>
          <Flakiest ci={ci} />
        </section>
      </div>

      {/* Third, and below the CI column it explains. The two readings above say
          how often the pipeline broke and what it cost; this says what it was, and
          it is drawn after them because a cause table read before the counts has
          no denominator. */}
      {remedies !== null && <Causes remedies={remedies} windowDays={insights.windowDays} />}

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
  const { runs, ci, windowDays } = insights;

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
    // The window split looks like a mistake until it is stated, so it is stated.
    ['Outcomes measured over', 'all time'],
    ['CI measured over (days)', windowDays],
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
 * The Causes half of the file: the caveat first, then the two axes, then the
 * accounts in the agents' own words.
 *
 * The caveat leads for the panel's reason exactly — every share here is a share
 * of what was *reported*, and a spreadsheet strips the sentence on the glass that
 * said so. Empty when nothing has been accounted for: a header with no rows under
 * it reads as a table that failed to load.
 */
function causeRows(remedies: RemedyInsights | null): (string | number | null)[][] {
  if (remedies === null || remedies.accounts === 0) return [];
  return [
    ['Causes'],
    ['Accounts filed', remedies.accounts],
    ['Cost of returning (USD)', remedies.costUsd],
    ['Dispatches that filed nothing', remedies.unaccounted],
    ['An account is', "one agent's reckoning of one return — not one red, and not one run"],
    ['Cost is', "the filing agent's spend in the window, divided evenly across the accounts it filed"],
    [],

    ['What would have caught it'],
    ['Guard', 'Label', 'Definition', 'Accounts', 'Cost (USD)'],
    ...remedies.byGuard.map((g) => [g.guard, g.label, g.blurb, g.accounts, g.costUsd]),
    [],

    ['By cause'],
    ['Kind', 'Cause', 'Label', 'Definition', 'Accounts', 'Cost (USD)', 'Undocumented', 'Top check', 'On accounts'],
    ...remedies.byKind.flatMap((k) =>
      k.byCause.map((c) => [
        k.kind,
        c.cause,
        c.label,
        c.blurb,
        c.accounts,
        c.costUsd,
        c.undocumented,
        c.topCheck?.name ?? null,
        c.topCheck?.accounts ?? null,
      ]),
    ),
    [],

    ['Lately'],
    ['When (ISO)', 'Kind', 'PR', 'Cause', 'Guard', 'Checks', 'Summary'],
    ...remedies.recent.map((r) => [r.at, r.kind, r.prNumber, r.cause, r.guard, r.checks.join(' '), r.summary]),
    [`The ${remedies.recent.length} most recent of ${remedies.accounts} accounts.`],
  ];
}

/** A share of the whole, as a percentage. */
function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** `12%`, and `<1%` rather than `0%` for a slice that is small but not absent. */
function fmtShare(part: number, whole: number): string {
  const pct = share(part, whole);
  if (pct === 0) return '0%';
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** A rate as a percentage, or an em dash where there was no denominator at all. */
function fmtRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * A span in the largest unit that still reads as a measurement.
 *
 * Minutes below an hour and hours below a day, because these are *waits* — how
 * long a pull request sat red, how long a run took — and "218m" is a number a
 * reader has to convert before it means anything.
 */
function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
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
        <span className="lb">Runs finished</span>
        <span className="vl">{fmtRate(runs.completionRate)}</span>
        <span className="sb">
          {runs.completed} of {runs.settled} settled
          {runs.live > 0 && ` · ${runs.live} still out`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Lost to faults</span>
        <span className="vl">{fmtUsd(runs.lostCostUsd)}</span>
        <span className="sb">
          {runs.lost} run{runs.lost === 1 ? '' : 's'} failed or crashed
          {runs.stopped > 0 && ` · ${runs.stopped} stopped`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">CI went red</span>
        <span className="vl">{fmtRate(ci.redRate)}</span>
        <span className="sb">
          {ci.redRate === null
            ? 'no verdict observed yet'
            : `${ci.reds} of ${ci.reds + ci.greens} verdicts · ${ci.prsAffected}/${ci.prsObserved} PRs`}
        </span>
      </div>
      <div className="sp-tile sp-well">
        <span className="lb">Back to green</span>
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
        <span className="lb">Red checks cost</span>
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
 * Causes — why the fleet came back to a pull request, and what would have caught
 * it earlier.
 *
 * The panel's other two readings are folds of things the harness *observed*; this
 * one is a fold of what agents **said**, which is the whole reason it can answer
 * "why" and the whole reason it has to be read differently. Two properties keep
 * that honest, and neither is decoration:
 *
 * - **The unaccounted count is drawn with the total, not in a footnote.** Every
 *   share below it is a share of the accounts that were filed, and with half of
 *   them missing a cause table is a minority report an operator reads as the
 *   whole one.
 * - **The guard split comes before the cause tables.** A cause says what went
 *   wrong; the guard says whether anything could have caught it, and that is the
 *   only axis here an operator can act on. Ordered by what acting costs — run the
 *   gate, hand over what is already written, write down what is not, accept the
 *   rest.
 */
function Causes({ remedies, windowDays }: { remedies: RemedyInsights; windowDays: number }): JSX.Element {
  return (
    <>
      <p className="sp-sub">Causes, last {windowDays} days</p>
      {remedies.accounts === 0 ? (
        // Two different silences, and the difference is the operator's next move:
        // a fleet that has not been back to a pull request has nothing to explain,
        // and a fleet that has been back and said nothing has a tool nobody is
        // calling. Neither of them is "no causes".
        <p className="empty">
          {remedies.unaccounted === 0
            ? 'Nothing has come back to a pull request in this window, so there is nothing to account for.'
            : `${remedies.unaccounted} dispatch${remedies.unaccounted === 1 ? '' : 'es'} answered a red or a review ` +
              'and none filed an account. Nothing here until one does.'}
        </p>
      ) : (
        <>
          <GuardSplit remedies={remedies} />
          <div className="sp-cols">
            {remedies.byKind.map((kind) => (
              <section className="sp-col" key={kind.kind}>
                <p className="sp-sub">{kind.kind === 'ci' ? 'CI, by cause' : 'Review, by cause'}</p>
                <CauseTable kind={kind} />
              </section>
            ))}
          </div>
          <p className="sp-sub">Lately</p>
          <Lately remedies={remedies} />
        </>
      )}
    </>
  );
}

/** The four guards as one bar and its legend — the section's headline reading. */
function GuardSplit({ remedies }: { remedies: RemedyInsights }): JSX.Element {
  const total = remedies.accounts;
  return (
    <>
      <div
        className="sp-bar sp-well"
        role="img"
        aria-label={remedies.byGuard.map((g) => `${g.label} ${g.accounts}`).join(', ')}
      >
        {remedies.byGuard.map((g) => (
          <span
            key={g.guard}
            className="sg"
            style={{ width: `${share(g.accounts, total)}%`, background: `var(--rm-${g.guard})` }}
            title={`${g.label}: ${g.accounts} (${fmtShare(g.accounts, total)})`}
          />
        ))}
      </div>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>What would have caught it</th>
            <th className="n">Accounts</th>
            <th className="n">Share</th>
            <th className="n">Cost</th>
          </tr>
        </thead>
        <tbody>
          {remedies.byGuard.map((g) => (
            <tr key={g.guard}>
              <td>
                <span className="sw" style={{ background: `var(--rm-${g.guard})` }} />
                <span className="nm" title={g.blurb}>
                  {g.label}
                </span>
                <span className="bl">{g.blurb}</span>
              </td>
              <td className="n b">{g.accounts}</td>
              <td className="n">{fmtShare(g.accounts, total)}</td>
              <td className="n">{g.costUsd > 0 ? fmtUsd(g.costUsd) : <span className="dim">&mdash;</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* The denominator, said out loud rather than left to arithmetic. An account
          is not a red — one agent can answer four at once — so the two numbers on
          this panel that look subtractable are not. */}
      <p className="sp-note">
        {remedies.accounts} account{remedies.accounts === 1 ? '' : 's'} of what went wrong, {fmtUsd(remedies.costUsd)}{' '}
        between them.{' '}
        {remedies.unaccounted > 0
          ? `${remedies.unaccounted} further dispatch${remedies.unaccounted === 1 ? '' : 'es'} answered a red or a ` +
            'review and filed nothing, so every share above is a share of what was reported rather than of what ' +
            'happened. '
          : 'Every dispatch that answered a red or a review filed one. '}
        An account is one agent&rsquo;s reckoning of one return, not one red &mdash; a run that settled four reds at
        once files one, so this never sums to the verdict counts above. Money is the filing agent&rsquo;s spend inside
        the window, divided evenly where it filed more than one.
      </p>
    </>
  );
}

/** One kind's causes, most accounts first, with the empty ones kept at the foot. */
function CauseTable({ kind }: { kind: RemedyKindHealth }): JSX.Element {
  if (kind.accounts === 0) {
    return <p className="empty">Nothing has been accounted for here in this window.</p>;
  }
  // Sorted here rather than in the fold, which ships them in taxonomy order: the
  // payload's order is the vocabulary's and stays stable for the file an operator
  // takes away, and the panel wants the ranking. A cause with no accounts still
  // draws, at the foot — "nothing was a flake this fortnight" is a reading, and a
  // table that dropped its own zero rows could not make it.
  const rows = [...kind.byCause].sort((a, b) => b.accounts - a.accounts || b.costUsd - a.costUsd);
  const checks = kind.kind === 'ci';
  return (
    <table className="sp-tbl wide">
      <thead>
        <tr>
          <th>Cause</th>
          <th className="n">Accounts</th>
          <th className="n">Cost</th>
          <th className="n">Undocumented</th>
          {/* Only for CI, and dropped rather than blanked: a review round has no
              check to name, and a column of em dashes under an empty header reads
              as data that failed to arrive. */}
          {checks && <th>Reddest check</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((c: RemedyCauseTotal) => (
          <tr key={c.cause} className={c.accounts === 0 ? 'dim' : undefined}>
            <td>
              <span className="nm" title={c.blurb}>
                {c.label}
              </span>
              <span className="bl">{c.blurb}</span>
            </td>
            <td className="n b">{c.accounts}</td>
            <td className="n">{c.costUsd > 0 ? fmtUsd(c.costUsd) : <span className="dim">&mdash;</span>}</td>
            {/* The actionable cell: how many of this cause were things nobody had
                written down. High here is a cause an operator can retire rather
                than merely watch. */}
            <td className="n">
              {c.undocumented > 0 ? `${c.undocumented} of ${c.accounts}` : <span className="dim">&mdash;</span>}
            </td>
            {checks && (
              <td>
                {c.topCheck === null ? (
                  <span className="dim">&mdash;</span>
                ) : (
                  <span className="mono" title={`named on ${c.topCheck.accounts} of these accounts`}>
                    {c.topCheck.name}
                  </span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The most recent accounts, in the agents' own words.
 *
 * The tables above are what an operator acts on; this is what makes them
 * believable. "Twelve missed gates" is a claim about a taxonomy, and three
 * sentences underneath it saying what those actually were is the only thing on
 * the panel that shows the taxonomy is being used rather than guessed at.
 */
function Lately({ remedies }: { remedies: RemedyInsights }): JSX.Element {
  return (
    <div>
      {remedies.recent.map((r) => (
        <div className="rm-row" key={r.id}>
          <div className="rm-head">
            {/* The pull request as a ref, never as text — a row that names one and
                offers no way there is the cockpit's most repeated dead end. */}
            <Ref to={r.ref} />
            <span className="rm-tag">{r.causeLabel.toLowerCase()}</span>
            <span className="rm-tag guard" style={{ color: `var(--rm-${r.guard})` }}>
              {r.guardLabel.toLowerCase()}
            </span>
            {r.checks.length > 0 && <span className="bl mono">{r.checks.join(', ')}</span>}
            <span className="rm-when">{relTime(r.at)}</span>
          </div>
          <div>{r.summary}</div>
        </div>
      ))}
      <p className="sp-note">
        The {remedies.recent.length} most recent of {remedies.accounts}, newest first. Each is one agent&rsquo;s account
        of its own run &mdash; testimony, not a reading the harness took.
      </p>
    </div>
  );
}

const PLOT = { left: 34, right: 596, top: 10, bottom: 152 };

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
 * Two sentences here have to be: the two halves of this panel are measured over
 * *different windows*, which looks like a mistake until it is explained; and a
 * red rate is a rate over CI *verdicts*, not over pull requests, so a single
 * pull request that failed nine times is nine reds. Both are the kind of thing a
 * reader would otherwise discover by disbelieving the panel.
 */
function Method({ insights }: { insights: ReliabilityInsights }): JSX.Element {
  const { runs, ci, windowDays } = insights;
  return (
    <div className="sp-method sp-well">
      <p className="sp-sub">What these numbers are</p>
      <p>
        <b>Outcomes are all-time; CI is the last {windowDays} days.</b> A completion rate is a property of the harness
        and wants every run behind it. A red rate is a property of the pipeline <i>as it stands</i>, and a suite that
        was fixed a month ago describes a repository that no longer exists.
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
