import type { JSX, ReactNode } from 'react';
import type { PoolFleetReading, PoolInsightsPayload, PoolRollupRow } from '../types.js';
import { fmtUsd, relTime } from './util.js';
import { MethodNote } from './insightsMethod.js';
import { fleetClass } from './PoolStatus.js';

// → docs/spec/17-cockpit.md#just-me-or-the-pool, docs/spec/28-cross-fleet-pool.md#in-the-cockpit

/* The pool's half of four tabs. Each is the same reading as the fleet's own tab,
   over every fleet that publishes a digest — so it is drawn under that tab
   rather than beside it. */

export function PoolEconomics({ payload }: { payload: PoolInsightsPayload }): JSX.Element {
  const { rollup } = payload;
  return (
    <Pool payload={payload}>
      <Section title="By phase" note="the whole bill, partitioned — the phases are the total" rows={rollup.byPhase} />
      {rollup.byCheck === null ? (
        <p className="pool-refusal">
          Per-check costs need a project. Check names are a provider’s own, so summing them across projects understates
          every check.
        </p>
      ) : (
        <Section title="By check" note="one pipeline, so these compare" rows={rollup.byCheck} />
      )}
      <div className="pool-caveats">
        <Caveat label="Returns that filed no account" row={rollup.unaccounted} />
        <Caveat label="Runs that measured nothing" row={rollup.unmeasured} />
      </div>
      <MethodNote>
        <p>
          <b>Every share is a share of what is left</b> after the returns that filed no account. A run that measured
          nothing is real work with no dollars behind it — a PTY fleet is not a cheap fleet.
        </p>
        <p>
          <b>Per-check costs are shown only inside a project.</b> Check names are a provider’s own, so three fleets on
          one problem produce three keys — summed across projects that reads as no check costing much, which is wrong
          and looks fine.
        </p>
      </MethodNote>
    </Pool>
  );
}

export function PoolCauses({ payload }: { payload: PoolInsightsPayload }): JSX.Element {
  return (
    <Pool payload={payload}>
      <Section
        title="What keeps sending fleets back"
        note="cause and guard, in closed vocabularies"
        rows={payload.rollup.byCause}
      />
    </Pool>
  );
}

export function PoolUsage({ payload }: { payload: PoolInsightsPayload }): JSX.Element {
  const { rollup } = payload;
  return (
    <Pool payload={payload}>
      <Counted
        title="What a person did"
        note="subject and verb, in vocabularies the harness owns"
        rows={rollup.byUsage}
        publishing={rollup.fleets.length}
        empty="Nothing yet. Only acts the cockpit witnesses on the click are here."
      />
      <MethodNote>
        <p>
          <b>These rows compare across providers</b> because the vocabularies are the harness’s own. <b>Times</b> is how
          often it happened; <b>Fleets</b> is how many people did it at all. An act a table already records is swept by
          each fleet’s own operator ledger instead.
        </p>
      </MethodNote>
    </Pool>
  );
}

/* What appears here is what each fleet declared its own: a slice its provider
   filtered to that operator. → docs/spec/28-cross-fleet-pool.md */
export function PoolThroughput({ payload }: { payload: PoolInsightsPayload }): JSX.Element {
  const { rollup } = payload;
  return (
    <Pool payload={payload}>
      <Counted
        title="What the fleets shipped"
        note="the output each fleet could vouch for as its own"
        rows={rollup.byThroughput}
        publishing={rollup.fleets.length}
        empty="Nothing yet. No fleet has published output it could vouch for as its own."
      />
      <MethodNote>
        <p>
          <b>Only vouched output crosses.</b> A slice that arrived unfiltered is a fact about the <em>repository</em>,
          which every fleet watching it also reports, so it is withheld here and stays on that fleet’s own Throughput
          tab.
        </p>
        <p>
          <b>Fleets</b> is therefore how many fleets could vouch for a row, not how many published; a measure missing
          entirely is one no fleet could.
        </p>
      </MethodNote>
    </Pool>
  );
}

function Pool({ payload, children }: { payload: PoolInsightsPayload; children: ReactNode }): JSX.Element {
  return (
    <div className="pool">
      <Fleets fleets={payload.fleets} />
      {payload.rollup.days.length === 0 ? (
        <p className="empty">
          No fleet has published a digest to this pool yet. That is not the same as a pool nobody can reach — the
          Knowledge page says when this fleet last polled.
        </p>
      ) : (
        children
      )}
    </div>
  );
}

function Section({ title, note, rows }: { title: string; note: string; rows: PoolRollupRow[] }): JSX.Element {
  const ranked = [...rows].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  return (
    <section className="pool-section">
      <h3>{title}</h3>
      <p className="pool-note">{note}</p>
      {ranked.length === 0 ? (
        <p className="empty">Nothing in this section yet.</p>
      ) : (
        <table className="pool-table">
          <thead>
            <tr>
              <th>What</th>
              <th className="num">Count</th>
              <th className="num">Cost</th>
              <th className="num">Per whole day</th>
              <th className="num">Fleets</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className="num">{row.count}</td>
                {/* Never `$0.00` for an absence: a dash says nothing was measured. */}
                <td className="num">{row.costUsd === null ? '—' : fmtUsd(row.costUsd)}</td>
                <td className="num">{row.dailyMeanCostUsd === null ? '—' : fmtUsd(row.dailyMeanCostUsd)}</td>
                <td className="num">{row.fleets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Counted({
  title,
  note,
  rows,
  publishing,
  empty,
}: {
  title: string;
  note: string;
  rows: PoolRollupRow[];
  publishing: number;
  empty: string;
}): JSX.Element {
  return (
    <section className="pool-section">
      <h3>{title}</h3>
      <p className="pool-note">{note}</p>
      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <table className="pool-table">
          <thead>
            <tr>
              <th>What</th>
              <th className="num">Times</th>
              <th className="num">Fleets</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className="num">{row.count}</td>
                <td className="num">
                  {row.fleets} of {publishing}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Caveat({ label, row }: { label: string; row: PoolRollupRow }): JSX.Element {
  return (
    <div className="pool-caveat">
      <span className="pool-caveat-n">{row.count}</span>
      <strong>{label}</strong>
    </div>
  );
}

function Fleets({ fleets }: { fleets: PoolFleetReading[] }): JSX.Element | null {
  if (fleets.length === 0) return null;
  return (
    <div className="pool-fleets">
      {fleets.map((fleet) => (
        <span key={fleet.fleetId} className={fleetClass(fleet)}>
          {/* No `<Ref/>`: a pooled fleet has no ref to draw, and its name is text. */}
          <strong>{fleet.fleetId}</strong>
          {fleet.project === null ? null : <span className="pool-fleet-p">{fleet.project}</span>}
          <span className="pool-fleet-at">
            {fleet.ahead ? 'ahead of this build' : fleet.digestAt === null ? 'no digest yet' : relTime(fleet.digestAt)}
          </span>
          {/* Expired out of every total on this page, and still named: a fleet dropped
              without a word reads as one that was never in the pool. */}
          {fleet.stale && !fleet.ahead ? <span className="pool-fleet-at">expired — not counted below</span> : null}
        </span>
      ))}
    </div>
  );
}
