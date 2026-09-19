import type { JSX } from 'react';
import type { GoalPageView, GoalReachCell, GoalReachRow } from '../view/goalPage.js';
import { buildGoalReachMatrix } from '../view/goalPage.js';
import { Ref } from './refs.js';

// → docs/spec/24-environments.md

/**
 * The goal's parts against its environments, one row each.
 *
 * A goal is checked as a whole or not at all — `rollUpReach` answers `reached` only when every
 * landing it owes has been read as present, and `newArrivals` skips everything else. So between
 * the first part landing and the last there is nothing to check and nothing failing, and the
 * environment rows below can say only *how many* landings are short. This says which, which is
 * the only thing on that reading an operator can act on.
 */
const CELL_SAID: Record<GoalReachCell, string> = {
  reached: 'reached',
  absent: 'not there',
  unknown: 'the probe could not say',
  never: 'can never be reached — this landing is an ancestor of nothing',
  pending: 'not asked yet',
};

const CELL_GLYPH: Record<GoalReachCell, string> = {
  reached: '✓',
  absent: '',
  unknown: '?',
  never: '✕',
  pending: '',
};

export function GoalReachMatrix({ page }: { page: GoalPageView }): JSX.Element | null {
  const matrix = buildGoalReachMatrix(page);
  if (matrix.environments.length === 0 || matrix.rows.length === 0) return null;
  return (
    <section className="cn-card cn-reachm">
      <h3>
        Every part, every environment
        <i className="cn-n">{heading(matrix.rows, matrix.owed)}</i>
      </h3>
      <table className="cn-reachm-grid">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">PR</th>
            {matrix.environments.map((name) => (
              <th scope="col" key={name} className="cn-reachm-env">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.key} className={row.unplaced ? 'cn-reachm-stranded' : undefined}>
              <th scope="row">
                <span className={row.kind === 'unattributed' ? 'cn-sub' : undefined}>{row.title}</span>
              </th>
              <td>{row.prNumber === null ? <i className="cn-sub">—</i> : <Ref to={`pr:${row.prNumber}`} />}</td>
              {row.cells.map((cell, i) => (
                <td key={matrix.environments[i]} className="cn-reachm-cell">
                  <i
                    className={`cn-reachm-m cn-reachm-${cell}`}
                    title={`${matrix.environments[i]} — ${CELL_SAID[cell]}`}
                    aria-label={`${matrix.environments[i]} — ${CELL_SAID[cell]}`}
                  >
                    {CELL_GLYPH[cell]}
                  </i>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Said out loud rather than left to be read off the grid: a goal short of an environment
          is not part-way checked, it is not checkable, and the difference is the whole reason
          this card is drawn above the rows rather than instead of them. */}
      <p className="cn-reachm-said">{said(matrix.rows, matrix.owed)}</p>
    </section>
  );
}

function heading(rows: readonly GoalReachRow[], owed: number): string {
  const parts = rows.filter((r) => r.kind === 'part').length;
  const claimless = rows.length - parts;
  const tail = claimless === 0 ? '' : ` · ${claimless} claimed by no part`;
  return `${parts} ${parts === 1 ? 'part' : 'parts'}${tail}${owed === 0 ? '' : ` · ${owed} owed`}`;
}

function said(rows: readonly GoalReachRow[], owed: number): string {
  if (rows.some((r) => r.unplaced))
    return 'A landing here is an ancestor of nothing, so no environment can ever hold it and this goal can never be checked. Nothing below will resolve it.';
  if (owed > 0)
    return `Nothing can be checked yet: no environment holds every part, so no arrival is recorded and no sheet is assembled. ${owed} ${owed === 1 ? 'landing is' : 'landings are'} owed before the first check can exist.`;
  return 'Every part has reached an environment, so the arrival is recorded and the sheet below is what says whether the goal held up.';
}
