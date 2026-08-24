import type { JSX } from 'react';
import type { PoolFleetReading, PoolInsightsPayload, PoolRollupRow } from '../types.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { fmtUsd, relTime } from './util.js';

/**
 * The shared insights page: what the whole pool spent, across fleets.
 *
 * It reads the pulled documents live. **It is not a committed artefact and there is
 * no generated file**, so there is nothing for two fleets to conflict on — which is
 * the whole of why the pool is a distribution mechanism and not a shared page that
 * tooling edits.
 *
 * Two things about it are load-bearing, and both are about what it refuses to draw.
 *
 * **`byCheck` appears only inside a project.** Three fleets on one problem produce
 * `test (windows)`, `ci/test-windows` and `Build & Test (win-latest)`; summed across
 * projects that is three rows of one instead of one row of three, and it renders
 * perfectly — a chart saying no single check causes much pain, with nothing red. So
 * the server answers `null` rather than a list, and this draws the reason.
 *
 * **A null cost is never `$0.00`.** A window in which nothing was measured and a
 * window that cost nothing are different facts, and the second is a claim that the
 * fleet worked for free.
 *
 * → `docs/spec/28-cross-fleet-pool.md#in-the-cockpit`
 */
export function PoolTab({
  payload,
  project,
  actions,
}: {
  payload: PoolInsightsPayload;
  project: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const { rollup } = payload;
  return (
    <div className="pool">
      <div className="pool-bar">
        <span className="insights-lb">Project</span>
        <div className="insights-win" role="group" aria-label="Project">
          <button
            type="button"
            aria-pressed={project === null}
            className={project === null ? 'on' : ''}
            onClick={() => actions.openInsights({ insightsView: 'pool', poolProject: null })}
          >
            All
          </button>
          {payload.projects.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={name === project}
              className={name === project ? 'on' : ''}
              onClick={() => actions.openInsights({ insightsView: 'pool', poolProject: name })}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="insights-meta">
          {rollup.fleets.length} fleet{rollup.fleets.length === 1 ? '' : 's'} ·{' '}
          {rollup.days.length === 0 ? 'nothing published yet' : `${rollup.days.length} UTC days`}
        </span>
      </div>

      <Fleets fleets={payload.fleets} />

      {rollup.days.length === 0 ? (
        <p className="empty">
          No fleet has published a digest to this pool yet. That is not the same as a pool nobody can reach — the
          Knowledge page says when this fleet last polled.
        </p>
      ) : (
        <>
          <Section
            title="By phase"
            note="the fleet's whole bill, partitioned. There is no separate total — the phases are one."
            rows={rollup.byPhase}
          />
          <Section
            title="What keeps sending fleets back"
            note="cause and guard, in closed vocabularies"
            rows={rollup.byCause}
          />
          {rollup.byCheck === null ? (
            <p className="pool-refusal">
              Per-check costs are shown only inside a project. Check names are a provider’s own, so three fleets on one
              problem produce three keys — summed across projects that reads as no check costing much, which is wrong
              and looks fine. Pick a project above.
            </p>
          ) : (
            <Section title="By check" note="comparable here because it is one pipeline" rows={rollup.byCheck} />
          )}
          <div className="pool-caveats">
            <Caveat
              label="Returns that filed no account"
              row={rollup.unaccounted}
              note="every share above is a share of what is left after these"
            />
            <Caveat
              label="Runs that measured nothing"
              row={rollup.unmeasured}
              note="real work with no dollars behind it — a PTY fleet is not a cheap fleet"
            />
          </div>
        </>
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

function Caveat({ label, row, note }: { label: string; row: PoolRollupRow; note: string }): JSX.Element {
  return (
    <div className="pool-caveat">
      <span className="pool-caveat-n">{row.count}</span>
      <div>
        <strong>{label}</strong>
        <p className="pool-note">{note}</p>
      </div>
    </div>
  );
}

/**
 * Who is in the pool, and what this build could make of each of them.
 *
 * A fleet **ahead of this build** is drawn as such rather than as a fleet that has
 * published nothing — the three verdicts' discipline, one level up: read as
 * absence, an unreadable document says in the operator's words that nobody else
 * knows anything.
 */
function Fleets({ fleets }: { fleets: PoolFleetReading[] }): JSX.Element | null {
  if (fleets.length === 0) return null;
  return (
    <div className="pool-fleets">
      {fleets.map((fleet) => (
        <span key={fleet.fleetId} className={fleet.ahead ? 'pool-fleet ahead' : 'pool-fleet'}>
          {/* No `<Ref/>`: a pooled fleet has no ref to draw, and its name is text. */}
          <strong>{fleet.fleetId}</strong>
          {fleet.project === null ? null : <span className="pool-fleet-p">{fleet.project}</span>}
          <span className="pool-fleet-at">
            {fleet.ahead ? 'ahead of this build' : fleet.digestAt === null ? 'no digest yet' : relTime(fleet.digestAt)}
          </span>
        </span>
      ))}
    </div>
  );
}
