import { useState, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { EjectionOutcome, EjectionView } from '../types.js';
import { ejectPrompt } from '../cockpit/desktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { DesktopLink } from './DesktopLink.js';
import { Modal } from './Modal.js';
import { Tag } from './tag.js';

// → docs/spec/35-ejection.md

const ARMS: { outcome: Exclude<EjectionOutcome, 'expired'>; label: string; saying: string; does: string }[] = [
  {
    outcome: 'handed_back',
    label: 'Hand it back',
    saying: 'Never mind — the agent was right.',
    does: 'The rule that produced this work proposes it again on the next pulse, reading the branch as it now stands.',
  },
  {
    outcome: 'requeued',
    label: 'Requeue it',
    saying: 'I fixed the direction, you finish.',
    does:
      'A job carrying your note is queued and stands in for this work until it runs, so nothing races it. The note ' +
      'is the preamble the fresh agent reads, which is why it is required here and optional on the other two.',
  },
  {
    outcome: 'delivered',
    label: "It's a pull request",
    saying: 'The work is delivered.',
    does: 'The hold is released and the pull-request rules take the next decision.',
  },
];

export function EjectionControls({ held, actions }: { held: EjectionView; actions: CockpitActions }): JSX.Element {
  const [settling, setSettling] = useState(false);
  return (
    <>
      {held.worktreePath !== null && (
        <DesktopLink
          folder={held.worktreePath}
          prompt={ejectPrompt(issueOf(held.originRef))}
          explain="in the worktree this work is held in, so the branch and its uncommitted changes are in front of you"
        />
      )}
      <Button onClick={() => setSettling(true)}>Hand back…</Button>
      {settling && <SettleModal held={held} actions={actions} onClose={() => setSettling(false)} />}
    </>
  );
}

function SettleModal({
  held,
  actions,
  onClose,
}: {
  held: EjectionView;
  actions: CockpitActions;
  onClose: () => void;
}): JSX.Element {
  const [note, setNote] = useState('');
  return (
    <Modal
      face="modal"
      title="Give this work back"
      lead={<Tag>{held.originRef}</Tag>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            not yet
          </Button>
        </>
      }
    >
      <p className="rb-intro">
        Nothing is staffed on this and its worktree is out of the pool until you answer. Which of the three it is
        decides what happens next, and only you know — the harness cannot read a branch and tell “I fixed it, carry on”
        from “I was wrong, start again”.
      </p>
      <label className="rb-label" htmlFor="eject-note">
        What happened while you had it
      </label>
      <textarea
        id="eject-note"
        className="rb-text"
        rows={3}
        autoFocus
        value={note}
        placeholder="Reverted the store extraction and pushed; the part still needs its tests."
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="eject-arms">
        {ARMS.map((arm) => (
          <div key={arm.outcome} className="eject-arm">
            <AsyncButton
              disabled={arm.outcome === 'requeued' && note.trim() === ''}
              onClick={() =>
                actions.settleEjection(held.id, arm.outcome, note.trim() === '' ? undefined : note.trim()).then(onClose)
              }
              pendingLabel="Handing back…"
            >
              {arm.label}
            </AsyncButton>
            <span className="rb-hint">
              <b>{arm.saying}</b> {arm.does}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function EjectModal({
  agentId,
  title,
  onEject,
  onClose,
}: {
  agentId: string;
  title: string;
  onEject: (reason: string) => Promise<unknown>;
  onClose: () => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  return (
    <Modal
      face="modal"
      title="Take this off the fleet"
      lead={<Tag>{agentId}</Tag>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            cancel
          </Button>
          <AsyncButton
            tone="danger"
            disabled={reason.trim() === ''}
            pendingLabel="Ejecting…"
            onClick={() => onEject(reason.trim()).then(onClose)}
          >
            eject
          </AsyncButton>
        </>
      }
    >
      <p className="rb-intro">
        This stops “{title}” and holds its goal and its worktree for <b>you</b>: nothing else in the harness will staff
        the work or touch the directory until you hand it back. The branch and the conversation are both kept — you get
        a Claude Code session in the worktree, and the resume command for the agent’s own conversation. The hold expires
        on its own, and the harness says so when it does.
      </p>
      <label className="rb-label" htmlFor="eject-reason">
        Why are you taking it?
      </label>
      <textarea
        id="eject-reason"
        className="rb-text"
        rows={3}
        autoFocus
        value={reason}
        placeholder="It is rewriting the store instead of adding the column."
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="rb-hint">
        Required. It is the first thing the session you hand this to reads, and it is what the held slot says on the
        fleet view. Interrupting the agent and answering it costs nothing and keeps the slot — reach for that first if
        what you want is a word with it rather than the keys.
      </p>
    </Modal>
  );
}

function issueOf(originRef: string): number {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef);
  return match ? Number(match[1]) : 0;
}
