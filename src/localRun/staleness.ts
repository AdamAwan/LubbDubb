import type { LocalRun } from '../types.js';

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(Math.max(minutes, 1))} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${String(days)} days`;
}

export function staleness(live: LocalRun, windowMs: number, now: number): string | null {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;

  const stamp = live.interruptedAt ?? live.lastSeenAt;
  if (stamp === null)
    return (
      'nothing recorded when it was interrupted or when it was last held, so how long ago that was is ' +
      'not known and it was not brought back. Whatever survived may still be running.'
    );
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return 'when it was interrupted was not readable, so it was not brought back';

  const ageMs = now - at;
  if (ageMs <= windowMs) return null;
  const what = live.interruptedAt === null ? 'the harness was last holding it' : 'it was interrupted';
  return (
    `${what} ${describeAge(ageMs)} ago, longer than the ${describeAge(windowMs)} a run may be ` +
    'brought back within, so it was not brought back — start it again when you want it. Whatever survived ' +
    'may still be running. `localRun.resumeWindowMs` on the Config page is what sets that.'
  );
}
