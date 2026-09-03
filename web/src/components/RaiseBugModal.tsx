import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

/**
 * Where the operator says what is wrong.
 *
 * A modal rather than an inline field because this is the one control on the
 * story row that takes **prose the operator has to compose**: every other button
 * there is a verdict — one click, done. The text is also the whole feature. A
 * desk agent writes the bug from it, and it is the one fact about a goal that no
 * agent on it can derive, since none of them ran the thing.
 *
 * The submit is disabled until the report is non-empty, which is the rule the
 * route enforces rather than a second opinion about it: an empty report asks for
 * nothing. The title is optional and labelled as the **job's** — the agent writes
 * the bug's own title, because that is the judgement being delegated.
 *
 * A failed post keeps the modal open with the text intact. Losing what the
 * operator just typed is the one outcome worth writing code to prevent here;
 * everything else they can simply do again.
 */
export function RaiseBugModal({
  issueNumber,
  issueTitle,
  initialSummary = '',
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
  /**
   * What the box opens holding — the post-deploy watch's reading, when the modal
   * was opened from its bench row.
   *
   * A **seed, not a payload**: it lands in the same editable box, so what is filed
   * is still whatever the operator sends, and the numbers ride as their own report
   * rather than as a paraphrase somebody would have had to retype. Empty
   * everywhere else, which is the box this modal has always opened with.
   */
  initialSummary?: string;
  onSubmit: (summary: string, title?: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (summary.trim().length === 0) return;
    setFailed(false);
    try {
      await onSubmit(summary.trim(), title.trim() || undefined);
      onClose();
    } catch (err) {
      setFailed(true);
      // Rethrown so the button flashes its own error ring: swallowing it here
      // would leave the control reporting a success the message below denies.
      throw err;
    }
  }

  return (
    <Modal
      face="modal"
      title="Raise a bug"
      lead={<Tag>#{issueNumber}</Tag>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            cancel
          </Button>
          <AsyncButton tone="primary" disabled={summary.trim().length === 0} onClick={submit}>
            raise bug
          </AsyncButton>
        </>
      }
    >
      <p className="rb-intro">
        Against “{issueTitle}”. Say what you did and what happened instead. An agent writes it up as a bug in the
        tracker, linked back to this item, and checks for a duplicate first — this does not change this item’s own
        state.
      </p>
      <label className="rb-label" htmlFor="rb-summary">
        What’s wrong
      </label>
      <textarea
        id="rb-summary"
        className="rb-text"
        rows={6}
        autoFocus
        value={summary}
        placeholder="The export button still 404s on Safari — worked in the PR preview, not on main."
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter submits, matching the composer and the drawer's respond box.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <label className="rb-label" htmlFor="rb-title">
        Job title <span className="rb-hint">optional — the agent titles the bug itself</span>
      </label>
      <input id="rb-title" className="pm-note" value={title} onChange={(e) => setTitle(e.target.value)} />
      {failed && (
        <p className="launch-error" role="alert">
          That didn’t go through. Your text is still here — try again.
        </p>
      )}
    </Modal>
  );
}
