import type { JSX } from 'react';
import type { ChecksSpend, SpendInsights, TaskTypeSpend } from '../types.js';
import { fmtUsd } from './util.js';
import { fmtShare, localPhaseCostUsd } from './insightsFormat.js';

// → docs/spec/17-cockpit.md

export function WorkMixTab({ insights }: { insights: SpendInsights }): JSX.Element {
  return (
    <div className="sp">
      <div className="sp-cols">
        <section className="sp-col">
          <p className="sp-sub">By task type</p>
          <TaskTypes
            types={insights.taskTypes}
            total={insights.totals.costUsd}
            localCostUsd={localPhaseCostUsd(insights)}
          />
        </section>
        <section className="sp-col">
          <p className="sp-sub">By failing check</p>
          <Checks checks={insights.checks} />
        </section>
      </div>
      <p className="sp-note">
        Both tables are a partition of the {fmtUsd(insights.totals.costUsd)} above, cut by what the fleet was asked to
        do rather than by which phase it was in.
      </p>
    </div>
  );
}

function TaskTypes({
  types,
  total,
  localCostUsd,
}: {
  types: readonly TaskTypeSpend[];
  total: number;
  localCostUsd: number;
}): JSX.Element {
  if (types.length === 0) return <p className="empty">Nothing has been measured yet.</p>;
  return (
    <>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>Task type</th>
            <th className="n">Cost</th>
            <th className="n">Share</th>
            <th className="n">Runs</th>
            <th className="n">Each</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.rule ?? '—'}>
              <td>
                <span className="nm" title={t.description ?? undefined}>
                  {t.label}
                </span>
                {t.rule !== null && <span className="bl mono">{t.rule}</span>}
              </td>
              <td className="n b">{fmtUsd(t.costUsd)}</td>
              <td className="n">{fmtShare(t.costUsd, total)}</td>
              <td className="n">{t.runs}</td>
              <td className="n">{fmtUsd(t.perRunUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Every other table here says what it does not hold. This one cannot hold a
          local run at all: the rows are keyed on the dispatch rule that sent the
          agent, and nothing dispatched a local run. */}
      {localCostUsd > 0 && (
        <p className="empty">
          A further {fmtUsd(localCostUsd)} went on local runs, which have no dispatch rule and are in none of the rows
          above.
        </p>
      )}
    </>
  );
}

function Checks({ checks }: { checks: ChecksSpend }): JSX.Element {
  const { checks: rows, seen, attributedCostUsd, unnamedCostUsd } = checks;
  if (rows.length === 0) {
    return (
      <p className="empty">
        {unnamedCostUsd > 0
          ? `${fmtUsd(unnamedCostUsd)} went on CI, but no run named the checks it was answering — the provider ` +
            'reports no per-check detail.'
          : 'No CI agent has run yet, so no check has cost anything.'}
      </p>
    );
  }
  return (
    <>
      <table className="sp-tbl">
        <thead>
          <tr>
            <th>Check</th>
            <th className="n">Cost</th>
            <th className="n">Share</th>
            <th className="n">Runs</th>
            <th className="n">Each</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.name}>
              <td>
                <span className="nm mono">{c.name}</span>
                {/* Named alone on every dispatch means the cost is unshared and
                    the row is exact — worth saying, since it is the difference
                    between a figure and an estimate. */}
                <span className="bl">
                  {c.soleRuns === c.runs
                    ? 'always the only check red — unshared'
                    : `${c.soleRuns} of ${c.runs} runs were about this check alone`}
                </span>
              </td>
              <td className="n b">{fmtUsd(c.costUsd)}</td>
              <td className="n">{fmtShare(c.costUsd, attributedCostUsd)}</td>
              <td className="n">{c.runs}</td>
              <td className="n">{fmtUsd(c.perRunUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="empty">
        A run sent at several red checks splits its cost evenly between them — nothing records which one it actually
        worked on, so these are shares, not receipts.
        {seen > rows.length && ` The ${rows.length} costliest of ${seen} checks.`}
        {unnamedCostUsd > 0 &&
          ` A further ${fmtUsd(unnamedCostUsd)} went on CI runs that named no check, and is in none of the rows above.`}
      </p>
    </>
  );
}
