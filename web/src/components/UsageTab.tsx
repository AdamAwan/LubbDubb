import type { JSX } from 'react';
import type { OperatorRow, SurfaceRow, UsagePayload } from '../types.js';
import { fmtDuration } from './insightsFormat.js';

/**
 * Usage — what the harness asked of a person, what they did about it, and what
 * the waiting cost. Beside Economics, Reliability and MCP, on the same window.
 *
 * Every other tab on this page is a reading about work the **fleet** did. This is
 * the one about the person beside it, and it is here rather than anywhere else
 * because the question it answers — *which parts of this are people actually
 * using, and which are ceremony nobody completes* — is decided against the same
 * window as the spend it competes with for the next month of work.
 *
 * ## Three things it does not do
 *
 * **It draws no reference.** There is nothing on this payload to link to: the
 * rows are counts over a vocabulary, and the store behind the reach half has no
 * ref, no title and no id in it by construction. A cockpit that could draw a
 * `<Ref/>` here would be drawing one from a table that must never hold one.
 *
 * **It never restates a verdict.** `never-linked` and `visited-never-operated`
 * are the server's words, shipped with the evidence behind them
 * (`src/surfaceReachInsights.ts`), for `McpUsageTab`'s reason exactly: a count of
 * zero is four different facts, and a cockpit re-deriving which one would be a
 * second opinion drawn inches from the first.
 *
 * **It never draws a zero where the server sent `null`.** A null is the record
 * behind that row being unable to answer the column — an obstacle carries no
 * stamp for the moment it started asking, a landing records the click and never
 * the offer — and a dash is the only honest mark for it.
 *
 * → docs/spec/17-cockpit.md#insights, docs/spec/34-usage-metrics.md
 */
export function UsageTab({ payload }: { payload: UsagePayload }): JSX.Element {
  const { insights, reach } = payload;
  return (
    // `sp` for the table width cap and the tab's shared type scale, `ug` for what
    // is this tab's own — the same borrowing `McpUsageTab` does, and for the same
    // reason: two spellings of one measure drift the day somebody retunes one.
    <div className="ug sp">
      <p className="sp-sub">What the harness asked of you</p>
      <Ledger rows={insights.asks} kind="ask" />

      <p className="sp-sub">What you reached in and did</p>
      <Ledger rows={insights.acts} kind="act" />

      {/* The rate is half of every parked figure above, and a reader deciding to
          act on the product is entitled to both: on a quiet week the cost of a
          wait is small for reasons that have nothing to do with the ask. */}
      <p className="ug-rate">
        Parked cost is priced at this fleet&rsquo;s own burn over this window —{' '}
        <b>${insights.fleetRateUsdPerHour.toFixed(2)}/hour</b>. It is what the fleet did <i>not</i> do while it waited,
        and it moves with the rate as much as with the wait.
      </p>

      <p className="sp-sub">What you looked at, and what it means that you didn&rsquo;t</p>
      <Reach reach={reach} />
    </div>
  );
}

/**
 * One half of the ledger. Two tables rather than one, because an ask and an act
 * are two different questions: an ask is judged by whether it was answered and
 * what waiting for it cost, an act by whether it happened at all — an act nobody
 * ever performs is a control nobody needs.
 */
function Ledger({ rows, kind }: { rows: OperatorRow[]; kind: 'ask' | 'act' }): JSX.Element {
  if (rows.length === 0) return <p className="empty">Nothing in this window.</p>;
  return (
    <table className="ug-tbl">
      <thead>
        <tr>
          <th scope="col">{kind === 'ask' ? 'Ask' : 'Act'}</th>
          <th scope="col">{kind === 'ask' ? 'Asked' : 'Available'}</th>
          <th scope="col">{kind === 'ask' ? 'Answered' : 'Done'}</th>
          <th scope="col">Declined</th>
          <th scope="col">Open past window</th>
          <th scope="col">Time to answer</th>
          <th scope="col">Parked cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">
              <span className="ug-label">{row.label}</span>
              <span className="ug-blurb">{row.blurb}</span>
            </th>
            <td>{num(row.offered)}</td>
            <td>{row.settled}</td>
            <td>{num(row.declined)}</td>
            <td className={row.openPastWindow > 0 ? 'ug-late' : ''}>{row.openPastWindow}</td>
            <td>{row.medianAnswerMs === null ? DASH : fmtDuration(row.medianAnswerMs)}</td>
            <td>{row.parkedCostUsd === null ? DASH : `$${row.parkedCostUsd.toFixed(2)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The reach half — a list rather than a table, for `.mc-quiet`'s reason: each row
 * is a **verdict with its evidence**, and the reader wants one surface's whole
 * case at a time rather than a set of figures read down a column.
 *
 * Ordered by what wants doing about it, which is the server's ladder read back:
 * a surface nothing links to is the harness's own fault, a linked one nobody
 * visited is an entry point that is not landing, and a visited one nobody
 * operated is the surface's.
 */
function Reach({ reach }: { reach: { rows: SurfaceRow[]; total: number; places: number } }): JSX.Element {
  if (reach.total === 0)
    return (
      <p className="empty">
        Nothing was reached in this window at all. That is not a quiet product — it is a dark console, and no
        per-surface reading taken over this window means anything.
      </p>
    );
  const rows = [...reach.rows].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  return (
    <>
      <ul className="ug-reach">
        {rows.map((row) => (
          <li key={row.subject} className={`ug-v-${row.verdict}`}>
            <p className="ug-r-head">
              <span className="ug-label">{row.label}</span>
              <span className="ug-r-verdict">{row.verdictLabel}</span>
            </p>
            <p className="ug-blurb">{row.verdictBlurb}</p>
            <p className="ug-ev">
              <b>{row.views}</b> reached (<b>{row.linkedViews}</b> by a link) · <b>{row.operations}</b> operated
              {row.byVerb.length > 0 && (
                <> · {row.byVerb.map((v) => `${v.label.toLowerCase()} ${v.count}`).join(', ')}</>
              )}
            </p>
          </li>
        ))}
      </ul>
      <p className="ug-rate">
        Drawn over <b>{reach.total}</b> recorded{reach.total === 1 ? ' act' : ' acts'} across <b>{reach.places}</b>{' '}
        {reach.places === 1 ? 'surface' : 'surfaces'}. Whether a thing was <i>read</i> is not observable here and no
        figure above pretends otherwise — what answers that is an ask above settled without the surface it is about ever
        having been opened.
      </p>
    </>
  );
}

/** What wants doing about it, worst first. */
const ORDER = ['never-linked', 'linked-never-visited', 'visited-never-operated', 'operated', 'console-dark'];

/**
 * The mark for a column the record cannot answer.
 *
 * An en dash and never `0`: a zero here would manufacture a finding out of a
 * missing column, which is the one way this reading could mislead somebody into
 * removing a control that works.
 */
const DASH = '–';

function num(value: number | null): string | number {
  return value === null ? DASH : value;
}

/**
 * The tab as a file, in the order it is drawn.
 *
 * The verdicts go out as rows rather than as prose, because on paper there is no
 * blurb under a heading to read them off.
 */
export function usageCsv(payload: UsagePayload): string[][] {
  const { insights, reach } = payload;
  const ledger = (rows: OperatorRow[]): string[][] =>
    rows.map((r) => [
      r.kind,
      r.label,
      str(r.offered),
      String(r.settled),
      str(r.declined),
      String(r.openPastWindow),
      str(r.medianAnswerMs),
      str(r.parkedCostUsd),
    ]);
  return [
    [`Window: ${insights.window.label}`],
    [`Fleet rate: $${insights.fleetRateUsdPerHour.toFixed(2)}/hour`],
    [],
    ['kind', 'row', 'offered', 'settled', 'declined', 'openPastWindow', 'medianAnswerMs', 'parkedCostUsd'],
    ...ledger(insights.asks),
    ...ledger(insights.acts),
    [],
    ['subject', 'verdict', 'views', 'linkedViews', 'operations'],
    ...reach.rows.map((r) => [r.label, r.verdict, String(r.views), String(r.linkedViews), String(r.operations)]),
  ];
}

/** An empty cell for a null, so a spreadsheet does not read a missing column as a zero. */
function str(value: number | null): string {
  return value === null ? '' : String(value);
}
