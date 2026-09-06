import { useEffect, useState } from 'react';
import type { HumanTask } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Button, withShape } from './button.js';
import type { ButtonLook } from './button.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

const CONFIRM_LABEL: Record<'done' | 'declined' | 'close', string> = {
  done: 'Confirm done',
  declined: 'Confirm decline',
  close: 'Confirm close',
};

const CONFIRM_TITLE: Record<'done' | 'declined' | 'close', string> = {
  done: 'Settle this, with what you said',
  declined: 'Record that this will not be done',
  close: 'Close the item in the tracker, with what you said on the row',
};

export function HumanTaskActions({
  task,
  look = { ghost: true },
  noteOnDone = null,
  onDone,
  onDecline,
  onCloseTicket = null,
}: {
  task: HumanTask;
  look?: ButtonLook;
  noteOnDone?: string | null;
  onDone: (id: string, note?: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
  onCloseTicket?: ((id: string, note?: string) => Promise<unknown> | unknown) | null;
}) {
  useEffect(() => {
    logUsage('human-task.view');
  }, []);
  const [note, setNote] = useState('');
  const [saying, setSaying] = useState<'done' | 'declined' | 'close' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const open = (verb: 'done' | 'declined' | 'close') => {
    setRefusal(null);
    setSaying((current) => (current === verb ? null : verb));
  };

  return (
    <>
      <span className="human-task-actions">
        {/* The act, ahead of the two records of it. A close-out row asks for one
            thing, and this is it — so it leads, and the note rule it may owe is
            the same one Done owes, asked in the same box. */}
        {onCloseTicket !== null &&
          (noteOnDone === null ? (
            <AsyncButton
              {...withShape(look, 'go')}
              onClick={() => {
                setRefusal(null);
                return onCloseTicket(task.id);
              }}
              onRefused={setRefusal}
              title="Close the item in the tracker and settle this row with it"
            >
              Close the ticket
            </AsyncButton>
          ) : (
            <Button
              {...withShape(look, 'go')}
              onClick={() => open('close')}
              title="Close the item in the tracker — and say what you are doing about what is outstanding"
            >
              Close the ticket…
            </Button>
          ))}
        {noteOnDone === null ? (
          <AsyncButton
            {...withShape(look, onCloseTicket === null && 'go')}
            onClick={() => {
              setRefusal(null);
              return onDone(task.id);
            }}
            onRefused={setRefusal}
            title="You did it — release anything waiting on it"
          >
            Done
          </AsyncButton>
        ) : (
          <Button
            {...withShape(look, onCloseTicket === null && 'go')}
            onClick={() => open('done')}
            title="You did it — and this one asks what you are doing about what is outstanding"
          >
            Done…
          </Button>
        )}
        <Button {...look} onClick={() => open('declined')} title="You will not be doing this">
          Decline
        </Button>
      </span>
      {saying !== null && (
        <div className="human-task-decline">
          {/* The reason, in front of the box that answers it. Drawn from what the
              station passed rather than from the 400, so it is there before the
              click rather than after the one that failed. */}
          {saying !== 'declined' && noteOnDone !== null && <p className="human-task-owed">{noteOnDone}</p>}
          <textarea
            className="human-task-note"
            rows={2}
            value={note}
            placeholder={
              saying === 'declined'
                ? 'Why not? A replan is given this verbatim.'
                : 'What are you doing about them? This goes on the row.'
            }
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <AsyncButton
            {...withShape(look, saying === 'declined' ? 'no' : 'go')}
            disabled={note.trim().length === 0}
            onRefused={setRefusal}
            onClick={async () => {
              setRefusal(null);
              if (saying === 'close') await onCloseTicket?.(task.id, note.trim());
              else if (saying === 'done') await onDone(task.id, note.trim());
              else await onDecline(task.id, note.trim());
              setSaying(null);
              setNote('');
            }}
            title={CONFIRM_TITLE[saying]}
          >
            {CONFIRM_LABEL[saying]}
          </AsyncButton>
        </div>
      )}
      {/* Whatever the route said, verbatim. The station's own rules are mirrored
          above so this is rarely reached — but a rule the browser cannot see
          (another cockpit settled the row, an amendment flagged the plan between
          the draw and the click) refuses here, and a refusal nobody can read is
          the failure this whole control had. */}
      {refusal !== null && (
        <p className="launch-error human-task-refusal" role="alert">
          {refusal}
        </p>
      )}
    </>
  );
}
