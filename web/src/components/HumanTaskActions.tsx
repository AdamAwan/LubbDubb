import { useState } from 'react';
import type { HumanTask } from '../types.js';
import { AsyncButton } from './AsyncButton.js';

/**
 * The two ways a human task settles, and the one refusal rule between them.
 *
 * Shared rather than redrawn at each station, and for the reason `EscalationCard`
 * is: this is the piece with an async flow and a rule that can refuse, so it has
 * exactly one implementation and the station embeds it. What the station owns is
 * its own chrome, and what it passes is `buttonClass`, the same seam
 * `ConfirmButton` already takes so a `.fx-btn` and a `.btn ghost` are one
 * component wearing two faces.
 *
 * **Done** settles it, and where the task backs a plan step it concludes that
 * part, releasing every sibling that named it. **Decline** takes a note the
 * button is *disabled* on rather than a 400 after the fact — the route requires
 * it, and posting first to report the same rule back would be that rule stated
 * twice, in the wrong place. The note is not ceremony: a planner shown only
 * "declined" has no reason to decide differently to the way it just decided.
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
  buttonClass = 'ghost',
  noteOnDone = null,
  onDone,
  onDecline,
}: {
  task: HumanTask;
  /** The caller's button modifiers — `cn-tgl` on a goal page, `ghost` in a modal. */
  buttonClass?: string;
  /**
   * Why marking *this* row done costs a sentence, or null when it costs nothing.
   * The station resolves it, because whether the route will refuse is a fact
   * about the goal rather than about the row — see `NeedsBand`'s `noteOwedOnDone`.
   */
  noteOnDone?: string | null;
  onDone: (id: string, note?: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
}) {
  const [note, setNote] = useState('');
  /** Which verb has the note box open, or none. One box: they ask for one thing. */
  const [saying, setSaying] = useState<'done' | 'declined' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const open = (verb: 'done' | 'declined') => {
    setRefusal(null);
    setSaying((current) => (current === verb ? null : verb));
  };

  return (
    <>
      <span className="human-task-actions">
        {noteOnDone === null ? (
          <AsyncButton
            className={`${buttonClass} go`}
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
          <button
            type="button"
            className={`btn ${buttonClass} go`}
            onClick={() => open('done')}
            title="You did it — and this one asks what you are doing about what is outstanding"
          >
            Done…
          </button>
        )}
        <button
          type="button"
          className={`btn ${buttonClass}`}
          onClick={() => open('declined')}
          title="You will not be doing this"
        >
          Decline
        </button>
      </span>
      {saying !== null && (
        <div className="human-task-decline">
          {/* The reason, in front of the box that answers it. Drawn from what the
              station passed rather than from the 400, so it is there before the
              click rather than after the one that failed. */}
          {saying === 'done' && noteOnDone !== null && <p className="human-task-owed">{noteOnDone}</p>}
          <textarea
            className="human-task-note"
            rows={2}
            value={note}
            placeholder={
              saying === 'done'
                ? 'What are you doing about them? This goes on the row.'
                : 'Why not? A replan is given this verbatim.'
            }
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <AsyncButton
            className={`${buttonClass} ${saying === 'done' ? 'go' : 'no'}`}
            disabled={note.trim().length === 0}
            onRefused={setRefusal}
            onClick={async () => {
              setRefusal(null);
              if (saying === 'done') await onDone(task.id, note.trim());
              else await onDecline(task.id, note.trim());
              setSaying(null);
              setNote('');
            }}
            title={saying === 'done' ? 'Settle this, with what you said' : 'Record that this will not be done'}
          >
            {saying === 'done' ? 'Confirm done' : 'Confirm decline'}
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
