// → docs/spec/29-post-deploy-watch.md

const TAIL = /^(count|summarize|make-series)\b/i;
const SQL_AGGREGATE = /^select\b[\s\S]*\bcount\s*\(/i;

export function aggregatingTail(query: string): string | null {
  const segments = query
    .split('|')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  if (segments.length > 1) {
    const match = TAIL.exec(last);
    if (match === null) return null;
    const operator = match[1]!.toLowerCase();
    if (operator === 'summarize' && /\bby\b/i.test(last)) return null;
    return operator;
  }
  if (SQL_AGGREGATE.test(last) && !/\bgroup\s+by\b/i.test(last)) return 'count';
  return null;
}

export function aggregatingQueryRefusal(field: 'query' | 'presence', operator: string): string {
  const why =
    field === 'query'
      ? 'A signal answers with the matching rows themselves and the harness counts them, so an aggregate reads ' +
        'as exactly one occurrence on every reading, for ever — a check that reports regressed the day it is ' +
        'declared and never stops.'
      : 'A presence query proves the code path is running by answering rows, and an aggregate can never answer ' +
        'zero — so it reports the code path live on an environment where it has never run, which is the whole ' +
        'of what presence exists to catch.';
  return (
    `the ${field} ends in "${operator}", which answers one row carrying the count. ${why} Drop the ` +
    `"| ${operator}" and return the rows themselves: for a signal, "tolerate" is how many of them the harness ` +
    'may count. Where one row per group is what you want rather than one per occurrence, aggregate with a ' +
    '"by" clause.'
  );
}

/**
 * The two substitutions a watch query carries: the instants the reading is about.
 * Declared here beside the refusals that require them, so the tokens the author is
 * told to write and the tokens the harness replaces cannot come to disagree.
 *
 * @public written by the author, substituted by `preparedQuery`
 */
export const SINCE_TOKEN = '{since}';

const UNTIL_TOKEN = '{until}';

export function carriesSince(query: string): boolean {
  return query.includes(SINCE_TOKEN);
}

export function carriesUntil(query: string): boolean {
  return query.includes(UNTIL_TOKEN);
}

export function withPeriod(query: string, since: string, until: string): string {
  return query.replaceAll(SINCE_TOKEN, since).replaceAll(UNTIL_TOKEN, until);
}

export function missingSinceRefusal(field: 'query' | 'presence'): string {
  const why =
    field === 'query'
      ? 'A query with no time bound answers about the whole history the telemetry keeps, so it counts the ' +
        'occurrences the work was meant to stop happening alongside the ones since it shipped — a check that ' +
        'reads regressed on the strength of the defect it fixed, on every reading, for ever.'
      : 'A presence query with no time bound proves the code path ran at some point in the retention period, ' +
        'which is not what it is asked: it exists to say the path is running now, on the environment the ' +
        'window is watching.';
  return (
    `the ${field} carries no "${SINCE_TOKEN}", so nothing bounds it to the period being watched. ${why} ` +
    `Bound it yourself, naming your own timestamp column — "| where timestamp > datetime(${SINCE_TOKEN})" — ` +
    'and the harness substitutes the instant the reading is about: the moment the work arrived on that ' +
    'environment for a watch reading, and one window before the merge for the dry run that takes the baseline.'
  );
}

export function missingUntilRefusal(): string {
  return (
    `the query carries no "${UNTIL_TOKEN}", so nothing ends the period a measure is read over. A measure's baseline ` +
    'is read over the window before the merge; taken once the change has deployed, a query that runs on to ' +
    'now reads the change into the number it is compared against — the change measured against itself, which ' +
    `passes on any regression. Bound both ends — "| where timestamp > datetime(${SINCE_TOKEN}) and timestamp <= ` +
    `datetime(${UNTIL_TOKEN})" — and the harness substitutes now for a watch reading and the merge for the baseline.`
  );
}
