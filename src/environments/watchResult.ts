// → docs/spec/24-environments.md

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

export function watchRowLabels(row: WatchRow): { name: string; value: string }[] {
  return Object.entries(row)
    .filter(([name]) => name !== WATCH_ID_COLUMN)
    .slice(0, 2)
    .map(([name, value]) => ({ name, value: String(value) }));
}
