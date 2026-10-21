import type { JSX } from 'react';
import { api } from '../api.js';
import { type ErrorRow, type ErrorTracker, type TrackerPress, trackerPresses } from '../view/appErrors.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

const TRACKER_TONE: Record<ErrorTracker['status'], TagTone> = {
  none: 'grey',
  open: 'amber',
  closed: 'green',
  unknown: 'amber',
};

const TRACKER_SAID: Record<ErrorTracker['status'], string> = {
  none: 'no ticket',
  open: 'open',
  closed: 'closed',
  unknown: "search failed — not 'no bug'",
};

export function TrackerCell({ row, onPressed }: { row: ErrorRow; onPressed: () => void }): JSX.Element {
  const { tracker } = row;
  if (tracker === null) return <span className="ae-none">—</span>;
  const presses = trackerPresses(tracker, row.link);
  return (
    <div className="ae-link">
      {tracker.status === 'open' ? (
        <span className="ae-filed">Filed:</span>
      ) : (
        <Tag tone={TRACKER_TONE[tracker.status]} lower>
          {TRACKER_SAID[tracker.status]}
        </Tag>
      )}
      {tracker.ticketRef !== null && (
        <span className="cn-refs">
          <Ref to={tracker.ticketRef} />
        </span>
      )}
      {tracker.note !== null && <span className="ae-note">{tracker.note}</span>}
      {presses.length > 0 && (
        <span className="ae-acts">
          {presses.map((press) => (
            <TrackerButton key={press} press={press} row={row} onPressed={onPressed} />
          ))}
        </span>
      )}
    </div>
  );
}

const PRESS_LABEL: Record<TrackerPress, string> = {
  file: 'File bug',
  investigate: 'Investigate',
  reopen: 'Reopen',
  'file-new': 'File new',
  'file-anyway': 'File bug anyway',
  search: 'Retry search',
};

function TrackerButton({
  press,
  row,
  onPressed,
}: {
  press: TrackerPress;
  row: ErrorRow;
  onPressed: () => void;
}): JSX.Element {
  const act = async (): Promise<void> => {
    if (press === 'reopen') await api.reopenAppErrorTicket(row.key);
    else if (press === 'search') await api.searchAppErrorKey(row.key);
    else
      await api.fileAppErrorBug(row.environment, row.fingerprint, {
        investigate: press === 'investigate',
        unsearched: press === 'file-anyway',
      });
    onPressed();
  };
  return (
    <AsyncButton usage={PRESS_USAGE[press]} tone={press === 'file' ? 'primary' : undefined} size="small" onClick={act}>
      {PRESS_LABEL[press]}
    </AsyncButton>
  );
}

const PRESS_USAGE = {
  file: 'app-error.create',
  investigate: 'app-error.send',
  reopen: 'app-error.undo',
  'file-new': 'app-error.create',
  'file-anyway': 'app-error.create',
  search: 'app-error.refresh',
} as const satisfies Record<TrackerPress, string>;
