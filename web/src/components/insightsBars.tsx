import type { JSX } from 'react';
import type { InsightsWindowView, PoolInsightsPayload } from '../types.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { Label } from './label.js';
import { logUsage } from '../cockpit/usage.js';

export function PoolBar({
  payload,
  project,
  actions,
}: {
  payload: PoolInsightsPayload | null;
  project: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const rollup = payload?.rollup ?? null;
  return (
    <>
      <Label dense>Project</Label>
      <div className="insights-win" role="group" aria-label="Project">
        <button
          type="button"
          aria-pressed={project === null}
          className={project === null ? 'on' : ''}
          onClick={() => {
            logUsage('pool.filter');
            actions.openInsights({ poolProject: null });
          }}
        >
          All
        </button>
        {(payload?.projects ?? []).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={name === project}
            className={name === project ? 'on' : ''}
            onClick={() => {
              logUsage('pool.filter');
              actions.openInsights({ poolProject: name });
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {/* The pool ignores the window bar: the digest's bucket is a UTC day and its
          retention is ninety of them. → docs/spec/28-cross-fleet-pool.md */}
      <span className="insights-meta">
        {rollup === null
          ? 'reading…'
          : `${rollup.fleets.length} fleet${rollup.fleets.length === 1 ? '' : 's'} · ${
              rollup.days.length === 0 ? 'nothing published yet' : `${rollup.days.length} UTC days`
            }`}
      </span>
    </>
  );
}

export function SessionNote({
  session,
  window: view,
  now,
}: {
  session: NonNullable<InsightsWindowView['session']>;
  window: InsightsWindowView;
  now: number;
}): JSX.Element {
  if (session.kind === 'unreported')
    return (
      <p className="insights-anchor is-loose">
        <b>The last five hours</b>, not the account&apos;s window — no agent here has ever reported one.{' '}
        <span className="dim">{stamp(view.since, now)} to now.</span>
      </p>
    );
  if (session.kind === 'stale')
    return (
      <p className="insights-anchor is-loose">
        <b>The last five hours</b>, not the account&apos;s window — the newest reading names a reset at{' '}
        {stamp(session.resetsAt, now)}, which this harness cannot anchor to.{' '}
        <span className="dim">{stamp(view.since, now)} to now.</span>
      </p>
    );
  return (
    <p className="insights-anchor">
      <b>The account&apos;s five-hour window</b>, opened {stamp(session.startsAt, now)}, resets{' '}
      {stamp(session.resetsAt, now)}.
      {session.usedPercentage === null ? null : (
        <>
          {' '}
          <b>{Math.round(session.usedPercentage)}% spent</b> as of {stamp(session.capturedAt, now)}.
        </>
      )}{' '}
      <span className="dim">The split below is cost, which is not what the limit meters.</span>
    </p>
  );
}

function stamp(iso: string | null, now: number): string {
  if (iso === null) return 'the start of the window';
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return iso;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (mins < 1) return `${clock} (just now)`;
  return ms < 0 ? `${clock} (${rel} ago)` : `${clock} (in ${rel})`;
}
