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
