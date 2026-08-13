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
 * **Dismiss is the third control and the only one a settled row gets**, which is
 * the route's own rule: an open obligation has two answers and neither of them is
 * "hide it", so the verdicts and the clear-away are mutually exclusive here for
 * the same reason they are in the store. It says nothing about the work — only
 * that the operator has read the record — so it takes no note. A caller that
 * passes no `onDismiss` draws nothing on a settled task rather than a dead button.
 */
export function HumanTaskActions({
  task,
  buttonClass = 'ghost',
  onDone,
  onDecline,
  onDismiss,
}: {
  task: HumanTask;
  /** The caller's button modifiers — `cn-tgl` on a goal page, `ghost` in a modal. */
  buttonClass?: string;
  onDone: (id: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
  /** Clear a **settled** row off the bench. Absent on a surface that draws only open tasks. */
  onDismiss?: (id: string) => Promise<unknown> | unknown;
}) {
  const [note, setNote] = useState('');
  const [declining, setDeclining] = useState(false);
  if (task.status !== 'open') {
    if (!onDismiss) return null;
    return (
      <AsyncButton
        className={buttonClass}
        onClick={() => onDismiss(task.id)}
        title="You have read this — clear it off the bench. It settles nothing and reopens nothing."
      >
        Dismiss
      </AsyncButton>
    );
  }
  return (
    <>
      <span className="human-task-actions">
        <AsyncButton
          className={`${buttonClass} go`}
          onClick={() => onDone(task.id)}
          title="You did it — release anything waiting on it"
        >
          Done
        </AsyncButton>
        <button
          type="button"
          className={`btn ${buttonClass}`}
          onClick={() => setDeclining((d) => !d)}
          title="You will not be doing this"
        >
          Decline
        </button>
      </span>
      {declining && (
        <div className="human-task-decline">
          <textarea
            className="human-task-note"
            rows={2}
            value={note}
            placeholder="Why not? A replan is given this verbatim."
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <AsyncButton
            className={`${buttonClass} no`}
            disabled={note.trim().length === 0}
            onClick={async () => {
              await onDecline(task.id, note.trim());
              setDeclining(false);
              setNote('');
            }}
            title="Record that this will not be done"
          >
            Confirm decline
          </AsyncButton>
        </div>
      )}
    </>
  );
}
