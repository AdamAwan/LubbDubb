import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';

/**
 * Where the operator says what they want done next on a goal.
 *
 * A modal for {@link RaiseBugModal}'s reason: this is prose the operator has to
 * compose, and every other control in that header is a verdict — one click, done.
 * It replaced a verdict, in fact. "Work left" wrote `more_work` and nothing else,
 * so the operator's actual sentence — *change the button to primary* — had
 * nowhere to go, and the next agent re-read the ticket that had already produced
 * the thing they were unhappy with.
 *
 * The placeholder is an example rather than an instruction about how to write
 * one: the whole claim of the feature is that a sentence is enough.
 *
 * A failed post keeps the modal open with the text intact — the one outcome worth
 * writing code to prevent here, since everything else they can simply do again.
 */
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
      // Rethrown so the button flashes its own error ring: swallowing it here
      // would leave the control reporting a success the message below denies.
      throw err;
    }
  }

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          <span className="chip small">#{issueNumber}</span>
          <span className="pm-title">More work</span>
          <button className="btn ghost pm-close" onClick={onClose}>
            close
          </button>
        </div>
        <p className="rb-intro">
          On “{issueTitle}”. Say what you want done — it goes in front of the next agent on this goal, word for word,
          and the goal goes back in front of the harness once no pull request is open for it. If it was already marked
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
            // ⌘/Ctrl+Enter submits, matching the composer and the bug modal.
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
        <div className="pm-foot">
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            cancel
          </button>
          <AsyncButton className="primary" disabled={text.trim().length === 0} onClick={submit}>
            send to the fleet
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}
