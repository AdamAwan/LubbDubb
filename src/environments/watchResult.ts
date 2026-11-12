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
  return parseRows(stdout, kind, checkId, OBSERVATION_SAID);
}

/**
 * A person's answer to a `watch_reading` ask, through the same output contract as a harness reading —
 * apart from the id echo, which a person who copied the query and pasted its answer stands in for. A
 * measure may be answered with its one number alone.
 * → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run
 */
export function parseOperatorAnswer(answer: string, kind: WatchQueryKind): WatchResult {
  const text = answer.trim();
  if (kind === 'measure' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) {
    const value = Number(text);
    return { rows: [{ value }], value, verdict: 'answered', detail: null };
  }
  return parseRows(text, kind, null, ANSWER_SAID);
}

interface ContractWords {
  empty: string;
  notJson: string;
  notList: string;
  notRows: string;
}

const OBSERVATION_SAID: ContractWords = {
  empty: 'the observation exited 0 and printed nothing',
  notJson: 'the observation did not answer with JSON',
  notList: 'the observation answered with something other than a list of rows',
  notRows: 'the observation answered with a list of something other than rows',
};

const ANSWER_SAID: ContractWords = {
  empty: 'the answer was empty',
  notJson: 'the answer was not JSON rows, or one number for a measure',
  notList: 'the answer was something other than a list of rows',
  notRows: 'the answer was a list of something other than rows',
};

function parseRows(stdout: string, kind: WatchQueryKind, echo: string | null, said: ContractWords): WatchResult {
  const text = stdout.trim();
  if (text === '') return unanswered(said.empty);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return unanswered(`${said.notJson}: ${(err as Error).message}`);
  }
  if (!Array.isArray(json)) return unanswered(said.notList);
  const rows: WatchRow[] = [];
  for (const entry of json) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return unanswered(said.notRows);
    const row = entry as WatchRow;
    if (echo !== null && row[WATCH_ID_COLUMN] !== echo)
      return unanswered('the command answered without the query it was given');
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
