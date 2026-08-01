import type { JSX } from 'react';
import type { Decision, DispatchRule } from '../../../types.js';
import { linkify, decisionAttribution } from '../../../components/util.js';
import { Icon, type IconName } from './Sprite.js';

/** The machine that carried the act out — the same vocabulary the floor uses. */
function iconForAction(type: string): IconName {
  if (type.startsWith('dispatch_')) return 'bot';
  if (type === 'merge_pr') return 'rocket';
  if (type === 'reply_on_pr' || type === 'respond_to_agent') return 'inserter';
  if (type === 'escalate') return 'alert';
  if (type === 'propose_plan') return 'blueprint';
  if (type === 'set_work_item_state') return 'chest';
  return 'gear';
}

const stamp = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });

/**
 * The shift log. Every decision the harness recorded, newest first.
 *
 * The `by` column is read off the cycle id, not off a column of its own: an act
 * a human authorized is audited under `human:<id>`, which is the same signal
 * Classic's decision log badges. Reading it here rather than adding a field is
 * what keeps the two skins agreeing about who did what.
 *
 * Rule and Outcome are two columns for the same reason they are two columns on
 * the row: what proposed an act and what became of it are different facts, and a
 * throttled pickup showing only `Attempt cap reached` was the whole defect.
 * `decisionAttribution` is shared with Classic so neither skin has to re-decide
 * what a pre-split row means.
 */
export function EventLog({
  decisions,
  rules,
  refUrls,
}: {
  decisions: Decision[];
  rules: Record<string, DispatchRule>;
  refUrls: Record<string, string>;
}): JSX.Element {
  if (decisions.length === 0) return <p className="fx-empty">Nothing decided yet — no scan has completed.</p>;

  return (
    <div className="fx-scroll">
      <table className="fx-table">
        <thead>
          <tr>
            <th>Tick</th>
            <th>Action</th>
            <th>Detail</th>
            <th>Rule</th>
            <th>Outcome</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {decisions.slice(0, 14).map((d) => {
            const { entries, note } = decisionAttribution(d, rules);
            // A pre-split row's single id is an *outcome*, so it is labelled
            // `Outcome` and the Rule cell stays empty — the proposer it lost is
            // not in the row, and inventing one here would be the conflation
            // this split removed.
            const cell = (label: string) => entries.find((e) => e.label === label);
            const proposed = cell('Proposed by');
            const became = cell('Admitted as') ?? cell('Outcome');
            const byHuman = d.cycleId.startsWith('human:');
            return (
              <tr key={d.id}>
                <td className="t">{stamp(d.createdAt)}</td>
                <td className="a">
                  <span>
                    <Icon name={iconForAction(d.action.type)} className="sm" />
                    {d.action.type.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>{linkify(d.detail, refUrls)}</td>
                <td title={proposed?.rule?.description ?? note}>{proposed?.rule?.name ?? '—'}</td>
                <td title={became?.rule?.description ?? note}>{became?.rule?.name ?? '—'}</td>
                <td>
                  <span className={`fx-by ${byHuman ? 'you' : ''} ${d.outcome === 'rejected' ? 'bad' : ''}`}>
                    {byHuman ? `you · ${d.outcome}` : d.outcome}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
