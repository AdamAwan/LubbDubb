import { useEffect, useState } from 'react';
import type { HumanTask } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Button, withShape } from './button.js';
import type { ButtonLook } from './button.js';
import { logUsage } from '../cockpit/usage.js';

/** What the one confirm button says, per verb — three arms, one box. */
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

/**
 * The two ways a human task settles, and the one refusal rule between them.
 *
 * Shared rather than redrawn at each station, and for the reason `EscalationCard`
 * is: this is the piece with an async flow and a rule that can refuse, so it has
 * exactly one implementation and the station embeds it. What the station owns is
 * its own chrome, and what it passes is `look` — [`Button`](./button.tsx)'s own
 * props, so a console-family row and a modal's ghost row are one component
 * wearing two faces. It used to pass a *class string*, and the two halves of one
 * — the caller's tone and this station's own `go`/`no` — were interpolated at six
 * sites, three of which prefixed `btn` and three of which did not.
 *
 * **Done** settles it, and where the task backs a plan step it concludes that
 * part, releasing every sibling that named it. **Decline** takes a note the
 * button is *disabled* on rather than a 400 after the fact — the route requires
 * it, and posting first to report the same rule back would be that rule stated
 * twice, in the wrong place. The note is not ceremony: a planner shown only
 * "declined" has no reason to decide differently to the way it just decided.
 *
 * **Close the ticket** is the third verb, and only a `close_out` row ever offers
 * it: the obligation that row states is a close in the tracker, so the button
 * that does it belongs beside the ones that record it. It is the *primary* verb
 * there for that reason — Done is what an operator presses having already closed
 * the item somewhere else, and the row settles itself on the next pulse either
 * way. The station passes it or does not (`config.canCloseIssue` on a deployment
 * whose tracker cannot be written), and where it is absent the row reads exactly
 * as it always did.
 *
 * **Done takes a note too, on the one row that owes one.** Closing a goal out
 * while its validation plan is not clear is refused by the route without a
 * sentence ([20](../../../docs/spec/20-validation.md#where-it-lands)) — and until
 * this had somewhere to type one, that refusal reached the operator as a button
 * that did nothing: the post carried no note, could not carry one, and the 400
 * came back to a `catch` that dropped it. `noteOnDone` is the same discipline as
 * Decline's, asked at the same moment and for the same reason: the flag costs a
 * sentence, so there has to be a place to say it.
 */
export function HumanTaskActions({
  task,
  look = { ghost: true },
  noteOnDone = null,
  onDone,
  onDecline,
  onCloseTicket = null,
}: {
  task: HumanTask;
  /** The caller's tone — the console family on a goal page, ghost in a modal. */
  look?: ButtonLook;
  /**
   * Why marking *this* row done costs a sentence, or null when it costs nothing.
   * The station resolves it, because whether the route will refuse is a fact
   * about the goal rather than about the row — see `NeedsBand`'s `noteOwedOnDone`.
   */
  noteOnDone?: string | null;
  onDone: (id: string, note?: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
  /**
   * Close the tracker item this row names, or null where there is none to close —
   * an ordinary ask, or a deployment whose tracker the harness cannot write. It
   * takes the same optional note `onDone` does, because the rule that costs a
   * sentence is about the goal rather than about which verb settles it.
   */
  onCloseTicket?: ((id: string, note?: string) => Promise<unknown> | unknown) | null;
}) {
  // The ask was reached. These actions are drawn wherever a bench row is put to a
  // person — the rail, the goal page, the panel fallback — and this is the one
  // component all three go through, so it is the only place the `view` counts
  // whichever surface the row was shown on.
  useEffect(() => {
    logUsage('human-task.view');
  }, []);
  const [note, setNote] = useState('');
  /** Which verb has the note box open, or none. One box: they ask for one thing. */
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
            // Secondary where the close is on offer: two `go` buttons side by side
            // would put the record of the act and the act itself on one footing.
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
