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

export function relTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/** Compact elapsed duration between two instants, e.g. "3m 12s" or "0:07". */
export function elapsed(fromIso: string, toIso: string | null, now: number = Date.now()): string {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : now;
  const secs = Math.max(0, Math.round((to - from) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
