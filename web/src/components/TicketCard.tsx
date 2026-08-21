import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { cardReason } from '../ticketBoard.js';
import { cascadeNote, issueTypeTone, watchReading } from '../issueGroups.js';
import type { Issue, TicketRow } from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { fmtUsd, relAge } from './util.js';

/**
 * One card on the board: what it is, what the harness makes of it, and the two things
 * a click can do.
 *
 * **The reason lane is always drawn**, and it is the board's whole advantage over the
 * table — a column of cards answers "why is nothing on this?" without a click on any
 * of them. `cardReason` decides which of five readings supplies it, because that is a
 * statement about precedence and no render can show one.
 *
 * **The title opens the goal**, through the same `selectGoal` every other surface
 * that lists one calls. The `<Ref>` sits beside it rather than inside it: one click
 * cannot have two destinations.
 *
 * **The watch dot is the control.** The table's Watch/Unwatch pair does not fit here
 * and the lane has the space it would take, so the dot both reports the tag and writes
 * it — with `cascadeNote`'s phrase in the title, so a click that writes eight tags
 * says eight. It is refused in the three cases the table refuses it, each with its
 * reason in the title. The drag handle is the card body, so a drag beginning on the
 * dot moves nothing and a drag across the board cannot fire it.
 */
export function TicketCard({
  row,
  issue,
  view,
  actions,
  now,
  draggable,
  writing = null,
  refused = null,
  onDragStart,
  onDragEnd,
}: {
  row: TicketRow;
  /** The live world's own row where it still holds one — the source of every live reading. */
  issue: Issue | null;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
  draggable: boolean;
  /** The state being written, while this card's own write is in flight. */
  writing?: string | null;
  /** The provider's own sentence, after a refusal put this card back. */
  refused?: string | null;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}): JSX.Element {
  const { watchLabel, containerTypes } = view.state.config;
  const frozen = row.tracking === 'frozen';
  const age = row.changedAt === null ? '' : relAge(row.changedAt, now);
  const reason = cardReason(row, issue, watchLabel, age);
  const watched = watchReading(issue, row, watchLabel) === 'watched';
  const off =
    watchLabel === ''
      ? 'No watch label configured — the watch gate is off'
      : frozen
        ? 'Closed in the tracker — there is nothing here to tag'
        : issue === null
          ? 'The world no longer holds this item, so there is nothing to tag'
          : null;
  const also = issue === null ? '' : cascadeNote(issue, containerTypes);

  return (
    <article
      className={`tb-card${frozen ? ' frozen' : ''}${writing !== null ? ' writing' : ''}${refused !== null ? ' refused' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-number={row.number}
    >
      <i className={`tb-stripe f${row.featureSlot ?? 0}`} />
      <div className="tb-top">
        <span className="tb-id">#{row.number}</span>
        {row.issueType !== null && <i className={`tickets-type ${issueTypeTone(row.issueType)}`}>{row.issueType}</i>}
        {reason.tone === 'held' && <i className="tickets-lamp" />}
        <AsyncButton
          className={`tb-dot${watched ? ' on' : ''}`}
          disabled={off !== null}
          onClick={() => actions.setIssueWatched(row.number, !watched)}
          title={
            off ??
            (watched
              ? `Take "${watchLabel}" off #${row.number}${also}, so the harness leaves it alone`
              : `Tag #${row.number}${also} "${watchLabel}" so the harness picks it up`)
          }
        >
          <span aria-hidden="true" />
        </AsyncButton>
        <span className="tb-gap" />
        {/* The card names the ticket and this is the way to it — drawn with `<Ref>`,
            never as text, and never inside the button above. */}
        <span className="cn-refs">
          <Ref to={`issue:${row.number}`} />
        </span>
      </div>
      <button
        type="button"
        className="tb-name"
        onClick={() => actions.selectGoal(`issue:${row.number}`)}
        title="Open this goal — its plan, its ticket, its pull requests and anything it is asking you"
      >
        {row.title}
      </button>
      <div className="tb-meta">
        {/* An em dash, not `$0.00`: never worked and worked for free are different
            facts, and a zero would state the wrong one. */}
        <span className={row.costUsd === null ? 'none' : 'money'}>
          {row.costUsd === null ? '—' : fmtUsd(row.costUsd)}
        </span>
        {age !== '' && <span>{age}</span>}
        {row.parent && (
          <span className="tb-feat" title={`Feature #${row.parent.number}`}>
            <i className={`tickets-sw f${row.featureSlot ?? 0}`} />
            {row.parent.title}
          </span>
        )}
      </div>
      <p className={`tb-why ${reason.tone}`}>{reason.words}</p>
      {writing !== null && (
        <p className="tb-writing">
          <span className="tickets-spin" aria-hidden="true" />
          writing “{writing}” to the tracker…
        </p>
      )}
      {/* Quoted, never paraphrased: it is the only account of why the card came back,
          and a snap-back with no sentence reads as the board being broken. */}
      {refused !== null && <p className="tb-refused">{refused}</p>}
    </article>
  );
}
