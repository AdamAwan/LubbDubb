import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function InstructionModal({
  issueNumber,
  issueTitle,
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
  onSubmit: (text: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (text.trim().length === 0) return;
    setFailed(false);
    try {
      await onSubmit(text.trim());
      onClose();
    } catch (err) {
      setFailed(true);
      throw err;
    }
  }

  return (
    <Modal
      face="modal"
      title="More work"
      lead={<Tag>#{issueNumber}</Tag>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            cancel
          </Button>
          <AsyncButton tone="primary" disabled={text.trim().length === 0} onClick={submit}>
            send to the fleet
          </AsyncButton>
        </>
      }
    >
      <p className="rb-intro">
        On “{issueTitle}”. Say what you want done — it goes in front of the next agent on this goal, word for word, and
        the goal goes back in front of the harness once no pull request is open for it. If it was already marked
        delivered that verdict is retracted, and if its plan had finished it goes back to a planner, which draws a new
        one for you to approve. The agent updates the ticket itself when what you say changes what the goal asks for.
      </p>
      <label className="rb-label" htmlFor="ins-text">
        What needs doing
      </label>
      <textarea
        id="ins-text"
        className="rb-text"
        rows={5}
        autoFocus
        value={text}
        placeholder="Change the button to primary — it reads as a cancel next to the one beside it."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {failed && (
        <p className="launch-error" role="alert">
          That didn’t go through. Your text is still here — try again.
        </p>
      )}
    </Modal>
  );
}
