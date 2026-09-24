import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HumanTask } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Button, ButtonRow, expected, refusing } from './button.js';
import type { ButtonLook } from './button.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

type Verb = 'done' | 'declined' | 'close';

const CONFIRM_LABEL: Record<Verb, string> = {
  done: 'Confirm done',
  declined: 'Confirm decline',
  close: 'Confirm close',
};

const CONFIRM_TITLE: Record<Verb, string> = {
  done: 'Settle this, with what you said',
  declined: 'Record that this will not be done',
  close: 'Close the item in the tracker, with what you said on the row',
};

type HumanTaskActionsProps = {
  task: HumanTask;
  look?: ButtonLook;
  noteOnDone?: string | null;
  onDone: (id: string, note?: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
  onCloseTicket?: ((id: string, note?: string) => Promise<unknown> | unknown) | null;
  extra?: ReactNode;
};

export function HumanTaskActions({
  task,
  look = { ghost: true },
  noteOnDone = null,
  onDone,
  onDecline,
  onCloseTicket = null,
  extra = null,
}: HumanTaskActionsProps) {
  useEffect(() => {
    logUsage('human-task.view');
  }, []);
  const [note, setNote] = useState('');
  const [saying, setSaying] = useState<Verb | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const open = (verb: Verb) => {
    setRefusal(null);
    setSaying((current) => (current === verb ? null : verb));
  };

  return (
    <>
      <ButtonRow bar>
        {/* The act, ahead of the two records of it. A close-out row asks for one
            thing, and this is it — so it leads, and the note rule it may owe is
            the same one Done owes, asked in the same box. */}
        {onCloseTicket !== null && (
          <CloseTicketPress
            look={look}
            asks={noteOnDone !== null}
            onRefused={setRefusal}
            onAct={() => {
              setRefusal(null);
              return onCloseTicket(task.id);
            }}
            onAsk={() => open('close')}
          />
        )}
        <DonePress
          look={onCloseTicket === null ? expected(look) : look}
          asks={noteOnDone !== null}
          onRefused={setRefusal}
          onAct={() => {
            setRefusal(null);
            return onDone(task.id);
          }}
          onAsk={() => open('done')}
        />
        <Button {...look} onClick={() => open('declined')} title="You will not be doing this">
          Decline
        </Button>
        {extra}
      </ButtonRow>
      {saying !== null && (
        <NoteBox
          saying={saying}
          note={note}
          setNote={setNote}
          noteOnDone={noteOnDone}
          look={look}
          onRefused={setRefusal}
          onConfirm={async () => {
            setRefusal(null);
            if (saying === 'close') await onCloseTicket?.(task.id, note.trim());
            else if (saying === 'done') await onDone(task.id, note.trim());
            else await onDecline(task.id, note.trim());
            setSaying(null);
            setNote('');
          }}
        />
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

function NoteBox({
  saying,
  note,
  setNote,
  noteOnDone,
  look,
  onRefused,
  onConfirm,
}: {
  saying: Verb;
  note: string;
  setNote: (note: string) => void;
  noteOnDone: string | null;
  look: ButtonLook;
  onRefused: (message: string) => void;
  onConfirm: () => Promise<void>;
}) {
  return (
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
        {...(saying === 'declined' ? refusing(look) : expected(look))}
        disabled={note.trim().length === 0}
        onRefused={onRefused}
        onClick={onConfirm}
        title={CONFIRM_TITLE[saying]}
      >
        {CONFIRM_LABEL[saying]}
      </AsyncButton>
    </div>
  );
}

type PressProps = {
  look: ButtonLook;
  asks: boolean;
  onRefused: (message: string) => void;
  onAct: () => Promise<unknown> | unknown;
  onAsk: () => void;
};

function CloseTicketPress({ look, asks, onRefused, onAct, onAsk }: PressProps) {
  return !asks ? (
    <AsyncButton
      {...expected(look)}
      onClick={onAct}
      onRefused={onRefused}
      title="Close the item in the tracker and settle this row with it"
    >
      Mark as closed
    </AsyncButton>
  ) : (
    <Button
      {...expected(look)}
      onClick={onAsk}
      title="Close the item in the tracker — and say what you are doing about what is outstanding"
    >
      Mark as closed…
    </Button>
  );
}

function DonePress({ look, asks, onRefused, onAct, onAsk }: PressProps) {
  return !asks ? (
    <AsyncButton {...look} onClick={onAct} onRefused={onRefused} title="You did it — release anything waiting on it">
      Done
    </AsyncButton>
  ) : (
    <Button
      {...look}
      onClick={onAsk}
      title="You did it — and this one asks what you are doing about what is outstanding"
    >
      Done…
    </Button>
  );
}
