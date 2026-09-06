import type { JSX } from 'react';
import type { BuildReading, UpgradeAction } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { relTime } from './util.js';
import { HeadRow } from './panel.js';
import { logUsage } from '../cockpit/usage.js';
import { upgradeHeadline } from '../view/updateAsks.js';

// → docs/spec/17-cockpit.md

export function BuildPanel({
  build,
  project,
  now,
  onUpgrade,
  onCheck,
  onPull,
}: {
  build: BuildReading;
  project: string;
  now: number;
  onUpgrade: (action: UpgradeAction, opts?: { interrupt?: boolean }) => Promise<unknown> | unknown;
  onCheck: () => Promise<unknown> | unknown;
  onPull: () => Promise<unknown> | unknown;
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

      <Project build={build} name={project} now={now} onPull={onPull} />
    </div>
  );
}

function Project({
  build,
  name,
  now,
  onPull,
}: {
  build: BuildReading;
  name: string;
  now: number;
  onPull: () => Promise<unknown> | unknown;
}): JSX.Element {
  const standing = build.project;
  const canPull = !build.projectAutoPull && build.projectPull.can;
  return (
    <section className="build-project">
      <header className="build-head">
        <div>
          <h3>{name}</h3>
          <p className="build-meta">
            {projectLine(standing, name)}
            {standing !== null && ` · checked ${relTime(standing.checkedAt, now)}`}
          </p>
        </div>
        {canPull && (
          <AsyncButton tone="primary" onClick={() => onPull()}>
            Pull
          </AsyncButton>
        )}
      </header>

      {/* Why there is no Pull, whenever there is something to take and it cannot be
          taken. The server's own sentence, quoted: it words all four refusals — a
          dirty tree, the wrong branch, a clone with commits of its own, a checkout
          it could not read — and a second wording here would be a fifth to keep in
          step. */}
      {!canPull && standing !== null && standing.behind > 0 && build.projectPull.blocked !== null && (
        <p className="build-blocked">{build.projectPull.blocked}</p>
      )}

      {standing !== null && standing.commits.length > 0 && (
        <ol className="build-commits">
          {standing.commits.map((c) => (
            <li key={c.sha}>
              <code>{c.sha}</code>
              <span>{c.subject}</span>
            </li>
          ))}
          {standing.behind > standing.commits.length && (
            <li className="build-more">…and {standing.behind - standing.commits.length} more</li>
          )}
        </ol>
      )}
    </section>
  );
}

function projectLine(standing: BuildReading['project'], name: string): string {
  if (standing === null) return `${name} is not being watched — no reading of the project checkout is configured.`;
  if (standing.unavailable !== null) return standing.unavailable;
  const on = standing.branch === null ? '' : ` on ${standing.branch}`;
  const status = standing.dirty
    ? 'uncommitted changes to tracked files, which hold the upgrade beside this'
    : 'the checkout is clean';
  const waiting =
    standing.behind === 0
      ? 'up to date with its remote'
      : `${standing.behind} commit${standing.behind === 1 ? '' : 's'} waiting`;
  return `${name}${on} — ${waiting}, ${status}`;
}

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
