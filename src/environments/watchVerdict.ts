import type { GoalWatch, WatchCheckVerdict } from '../types.js';
import type { WatchResult } from './watchResult.js';

// → docs/spec/24-environments.md

interface WatchCheckReading {
  verdict: WatchCheckVerdict;
  rows: number | null;
  detail: string | null;
}

export function watchCheckVerdict(input: {
  check: GoalWatch;
  environment: string;
  presence: WatchResult | null;
  reading: WatchResult;
}): WatchCheckReading {
  const { check, environment, presence, reading } = input;
  if (presence !== null) {
    if (presence.rows === null || presence.verdict === 'unknown')
      return unreadable(environment, presence.detail ?? 'the observation did not answer');
    if (presence.rows.length === 0)
      return {
        verdict: 'unknown',
        rows: null,
        detail:
          `the watch could not read ${environment} — the code path this check is about has not run here, so its ` +
          'presence query matched nothing. A signal cannot report clean while its presence query is silent.',
      };
  }
  if (reading.rows === null || reading.verdict === 'unknown')
    return unreadable(environment, reading.detail ?? 'the observation did not answer');
  if (check.kind === 'measure') return measureVerdict(check, environment, reading);
  const rows = reading.rows.length;
  if (rows <= check.tolerate) return { verdict: 'clean', rows, detail: null };
  return {
    verdict: 'regressed',
    rows,
    detail:
      `${environment} answered ${String(rows)} row${rows === 1 ? '' : 's'} where the check declared ` +
      `${check.tolerate === 0 ? 'none at all' : `no more than ${String(check.tolerate)}`}.`,
  };
}

function measureVerdict(check: GoalWatch, environment: string, reading: WatchResult): WatchCheckReading {
  const value = reading.value;
  if (value === null)
    return unreadable(environment, 'a measure answers with exactly one row carrying a numeric "value"');
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const read = `${environment} read ${String(value)}${unit}`;
  if (check.expectUnder !== null && value > check.expectUnder)
    return regressed(`${read}, where the check declared it must stay under ${String(check.expectUnder)}${unit}.`);
  if (check.expectOver !== null && value < check.expectOver)
    return regressed(`${read}, where the check declared it must stay over ${String(check.expectOver)}${unit}.`);
  if (check.expectBaseline) {
    if (check.baselineValue === null)
      return unreadable(
        environment,
        'this measure declared it must be no worse than its baseline, and no baseline was ever taken. There ' +
          'is nothing to compare the reading against, which is not the same as the reading being good.',
      );
    if (value > check.baselineValue)
      return regressed(
        `${read}, worse than the ${String(check.baselineValue)}${unit} it read before the work arrived.`,
      );
  }
  return { verdict: 'clean', rows: null, detail: null };
}

function regressed(detail: string): WatchCheckReading {
  return { verdict: 'regressed', rows: null, detail };
}

function unreadable(environment: string, why: string): WatchCheckReading {
  return { verdict: 'unknown', rows: null, detail: `the watch could not read ${environment} — ${why}` };
}
