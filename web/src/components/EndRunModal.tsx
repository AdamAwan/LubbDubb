import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

/**
 * The confirmation ending a run asks for — what it is about to destroy, and, on a
 * flagged goal, what the operator is doing about the checks nobody ran.
 *
 * **It draws on every goal now, and the reason is what the button became.** Ending
 * a run used to be a card being cleared away: it stopped the dispatcher, which is
 * a statement about what will be *started*, and left everything already in flight
 * alone. It no longer does — `POST /api/issues/:number/dismiss-run` kills the
 * goal's live agents, cancels its queued jobs and settles its standing
 * instructions, because a goal going on producing commits under a run the cockpit
 * has drawn as over is the gap that made the control a lie. That is destruction an
 * operator cannot undo and cannot see coming from a one-click toggle, so the click
 * now says what it costs first and the button that opens it is red.
 *
 * The counts are stated rather than summarised: "kills 2 agents" is a sentence an
 * operator can check against the header they are looking at, and "stops any work
 * in flight" is one they cannot.
 *
 * The note is a second requirement layered on the first, not the reason the modal
 * exists. `POST /api/issues/:number/dismiss-run` refuses without one while the
 * goal's validation plan is flagged
 * ([20](../../../docs/spec/20-validation.md#where-it-lands)), so on that goal the
 * box is required and the confirm stays disabled until it is filled; on every other
 * goal it is offered and optional, since an operator with a reason should not have
 * to have a flagged plan to record it.
 *
 * A failed post keeps the modal open with the text intact, and says what the
 * server said rather than that something went wrong.
 */
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
  /**
   * What the plan still owes, in the header chip's words — the server's fold, not a
   * second count — or null on a goal whose plan is clear or that declared no checks.
   * Non-null is also what makes the note required, mirroring the route's condition.
   */
  outstanding: string | null;
  /** Live agents on this goal's own subtree, which ending the run kills. */
  agents: number;
  /**
   * Live agents on this goal's *pull requests*, which it does not kill —
   * `clearGoalWork` sweeps the `issue:<n>` subtree and a `pr:` dispatch is not in
   * it ([16](../../../docs/spec/16-http-api.md#post-apiissuesnumberdismiss-run)).
   * Stated because the page counts them as the goal's agents: an operator reading
   * "3 agents" above and "1 killed" here needs the difference said, not inferred.
   */
  prAgents: number;
  /** Standing instructions on this goal, which ending the run settles unread. */
  instructions: number;
  onSubmit: (note: string | undefined) => Promise<unknown>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const required = outstanding !== null;
  const trimmed = note.trim();

  // Not caught here: the rejection is what makes the button flash its error ring
  // and hand the route's words to `onRefused`, and the modal stays open with the
  // text intact because `onClose` is only reached on the arm that settled.
  async function submit() {
    if (required && trimmed.length === 0) return;
    setRefusal(null);
    // Absent rather than empty on the arm with nothing to say: the route reads
    // absence, and `''` would be that absence spelled a second way.
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
    </Modal>
  );
}

/** "1 running agent", "2 running agents" — the count and its noun, agreeing. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
