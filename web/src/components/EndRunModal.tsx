import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function EndRunModal({
  issueNumber,
  issueTitle,
  outstanding,
  agents,
  prAgents,
  instructions,
  onSubmit,
  onClose,
}: {
  issueNumber: number;
  issueTitle: string;
  outstanding: string | null;
  agents: number;
  prAgents: number;
  instructions: number;
  onSubmit: (note: string | undefined) => Promise<unknown>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const required = outstanding !== null;
  const trimmed = note.trim();

  async function submit() {
    if (required && trimmed.length === 0) return;
    setRefusal(null);
    await onSubmit(trimmed.length === 0 ? undefined : trimmed);
    onClose();
  }

  return (
    <Modal
      face="modal"
      title="Abandon the run"
      lead={<Tag>#{issueNumber}</Tag>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            cancel
          </Button>
          <AsyncButton
            tone="danger"
            disabled={required && trimmed.length === 0}
            onRefused={setRefusal}
            onClick={submit}
          >
            abandon the run
          </AsyncButton>
        </>
      }
    >
      <p className="rb-intro">
        On “{issueTitle}”. This abandons the harness’s run at the goal — one way, and terminal for the dispatcher, so
        nothing is scheduled for it again, though the report stays readable.
      </p>
      <ul className="rb-costs">
        <li>
          {agents === 0 ? 'No agent is running on this goal.' : `${count(agents, 'running agent')} killed mid-turn.`}
        </li>
        {prAgents > 0 && (
          <li>
            {count(prAgents, 'agent')} on this goal’s pull requests {prAgents === 1 ? 'keeps' : 'keep'} running — end
            {prAgents === 1 ? ' it' : ' them'} from the fleet if you want {prAgents === 1 ? 'it' : 'them'} stopped too.
          </li>
        )}
        <li>Any queued job standing in for this goal’s work is cancelled.</li>
        <li>
          {instructions === 0
            ? 'Nothing you have asked for is still standing.'
            : `${count(instructions, 'standing instruction')} settled unread.`}
        </li>
      </ul>
      {outstanding !== null && <p className="rb-intro">{outstanding}</p>}
      <label className="rb-label" htmlFor="end-run-note">
        {required ? 'What about the outstanding checks?' : 'Why, for the record? (optional)'}
      </label>
      <textarea
        id="end-run-note"
        className="rb-text"
        rows={3}
        autoFocus
        value={note}
        placeholder={
          required
            ? 'Shipping it — B and C run on Monday’s regression pass, and A is covered by the smoke test.'
            : 'Superseded by #512; nothing here is worth finishing.'
        }
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
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
    </Modal>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
