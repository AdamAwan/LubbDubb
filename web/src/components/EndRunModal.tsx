import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';

/**
 * Where the operator says what they are doing about the checks nobody ran, on the
 * way to ending the harness's run at a goal.
 *
 * A modal for {@link GateReleaseModal}'s reason, and it draws for its condition:
 * `POST /api/issues/:number/dismiss-run` refuses without a note while the goal's
 * validation plan is flagged ([20](../../../docs/spec/20-validation.md#where-it-lands)),
 * so a header button that posts none is a control that cannot work — which is how
 * it read, since the refusal went to an unhandled rejection and the operator saw a
 * click that did nothing. The note is not a confirmation step: the run ends either
 * way, and this is the account of what was decided about the outstanding checks.
 *
 * **It draws only on a flagged goal.** Ending a run at a goal whose plan is clear
 * (or that declared no checks) costs nothing to say and is left one click, exactly
 * as the route leaves it — a confirmation nobody's rule asked for is the friction
 * that gets the real one ignored.
 *
 * A failed post keeps the modal open with the text intact, and says what the
 * server said rather than that something went wrong.
 */
export function EndRunModal({
  issueNumber,
  issueTitle,
  outstanding,
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
  /** What the plan still owes, in the header chip's words — the server's fold, not a second count. */
  outstanding: string;
  onSubmit: (note: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  // Not caught here: the rejection is what makes the button flash its error ring
  // and hand the route's words to `onRefused`, and the modal stays open with the
  // text intact because `onClose` is only reached on the arm that settled.
  async function submit() {
    if (note.trim().length === 0) return;
    setRefusal(null);
    await onSubmit(note.trim());
    onClose();
  }

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          <span className="chip small">#{issueNumber}</span>
          <span className="pm-title">End the run</span>
          <button className="btn ghost pm-close" onClick={onClose}>
            close
          </button>
        </div>
        <p className="rb-intro">
          On “{issueTitle}”. This ends the harness’s run at the goal — one way, and terminal for the dispatcher, though
          the report stays readable. {outstanding} Nothing here stops you: what it costs is a sentence, kept on the run,
          so what the goal owed and what you decided about it survive together.
        </p>
        <label className="rb-label" htmlFor="end-run-note">
          What about the outstanding checks?
        </label>
        <textarea
          id="end-run-note"
          className="rb-text"
          rows={3}
          autoFocus
          value={note}
          placeholder="Shipping it — B and C run on Monday’s regression pass, and A is covered by the smoke test."
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits, matching the composer and the other modals.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {refusal !== null && (
          <p className="launch-error" role="alert">
            {refusal}
          </p>
        )}
        <div className="pm-foot">
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            cancel
          </button>
          <AsyncButton className="primary" disabled={note.trim().length === 0} onRefused={setRefusal} onClick={submit}>
            end the run
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}
