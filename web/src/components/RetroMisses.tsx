import type { JSX } from 'react';
import type { RemedyInsights, RetroMissInsights } from '../types.js';
import { relTime } from './util.js';
import { Ref } from './refs.js';
import { HeadRow } from './panel.js';
import { Tag } from './tag.js';
import { MethodNote } from './insightsMethod.js';

// → docs/spec/17-cockpit.md#causes, docs/spec/41-repo-lessons.md#retrospective-misses

export function RetroMisses({ retros, windowLabel }: { retros: RetroMissInsights; windowLabel: string }): JSX.Element {
  const rows = retros.byCause.filter((c) => c.misses > 0).sort((a, b) => b.misses - a.misses);
  return (
    <>
      <p className="sp-sub">From retrospectives, {windowLabel}</p>
      <table className="sp-tbl wide">
        <thead>
          <tr>
            <th>Cause</th>
            <th className="n">Misses</th>
            <th className="n">Undocumented</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.cause}>
              <td>
                <span className="nm" title={c.blurb}>
                  {c.label}
                </span>
                <span className="bl">{c.blurb}</span>
              </td>
              <td className="n b">{c.misses}</td>
              <td className="n">
                {c.undocumented > 0 ? `${c.undocumented} of ${c.misses}` : <span className="dim">&mdash;</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        {retros.recent.map((m) => (
          <div className="rm-row" key={m.id}>
            <HeadRow align="baseline" className="rm-head">
              <Ref to={m.ref} />
              <Tag>{m.causeLabel.toLowerCase()}</Tag>
              <span className="tag rm-guard" style={{ color: `var(--rm-${m.guard})` }}>
                {m.guardLabel.toLowerCase()}
              </span>
              <span className="bl mono">{m.path}</span>
              <span className="rm-when">{relTime(m.at)}</span>
            </HeadRow>
            <div>{m.summary}</div>
          </div>
        ))}
      </div>
      <p className="sp-note">
        {retros.misses} miss{retros.misses === 1 ? '' : 'es'} recorded by the retrospectives of {retros.goals} goal
        {retros.goals === 1 ? '' : 's'} &mdash; counted apart from the accounts above, never summed into them.
      </p>
      <MethodNote>
        <p>
          <b>A retrospective miss is what the agent writing up a goal said the goal paid for</b>, chosen from the same
          causes and guards as an account, with the file it was about. It is not a return to a pull request, so it has
          no cost here, and a goal that also came back for the same reason is still one goal to a lesson. Every
          retrospective in the window is counted here, as every account is above, including those a repo lesson leaves
          out.
        </p>
      </MethodNote>
    </>
  );
}

export function retroMissRows(remedies: RemedyInsights): (string | number | null)[][] {
  const { retros } = remedies;
  if (retros.misses === 0) return [];
  return [
    ['From retrospectives'],
    ['Misses recorded', retros.misses],
    ['Goals', retros.goals],
    ['Cause', 'Label', 'Misses', 'Undocumented'],
    ...retros.byCause.map((c) => [c.cause, c.label, c.misses, c.undocumented]),
    ['When (ISO)', 'Goal', 'Path', 'Cause', 'Guard', 'Summary'],
    ...retros.recent.map((m) => [m.at, m.ref, m.path, m.cause, m.guard, m.summary]),
  ];
}
