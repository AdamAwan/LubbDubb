import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { cardReason } from '../ticketBoard.js';
import { cascadeNote, issueTypeTone, watchOff, watchReading } from '../issueGroups.js';
import type { Issue, TicketRow } from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { fmtUsd, relAge } from './util.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

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
  issue: Issue | null;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
  draggable: boolean;
  writing?: string | null;
  refused?: string | null;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}): JSX.Element {
  const { watchLabel, containerTypes } = view.state.config;
  const frozen = row.tracking === 'frozen';
  const age = row.changedAt === null ? '' : relAge(row.changedAt, now);
  const reason = cardReason(row, issue, watchLabel, age);
  const watched = watchReading(issue, row, watchLabel) === 'watched';
  const off = watchOff(watchLabel, frozen, issue);
  const also = issue === null ? '' : cascadeNote(issue, containerTypes);

  return (
    <article
      className={cardClass(frozen, writing, refused)}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-number={row.number}
    >
      <i className={`tb-stripe f${row.featureSlot ?? 0}`} />
      <div className="tb-top">
        <span className="tb-id">#{row.number}</span>
        {row.issueType !== null && <Tag tone={issueTypeTone(row.issueType)}>{row.issueType}</Tag>}
        {reason.tone === 'held' && <i className="tickets-lamp" />}
        <WatchDot
          number={row.number}
          watched={watched}
          off={off}
          watchLabel={watchLabel}
          also={also}
          onToggle={() => actions.setIssueWatched(row.number, !watched)}
        />
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
      <TicketMeta row={row} age={age} />
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

function cardClass(frozen: boolean, writing: string | null, refused: string | null): string {
  return `tb-card${frozen ? ' frozen' : ''}${writing !== null ? ' writing' : ''}${refused !== null ? ' refused' : ''}`;
}

function WatchDot({
  number,
  watched,
  off,
  watchLabel,
  also,
  onToggle,
}: {
  number: number;
  watched: boolean;
  off: string | null;
  watchLabel: string;
  also: string;
  onToggle: () => Promise<void>;
}): JSX.Element {
  return (
    <AsyncButton
      className={`tb-dot${watched ? ' on' : ''}`}
      disabled={off !== null}
      onClick={onToggle}
      title={
        off ??
        (watched
          ? `Take "${watchLabel}" off #${number}${also}, so the harness leaves it alone`
          : `Tag #${number}${also} "${watchLabel}" so the harness picks it up`)
      }
    >
      <span aria-hidden="true" />
    </AsyncButton>
  );
}

function TicketMeta({ row, age }: { row: TicketRow; age: string }): JSX.Element {
  return (
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
  );
}
