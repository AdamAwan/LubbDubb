import { useEffect, useState } from 'react';
import type { FilingTargetProbe, IssueFiled } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ExtLink } from './util.js';
import { Modal } from './Modal.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function composeGate(target: FilingTargetProbe | null): 'checking' | 'ready' | 'unavailable' {
  if (target === null) return 'checking';
  return target.available ? 'ready' : 'unavailable';
}

export function canFile(gate: ReturnType<typeof composeGate>, title: string, body: string): boolean {
  return gate === 'ready' && title.trim().length > 0 && body.trim().length > 0;
}

export function RaiseIssueModal({
  probe,
  fallbackUrl,
  onSubmit,
  onClose,
}: {
  probe: () => Promise<FilingTargetProbe>;
  fallbackUrl: string;
  onSubmit: (title: string, body: string, watch: boolean) => Promise<IssueFiled>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<FilingTargetProbe | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [watch, setWatch] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [filed, setFiled] = useState<IssueFiled | null>(null);

  useEffect(() => {
    let live = true;
    void probe().then(
      (answer) => {
        if (live) setTarget(answer);
      },
      (err: Error) => {
        if (live) setTarget({ available: false, target: null, identity: null, reason: err.message });
      },
    );
    return () => {
      live = false;
    };
  }, [probe]);

  const gate = composeGate(target);
  const ready = gate === 'ready';
  const canSubmit = canFile(gate, title, body);

  async function submit() {
    if (!canSubmit) return;
    setFailed(null);
    try {
      setFiled(await onSubmit(title.trim(), body.trim(), watch));
    } catch (err) {
      setFailed((err as Error).message);
      throw err;
    }
  }

  return (
    <Modal
      face="modal"
      title="Raise an issue"
      chips={
        <>
          {/* The destination, stated in the head rather than the body, because it is
              the thing to have read before typing and not after. */}
          {gate === 'checking' && <Tag>checking where this would go…</Tag>}
          {target?.available === true && (
            <Tag title="Where this issue will be created, and the identity filing it">
              {target.target}
              {target.identity !== null && ` as ${target.identity}`}
            </Tag>
          )}
          {gate === 'unavailable' && <Tag tone="red">cannot file from here</Tag>}
        </>
      }
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <Button ghost onClick={onClose}>
            {filed === null ? 'cancel' : 'close'}
          </Button>
          {filed === null && (
            <AsyncButton tone="primary" disabled={!canSubmit} onClick={submit}>
              raise issue
            </AsyncButton>
          )}
        </>
      }
    >
      {filed !== null ? (
        <p className="ri-done">
          {/* An `ExtLink` and never a `<Ref>`: `issue:<n>` resolves against the
                tracker the fleet is pointed at, which is the one place this did not
                go. The route hands back the address for that reason. */}
          Filed <ExtLink href={filed.url}>#{filed.number}</ExtLink> on LubbDubb’s own tracker.
        </p>
      ) : (
        <>
          {target?.available === false ? (
            <p className="rb-intro">
              {target.reason}. Nothing is lost — LubbDubb’s own new-issue form is still one click away, and it needs
              nothing from this harness.{' '}
              <ExtLink href={fallbackUrl} title="Raise an issue on the LubbDubb repo">
                Raise it there instead
              </ExtLink>
            </p>
          ) : (
            <p className="rb-intro">
              Creates the issue on LubbDubb’s own tracker directly — this is where a fault in the cockpit goes, whatever
              repo the fleet is pointed at. No agent writes it up.
            </p>
          )}

          <label className="rb-label" htmlFor="ri-title">
            Title
          </label>
          <input
            id="ri-title"
            className="pm-note"
            autoFocus
            disabled={!ready}
            value={title}
            placeholder="The Tickets tab’s triage count disagrees with the rows under it"
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="rb-label" htmlFor="ri-body">
            What should happen
          </label>
          <textarea
            id="ri-body"
            className="rb-text"
            rows={7}
            disabled={!ready}
            value={body}
            placeholder="The badge counts every unwatched issue; the list under it only draws the ones with a plan."
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {/* Opt-in, and off by default. The watch label is what makes the fleet
                pick an issue up, so a checked box here would mean agents are working
                a thought before its author has finished reading it back.
                Drawn only where this fleet works LubbDubb's own repo: anywhere else
                the report lands in a tracker these agents never sweep, so the box
                would be a promise nothing keeps (issue #449). */}
          {target?.available === true && target.watchable && (
            <label className="ri-watch">
              <input type="checkbox" disabled={!ready} checked={watch} onChange={(e) => setWatch(e.target.checked)} />
              Let the fleet pick this up — otherwise it sits in the tracker until you watch it
            </label>
          )}
          {failed !== null && (
            <p className="launch-error" role="alert">
              That didn’t go through: {failed}. Your text is still here — try again.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
