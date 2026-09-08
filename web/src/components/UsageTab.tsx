import type { JSX } from 'react';
import type { OperatorRow, SurfaceRow, UsagePayload } from '../types.js';
import { fmtDuration } from './insightsFormat.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/17-cockpit.md

export function UsageTab({ payload }: { payload: UsagePayload }): JSX.Element {
  const { insights, reach } = payload;
  return (
    <div className="ug sp">
      <p className="sp-sub">What the harness asked of you</p>
      <Ledger rows={insights.asks} kind="ask" />

      <p className="sp-sub">What you reached in and did</p>
      <Ledger rows={insights.acts} kind="act" />

      <p className="ug-rate">
        Parked cost is priced at <b>${insights.fleetRateUsdPerHour.toFixed(2)}/hour</b>, this fleet&rsquo;s own burn.
      </p>

      <p className="sp-sub">What you looked at</p>
      <Reach reach={reach} />

      <MethodNote>
        {/* The rate is half of every parked figure above, and a reader deciding to
            act on the product is entitled to both: on a quiet week the cost of a
            wait is small for reasons that have nothing to do with the ask. */}
        <p>
          <b>Parked cost is what the fleet did not do while it waited.</b> It is priced at the fleet&rsquo;s burn over
          this window, so it moves with the rate as much as with the wait.
        </p>
        <p>
          <b>Whether a thing was read is not observable here</b> and no figure above pretends otherwise — what answers
          that is an ask settled without the surface it is about ever having been opened.
        </p>
      </MethodNote>
    </div>
  );
}

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
        {reach.places === 1 ? 'surface' : 'surfaces'}.
      </p>
    </>
  );
}

const ORDER = ['never-linked', 'linked-never-visited', 'visited-never-operated', 'operated', 'console-dark'];

const DASH = '–';

function num(value: number | null): string | number {
  return value === null ? DASH : value;
}

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

function str(value: number | null): string {
  return value === null ? '' : String(value);
}
