import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function GateReleaseModal({
  issueNumber,
  issueTitle,
  hold,
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
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
      throw err;
    }
  }

  return (
    <Modal
      face="modal"
      title="Not waiting on an environment"
      lead={<Tag>#{issueNumber}</Tag>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            cancel
          </Button>
          <AsyncButton tone="primary" disabled={note.trim().length === 0} onClick={submit}>
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
