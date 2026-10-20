import { DAY_MS, utcDay } from '../primitives.js';
import type { AppErrorDay, AppErrorGroup } from '../types.js';
import type { AppErrorRow } from './report.js';

// → docs/spec/39-app-errors.md#what-is-stored-and-for-how-long

/** Absent this long, a group reads `gone`; seen again after a gap this long, it reads `returned`. */
export const QUIET_MS = 3 * DAY_MS;

/** How many days of daily counts a group keeps — and how far back a first read looks. */
const RETENTION_DAYS = 14;

export const MAX_LOOKBACK_MS = RETENTION_DAYS * DAY_MS;

/** A group not seen for this long is forgotten; seen again after it, it is `new` once more. */
export const GROUP_RETENTION_DAYS = 30;

export type AppErrorGroupWrite = Omit<AppErrorGroup, 'daily'>;

/** What a read needs of a group already held to merge a new sighting into it. */
export type AppErrorMarks = Pick<AppErrorGroup, 'firstSeen' | 'lastSeen' | 'returnedAt'>;

/** The retained window — the last `RETENTION_DAYS` UTC days, today included. The prune and the wire both read it. */
export function retainedDays(now: number): string[] {
  return Array.from({ length: RETENTION_DAYS }, (_, i) => utcDay(now - (RETENTION_DAYS - 1 - i) * DAY_MS));
}

export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** `{since}` for the next read: the last successful one, never further back than the lookback. */
export function readSince(okAt: string | null, now: number): string {
  const floor = now - MAX_LOOKBACK_MS;
  const from = okAt === null ? floor : Math.max(Date.parse(okAt), floor);
  return new Date(from).toISOString();
}

export function mergeGroup(
  existing: AppErrorMarks | undefined,
  environment: string,
  row: AppErrorRow,
): AppErrorGroupWrite {
  const gap = existing === undefined ? 0 : Date.parse(row.firstSeen) - Date.parse(existing.lastSeen);
  return {
    environment,
    fingerprint: row.fingerprint,
    title: row.title,
    operation: row.operation,
    version: row.version,
    frames: row.frames,
    url: row.url,
    firstSeen: existing !== undefined && existing.firstSeen < row.firstSeen ? existing.firstSeen : row.firstSeen,
    lastSeen: existing !== undefined && existing.lastSeen > row.lastSeen ? existing.lastSeen : row.lastSeen,
    returnedAt: gap >= QUIET_MS ? row.firstSeen : (existing?.returnedAt ?? null),
  };
}

/**
 * A row's count spread evenly over the UTC days between its first and last sighting inside the read,
 * remainder on the last day. A five-minute read lands on one day; a first read's fortnight does not
 * all land on today, which would read as a spike against its own history.
 */
export function spreadCounts(row: AppErrorRow, since: string): AppErrorDay[] {
  const end = Date.parse(row.lastSeen);
  const start = Math.min(Math.max(Date.parse(row.firstSeen), Date.parse(since)), end);
  const days: string[] = [];
  for (let at = dayStart(utcDay(start)); at <= end && days.length <= RETENTION_DAYS; at += DAY_MS)
    days.push(utcDay(at));
  const share = Math.floor(row.count / days.length);
  const rest = row.count - share * days.length;
  return days.map((day, i) => ({ day, count: share + (i === days.length - 1 ? rest : 0) })).filter((d) => d.count > 0);
}
