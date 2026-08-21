import type { JSX } from 'react';
import type { RemedyCauseTotal, RemedyInsights, RemedyKindHealth } from '../types.js';
import { fmtUsd, relTime } from './util.js';
import { fmtShare, share } from './insightsFormat.js';
import { Ref } from './refs.js';

/**
 * Causes: what keeps sending the fleet back.
 *
 * A tab of its own rather than the third block of the reliability panel, and it
 * is the section that gained most from the move — three tables and a quotation
 * list read below two other readings is where an operator stops scrolling, and
 * this is the one surface on the page that shows the taxonomy is being *used*
 * rather than guessed at.
 *
 * It still reads **below** the counts it explains in the sense that matters: the
 * Reliability tab holds how often the pipeline broke and what it cost, and this
 * holds what it was. A cause table read with no denominator anywhere is a list
 * of anecdotes, so the section states its own total and its own shortfall.
 */
export function CausesTab({ remedies, windowLabel }: { remedies: RemedyInsights; windowLabel: string }): JSX.Element {
  return (
    <div className="rl">
      <Causes remedies={remedies} windowLabel={windowLabel} />
    </div>
  );
}

export function causeRows(remedies: RemedyInsights | null): (string | number | null)[][] {
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
function Causes({ remedies, windowLabel }: { remedies: RemedyInsights; windowLabel: string }): JSX.Element {
  return (
    <>
      <p className="sp-sub">Causes, {windowLabel}</p>
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
