// → docs/spec/24-environments.md

import type { WatchSourceLanguage } from '../types.js';
import { carriesSince, missingSinceRefusal, withPeriod } from '../validation/watchQueryShape.js';

export type WatchQueryKind = 'signal' | 'presence' | 'measure';

type WatchRow = Record<string, string | number | boolean | null>;

export const WATCH_ID_COLUMN = 'lubbdubbWatchId';

export interface WatchResult {
  rows: WatchRow[] | null;
  value: number | null;
  verdict: 'answered' | 'unknown';
  detail: string | null;
}

export function unanswered(detail: string): WatchResult {
  return { rows: null, value: null, verdict: 'unknown', detail };
}

export function idProjection(query: string, checkId: string): string {
  return `${query}\n| extend ${WATCH_ID_COLUMN} = "${checkId}"`;
}

/** What `{since}` and `{until}` are replaced with. */
export interface WatchPeriod {
  since: string;
  until: string;
}

/**
 * The query as it is put to the environment, or **a refusal where it carries no
 * `{since}`** — which is every check declared before the token existed. A reading
 * that cannot be bounded to the window is not an answer: it counts what happened
 * before the work arrived, which reads as the defect the work fixed.
 *
 * Both observers route through it rather than their callers, so a query reaches
 * a shell substituted or not at all. The id projection is a pipeline segment, so
 * it is appended to `kql` alone; every other language's wrapper echoes the id.
 *
 * @public read by `CommandEnvironmentObserver` and by its fake
 */
export function preparedQuery(
  query: string,
  period: WatchPeriod,
  checkId: string,
  kind: WatchQueryKind,
  language: WatchSourceLanguage,
): { query: string; refusal: null } | { query: null; refusal: string } {
  if (!carriesSince(query))
    return { query: null, refusal: missingSinceRefusal(kind === 'presence' ? 'presence' : 'query') };
  const bounded = withPeriod(query, period.since, period.until);
  return { query: language === 'kql' ? idProjection(bounded, checkId) : bounded, refusal: null };
}

export function parseWatchResult(stdout: string, checkId: string, kind: WatchQueryKind): WatchResult {
  const text = stdout.trim();
  if (text === '') return unanswered('the observation exited 0 and printed nothing');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return unanswered(`the observation did not answer with JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(json)) return unanswered('the observation answered with something other than a list of rows');
  const rows: WatchRow[] = [];
  for (const entry of json) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return unanswered('the observation answered with a list of something other than rows');
    const row = entry as WatchRow;
    if (row[WATCH_ID_COLUMN] !== checkId) return unanswered('the command answered without the query it was given');
    rows.push(row);
  }
  if (kind !== 'measure') return { rows, value: null, verdict: 'answered', detail: null };
  if (rows.length !== 1)
    return unanswered(`a measure answers with exactly one row; this answered ${String(rows.length)}`);
  const value = rows[0]!['value'];
  if (typeof value !== 'number' || !Number.isFinite(value))
    return unanswered('a measure answers with a numeric "value"; this row carries none');
  return { rows, value, verdict: 'answered', detail: null };
}

export function scalarShaped(rows: readonly WatchRow[]): boolean {
  if (rows.length !== 1) return false;
  const columns = Object.entries(rows[0]!).filter(([name]) => name !== WATCH_ID_COLUMN);
  return columns.length === 1 && typeof columns[0]![1] === 'number';
}
