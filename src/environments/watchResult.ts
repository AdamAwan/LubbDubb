/**
 * The output contract, and all the schema the harness has.
 *
 * The harness knows nothing about Application Insights, Kusto, `customDimensions`
 * or `exceptions`. It imposes a shape on what comes back and reads nothing else —
 * so this module is the whole of what "an answer" means, and it is pure precisely
 * so the contract's edges (two rows where one was required, a `value` that is not
 * a number, a result that dropped the id echo) are unit tests rather than
 * integration ones.
 *
 * → `docs/spec/29-post-deploy-watch.md#the-output-contract-which-is-all-the-schema-the-harness-has`
 */

/**
 * Which of the questions a query is asking.
 *
 * `presence` is a signal's second query and is parsed identically — the
 * difference is entirely in what a zero-row answer *means*, which is the caller's
 * fold and not this module's.
 */
export type WatchQueryKind = 'signal' | 'presence' | 'measure';

/** One row of whatever the operator's telemetry answered with. */
type WatchRow = Record<string, string | number | boolean | null>;

/**
 * The column the harness's own projection adds, and the name a result has to
 * carry back.
 *
 * Not a word an operator would choose, deliberately: the guard is worthless if a
 * query could satisfy it by accident.
 */
export const WATCH_ID_COLUMN = 'lubbdubbWatchId';

/**
 * What one observation came back with.
 *
 * Three-valued in the same shape {@link EnvironmentHead} is, and for the same
 * reason: `verdict: 'unknown'` is an observation that did not answer, and it must
 * never be read as a quiet one. Everything above this — the dry run now, the
 * verdict fold later — folds `unknown` forward rather than to `clean`.
 */
export interface WatchResult {
  /** The rows the query answered with, or null when the observation did not answer. */
  rows: WatchRow[] | null;
  /** The one number a measure answered with. Null for a signal, and for any failure. */
  value: number | null;
  verdict: 'answered' | 'unknown';
  /** Why, for an `unknown` — in words, because the cockpit says it in words. */
  detail: string | null;
}

/** An observation that did not answer. The one constructor for it, so the shape cannot drift. */
export function unanswered(detail: string): WatchResult {
  return { rows: null, value: null, verdict: 'unknown', detail };
}

/**
 * The query as it is handed to the operator's command: the declared text, plus
 * the harness's own projection carrying the check's id.
 *
 * This is the stale-wrapper guard's front half. `at` refuses a parameter outright
 * because an operator's command that never learned a placeholder would silently
 * answer a wider question; a per-goal query is unavoidably a parameter, so instead
 * of avoiding that failure the harness makes it **observable** — a wrapper that
 * ignores `LUBBDUBB_WATCH_QUERY` and runs something hardcoded comes back without
 * the echo, and {@link parseWatchResult} refuses it.
 *
 * The projection is pipeline syntax because the queries these environments answer
 * are pipeline queries; an operator whose telemetry is not can echo
 * `LUBBDUBB_WATCH_ID` from the wrapper instead, and the verification is identical
 * either way. Interpolation is safe here and nowhere else in this subsystem: the
 * id is the check's own slug, which the document schema holds to kebab-case, and
 * the agent-authored half — the query — is never part of a command string.
 */
export function idProjection(query: string, checkId: string): string {
  return `${query}\n| extend ${WATCH_ID_COLUMN} = "${checkId}"`;
}

/**
 * The pure parse of what the command printed.
 *
 * **Every failure lands on `unknown`, never on an empty answer.** A non-zero
 * exit, a timeout, no output, unparseable output, three rows where one was
 * required and a `value` that is not a number are all the observation failing —
 * and the direction that reads as success is the one this exists to refuse.
 *
 * **The echo is checked on every row, and an empty result carries none.** That is
 * not a hole: zero rows is exactly the answer a signal cannot be trusted on
 * alone, which is why a signal declares a `presence` query whose own rows carry
 * the echo. A wrapper that has stopped honouring the variable therefore fails on
 * the presence read, where the answer is not allowed to be empty.
 */
export function parseWatchResult(stdout: string, checkId: string, kind: WatchQueryKind): WatchResult {
  const text = stdout.trim();
  // The silent success, for `at`'s reason: a query with nothing to report and a
  // broken query print the same thing, and unanswered is the safe direction.
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

/** The label columns a row carries, beyond the harness's own projection. Up to two, drawn verbatim. */
export function watchRowLabels(row: WatchRow): { name: string; value: string }[] {
  return Object.entries(row)
    .filter(([name]) => name !== WATCH_ID_COLUMN)
    .slice(0, 2)
    .map(([name, value]) => ({ name, value: String(value) }));
}
