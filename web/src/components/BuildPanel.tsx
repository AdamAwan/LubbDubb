import type { BuildReading, UpgradeAction } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { relTime } from './util.js';
import { HeadRow } from './panel.js';
import { logUsage } from '../cockpit/usage.js';
// The headline is the rail row's sentence too — one wording for one fact, said on
// the surface that asks and on the surface that explains.
import { upgradeHeadline } from '../view/updateAsks.js';

/**
 * What the running build is, what is waiting for it, and how to take it.
 *
 * **The panel's job is to make the choice, not the update.** Nothing here pulls
 * anything: an upgrade is applied by the supervisor between two dead processes, and
 * every control on this screen either records an intent or takes a reading. What it
 * therefore owes the operator is the two facts that decide which control to press —
 * what changed upstream, and what the fleet is doing right now — and it puts them
 * next to each other for exactly that reason.
 *
 * **Draining is the recommended path and is drawn first.** Applying with agents
 * live is not lossy — they are interrupted resumably and restored on the way back
 * up without anyone being asked — but it is still a thing done to work in flight,
 * so it sits behind the second button and says what it will do.
 */
export function BuildPanel({
  build,
  now,
  onUpgrade,
  onCheck,
}: {
  build: BuildReading;
  now: number;
  onUpgrade: (action: UpgradeAction, opts?: { interrupt?: boolean }) => Promise<unknown> | unknown;
  onCheck: () => Promise<unknown> | unknown;
}) {
  const { standing } = build;
  return (
    <div className="build-panel">
      <header className="build-head">
        <div>
          <h3>{upgradeHeadline(build)}</h3>
          <p className="build-meta">
            {standing.head ? (
              <>
                running <code>{standing.head.slice(0, 7)}</code>
                {standing.branch ? ` on ${standing.branch}` : ' (detached)'} ·{' '}
              </>
            ) : null}
            checked {relTime(standing.checkedAt, now)}
          </p>
        </div>
        <AsyncButton ghost onClick={() => onCheck()}>
          Check now
        </AsyncButton>
      </header>

      {/* The reason, whenever there is one. It covers both "nothing to take" and
          every refusal, so an operator never reads a screen with no controls and no
          account of why. */}
      {build.blocked && <p className="build-blocked">{build.blocked}</p>}

      {standing.commits.length > 0 && (
        <ol className="build-commits">
          {standing.commits.map((c) => (
            <li key={c.sha}>
              <code>{c.sha}</code>
              <span>{c.subject}</span>
            </li>
          ))}
          {/* The list is capped, and a cap that does not say so reads as the whole
              history — which would make a long-neglected deployment look current. */}
          {standing.behind > standing.commits.length && (
            <li className="build-more">…and {standing.behind - standing.commits.length} more</li>
          )}
        </ol>
      )}

      {build.upgradable && <Controls build={build} onUpgrade={onUpgrade} />}
    </div>
  );
}

/**
 * The controls, which depend on where the upgrade already is.
 *
 * An unsupervised deployment gets the commands instead of the buttons: the app
 * exits on Apply and nothing would start it again, and a button that stops the
 * fleet permanently is worse than no button. It is not hidden silently — the line
 * above it says what to run to get the button.
 */
function Controls({
  build,
  onUpgrade,
}: {
  build: BuildReading;
  onUpgrade: (action: UpgradeAction, opts?: { interrupt?: boolean }) => Promise<unknown> | unknown;
}) {
  const { intent, live, supervised } = build;

  if (!supervised)
    return (
      <div className="build-manual">
        <p>
          This server was started without a supervisor, so it cannot restart itself. Stop it and run these, or start it
          with <code>npm run serve</code> next time to upgrade from here.
        </p>
        <pre>git pull &amp;&amp; npm ci</pre>
      </div>
    );

  if (intent.state === 'applying') return null;

  if (intent.state === 'draining' || intent.state === 'ready')
    return (
      <HeadRow className="build-controls">
        {intent.state === 'ready' ? (
          <AsyncButton tone="primary" onClick={() => onUpgrade('apply')}>
            Upgrade now
          </AsyncButton>
        ) : (
          <AsyncButton onClick={() => onUpgrade('apply', { interrupt: true })}>
            Don&apos;t wait — interrupt {live} and upgrade
          </AsyncButton>
        )}
        <AsyncButton
          ghost
          onClick={() => {
            // Declining puts the intent back to idle, which is the state it was
            // in before — so nothing durable distinguishes a declined upgrade
            // from one nobody was ever offered.
            logUsage('upgrade.reject');
            return onUpgrade('cancel');
          }}
        >
          Cancel
        </AsyncButton>
        <p className="build-note">
          {intent.state === 'ready'
            ? 'Dispatch is paused. The server exits, the supervisor pulls and reinstalls, and it comes back.'
            : 'Dispatch is paused; running agents are being left to finish. Interrupting them instead is safe — they ' +
              'are resumed automatically on the way back up.'}
        </p>
      </HeadRow>
    );

  return (
    <HeadRow className="build-controls">
      <AsyncButton tone="primary" onClick={() => onUpgrade('drain')}>
        {live > 0 ? `Drain and upgrade (${live} running)` : 'Upgrade'}
      </AsyncButton>
      {live > 0 && <AsyncButton onClick={() => onUpgrade('apply', { interrupt: true })}>Upgrade now</AsyncButton>}
      <p className="build-note">
        {live > 0
          ? 'Draining pauses dispatch and waits for the fleet to finish; nothing is interrupted. Upgrading now stops ' +
            'the running agents and restores them on the way back up.'
          : 'Nothing is running, so this pauses dispatch, exits, takes the update and comes back.'}
      </p>
    </HeadRow>
  );
}
