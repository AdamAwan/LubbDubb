import { useState } from 'react';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { Modal } from './Modal.js';
import { Ref } from './refs.js';
import type { LocalRunView } from '../types.js';

// → docs/spec/17-cockpit.md

export function ValidateLocallyModal({
  mode,
  issueNumber,
  issueTitle,
  targetRef,
  run,
  runTitle,
  onSubmit,
  onClose,
}: {
  mode: 'swap' | 'refresh';
  issueNumber: number;
  issueTitle: string;
  targetRef: string | null;
  run: LocalRunView;
  runTitle: string | null;
  onSubmit: (opts: { swap?: boolean; refresh?: boolean }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = async (opts: { swap?: boolean; refresh?: boolean }) => {
    setRefusal(null);
    await onSubmit(opts);
    onClose();
  };
  const behind = run.freshness?.behindTip ?? 0;

  return (
    <Modal
      face="modal"
      title={mode === 'swap' ? 'Something else is running' : 'The environment is behind'}
      lead={<span className="chip small">#{issueNumber}</span>}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            cancel
          </Button>
          {/* The refresh arm's middle answer is a real choice rather than a soft
              cancel — validating what is up now is often what somebody means — so
              it is a button of its own rather than a second meaning on Cancel. */}
          {mode === 'refresh' && (
            <AsyncButton onRefused={setRefusal} onClick={() => submit({})}>
              validate what is running
            </AsyncButton>
          )}
          <AsyncButton
            tone="primary"
            onRefused={setRefusal}
            onClick={() => submit(mode === 'swap' ? { swap: true } : { refresh: true })}
          >
            {mode === 'swap' ? `stop it and validate #${String(issueNumber)}` : 'refresh to the tip and validate'}
          </AsyncButton>
        </>
      }
    >
      {mode === 'swap' ? (
        <>
          <p className="rb-intro">
            {/* The ref sits *in the sentence*, never inside a button: one click may
                  not have two destinations, and this modal's clicks are the two below. */}
            The dev environment is running <Ref to={run.originRef} />
            {runTitle === null ? '' : ` — “${runTitle}”`} on <code>{run.ref}</code> ({run.status}).
          </p>
          <ul className="rb-costs">
            <li>It is stopped first, which takes as long as this project takes to shut down.</li>
            <li>
              “{issueTitle}” comes up in its place
              {targetRef === null ? '' : ' on '}
              {targetRef === null ? '' : <code>{targetRef}</code>}.
            </li>
            <li>
              Then one agent writes a test plan, drives the running application through it, and reports on this goal’s
              page.
            </li>
          </ul>
        </>
      ) : (
        <>
          <p className="rb-intro">
            The environment is running this goal on <code>{run.ref}</code>, {behind} commit
            {behind === 1 ? '' : 's'} behind the tip of that branch — an agent has pushed since it came up.
          </p>
          <ul className="rb-costs">
            <li>Refreshing moves the checkout to the tip and tells the session what changed.</li>
            <li>It is a hard reset under a running server, so anything uncommitted in that checkout goes.</li>
            <li>
              Validating what is running is the other answer, and it is a real one — that is the code you have been
              looking at.
            </li>
          </ul>
        </>
      )}
      {refusal !== null && (
        <p className="launch-error" role="alert">
          {refusal}
        </p>
      )}
    </Modal>
  );
}
