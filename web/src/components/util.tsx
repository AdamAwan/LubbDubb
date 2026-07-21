import type { JSX } from 'react';

/** A coloured status dot for CI / agent status. */
export function statusDot(status: string): JSX.Element {
  const cls =
    status === 'passing' || status === 'done'
      ? 'green'
      : status === 'failing' || status === 'failed'
        ? 'red'
        : status === 'waiting'
          ? 'amber'
          : status === 'running' || status === 'starting'
            ? 'blue'
            : 'grey';
  return <span className={`dot ${cls}`} title={status} />;
}

export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}
