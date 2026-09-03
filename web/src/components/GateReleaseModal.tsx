import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';

/**
 * Where the operator says this goal is never going to reach an environment.
 *
 * A modal for {@link InstructionModal}'s reason: the note is prose they have to
 * compose, and every other control on the goal page is a verdict — one click,
 * done. It is not a verdict, either. Releasing a gate does not say the work is
 * good or finished; it says the evidence the harness is waiting for is never
 * arriving, which is a different claim and the one thing a reader six weeks later
 * has no other way to recover.
 *
 * That is why the note is required rather than optional, here and in
 * `GateReleaseBody`: the row it writes is the only account of why a goal was
 * closed out with no environment ever confirming it.
 *
 * A failed post keeps the modal open with the text intact.
 */
export function GateReleaseModal({
  issueNumber,
  issueTitle,
  hold,
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
  /** What is being waited on, in the server's own words — the sentence the card draws. */
  hold: string;
  onSubmit: (note: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (note.trim().length === 0) return;
    setFailed(false);
    try {
      await onSubmit(note.trim());
      onClose();
    } catch (err) {
      setFailed(true);
      // Rethrown so the button flashes its own error ring: swallowing it would
      // leave the control reporting a success the message below denies.
      throw err;
    }
  }

  return (
    <Modal
      face="modal"
      title="Not waiting on an environment"
      lead={<span className="chip small">#{issueNumber}</span>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            cancel
          </button>
          <AsyncButton className="primary" disabled={note.trim().length === 0} onClick={submit}>
            stop waiting
          </AsyncButton>
        </>
      }
    >
      <p className="rb-intro">
        On “{issueTitle}”. {hold} Releasing that says the work is not going to arrive there — a docs change, a config
        change, something whose deployment nothing here can see — so the checks and the close-out are asked for now
        instead. It changes nothing about the work itself, and you can put the goal back to waiting afterwards.
      </p>
      <label className="rb-label" htmlFor="gate-note">
        Why is it not shipping?
      </label>
      <textarea
        id="gate-note"
        className="rb-text"
        rows={3}
        autoFocus
        value={note}
        placeholder="Documentation only — nothing in this goal is deployed."
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter submits, matching the composer and the other two modals.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {failed && (
        <p className="launch-error" role="alert">
          That didn’t go through. Your note is still here — try again.
        </p>
      )}
    </Modal>
  );
}
