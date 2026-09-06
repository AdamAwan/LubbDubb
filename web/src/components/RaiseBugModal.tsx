import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function RaiseBugModal({
  issueNumber,
  issueTitle,
  initialSummary = '',
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
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
