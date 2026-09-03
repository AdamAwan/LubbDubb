import { useEffect, useState } from 'react';
import type { FilingTargetProbe, IssueFiled } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ExtLink } from './util.js';
import { Modal } from './Modal.js';

/**
 * Which of the three readings the modal is showing, from the one piece of state
 * that decides it.
 *
 * A named rule rather than two conditions at the call site, because `null` here is
 * a **reading and not a missing one** — the probe has not answered yet — and the
 * difference between "not yet" and "no" is the whole of what the fields being
 * disabled means. Collapsing them would have the modal invite a paragraph it cannot
 * file, which is the failure this control was built to avoid.
 */
export function composeGate(target: FilingTargetProbe | null): 'checking' | 'ready' | 'unavailable' {
  if (target === null) return 'checking';
  return target.available ? 'ready' : 'unavailable';
}

/**
 * Whether the submit may fire: a target that can be filed into, and both fields
 * with something in them.
 *
 * Both are trimmed, which is the rule the route enforces rather than a second
 * opinion about it — `RaiseIssueBody` trims and then refuses an empty string, so a
 * button live on a page of spaces would promise a 400.
 */
export function canFile(gate: ReturnType<typeof composeGate>, title: string, body: string): boolean {
  return gate === 'ready' && title.trim().length > 0 && body.trim().length > 0;
}

/**
 * Where the operator writes a report about **LubbDubb** without leaving the cockpit
 * (issues #413, #449).
 *
 * The chrome is {@link RaiseBugModal}'s — `plan-modal` for the frame, `.rb-*` for
 * the prose fields, `.launch-error` for a refusal — because this asks for the same
 * thing: a paragraph the operator has to compose. What is different is that
 * nothing is delegated. The bug modal hands its text to a desk agent, which writes
 * the ticket; here the operator has already written it, so the create is direct and
 * no model reads a word of it.
 *
 * **It goes where the link beside it goes**, and that is the whole of issue #449.
 * This control is the one thing on the top bar about the *tool* rather than about
 * the work, so it files into LubbDubb's own repository whatever tracker the fleet
 * is pointed at — a cockpit fault landing in a customer's backlog was the bug. The
 * head still names the destination and the identity before the fields are typeable,
 * because the byline is the operator's own `gh` login, and which of their accounts
 * is signed in is worth reading before typing rather than after.
 *
 * **Every arm that cannot file offers the tracker's own form instead.** A probe
 * that answers `available: false`, and a probe that could not be reached at all,
 * both land on {@link fallbackUrl} — the link this modal replaced, on the same
 * repository. The bar draws the report path when the socket is down precisely
 * because that is a moment an operator has something to report, and a modal that
 * took that away on the harness being unwell would be the failure it was built to
 * avoid.
 *
 * A failed post keeps the modal open with the text intact, which is the one outcome
 * here worth writing code to prevent — everything else they can simply do again.
 */
export function RaiseIssueModal({
  probe,
  fallbackUrl,
  onSubmit,
  onClose,
}: {
  probe: () => Promise<FilingTargetProbe>;
  /** LubbDubb's own new-issue form — where every arm that cannot file sends the operator. */
  fallbackUrl: string;
  onSubmit: (title: string, body: string, watch: boolean) => Promise<IssueFiled>;
  onClose: () => void;
}) {
  // `null` is the third reading and not a missing one: the probe has not answered
  // yet, which is what holds the fields disabled.
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
      // The route answers a logged-out CLI with a 200, so a rejection is the probe
      // itself being unreachable — a different cause and the same consequence, which
      // is why it is folded into the one unavailable reading rather than a fourth
      // state nobody could act on differently.
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
      // The server refuses in its own words — the tracker's message, or the gate
      // that turned it down — and those are the half that says what to do about it.
      setFailed((err as Error).message);
      // Rethrown so the button flashes its own error ring: swallowing it here would
      // leave the control reporting a success the message below denies.
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
          {gate === 'checking' && <span className="chip small">checking where this would go…</span>}
          {target?.available === true && (
            <span className="chip small" title="Where this issue will be created, and the identity filing it">
              {target.target}
              {target.identity !== null && ` as ${target.identity}`}
            </span>
          )}
          {gate === 'unavailable' && <span className="chip small bad">cannot file from here</span>}
        </>
      }
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            {filed === null ? 'cancel' : 'close'}
          </button>
          {filed === null && (
            <AsyncButton className="primary" disabled={!canSubmit} onClick={submit}>
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
              // ⌘/Ctrl+Enter submits, matching the bug modal and the drawer's respond box.
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
