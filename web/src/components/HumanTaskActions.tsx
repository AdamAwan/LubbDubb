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

type PressWords = { label: string; actTitle: string; askTitle: string };

const PRESS_WORDS: Record<'close' | 'done', PressWords> = {
  close: {
    label: 'Mark as closed',
    actTitle: 'Close the item in the tracker and settle this row with it',
    askTitle: 'Close the item in the tracker — and say what you are doing about what is outstanding',
  },
  done: {
    label: 'Done',
    actTitle: 'You did it — release anything waiting on it',
    askTitle: 'You did it — and this one asks what you are doing about what is outstanding',
  },
};

type Settle = (id: string) => Promise<unknown> | unknown;

type HumanTaskActionsProps = {
  task: HumanTask;
  look?: ButtonLook;
  noteOnDone?: string | null;
  onDone: ((id: string, note?: string) => Promise<unknown> | unknown) | null;
  onDecline: ((id: string, note: string) => Promise<unknown> | unknown) | null;
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
  const act = (settle: Settle) => () => {
    setRefusal(null);
    return settle(task.id);
  };

  return (
    <>
      <Verbs
        look={look}
        asks={noteOnDone !== null}
        onClose={onCloseTicket === null ? null : act(onCloseTicket)}
        onDone={onDone === null ? null : act(onDone)}
        onDecline={onDecline !== null}
        open={open}
        onRefused={setRefusal}
        extra={extra}
      />
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
            const settle = { close: onCloseTicket, done: onDone, declined: onDecline }[saying];
            await settle?.(task.id, note.trim());
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

/** The presses, the act ahead of any record of it. Each is drawn only where the station passed it. */
function Verbs({
  look,
  asks,
  onClose,
  onDone,
  onDecline,
  open,
  onRefused,
  extra,
}: {
  look: ButtonLook;
  asks: boolean;
  onClose: (() => unknown) | null;
  onDone: (() => unknown) | null;
  onDecline: boolean;
  open: (verb: Verb) => void;
  onRefused: (message: string) => void;
  extra: ReactNode;
}) {
  return (
    <ButtonRow bar>
      {/* A close-out row asks for one thing, and this is it — so it leads, and the
          note it may owe is asked in the same box Done's is. */}
      {onClose !== null && (
        <Press
          look={expected(look)}
          asks={asks}
          words={PRESS_WORDS.close}
          onRefused={onRefused}
          onAct={onClose}
          onAsk={() => open('close')}
        />
      )}
      {onDone !== null && (
        <Press
          look={onClose === null ? expected(look) : look}
          asks={asks}
          words={PRESS_WORDS.done}
          onRefused={onRefused}
          onAct={onDone}
          onAsk={() => open('done')}
        />
      )}
      {onDecline && (
        <Button {...look} usage="human-task.expand" onClick={() => open('declined')} title="You will not be doing this">
          Decline
        </Button>
      )}
      {extra}
    </ButtonRow>
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
        usage={{ counted: saying === 'declined' ? 'human-task.reject' : 'human-task.accept' }}
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
  words: PressWords;
  onRefused: (message: string) => void;
  onAct: () => Promise<unknown> | unknown;
  onAsk: () => void;
};

function Press({ look, asks, words, onRefused, onAct, onAsk }: PressProps) {
  return !asks ? (
    <AsyncButton
      {...look}
      usage={{ counted: 'human-task.accept' }}
      onClick={onAct}
      onRefused={onRefused}
      title={words.actTitle}
    >
      {words.label}
    </AsyncButton>
  ) : (
    <Button {...look} usage="human-task.expand" onClick={onAsk} title={words.askTitle}>
      {`${words.label}…`}
    </Button>
  );
}
