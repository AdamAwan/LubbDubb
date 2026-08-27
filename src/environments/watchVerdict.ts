import type { GoalWatch, WatchCheckVerdict } from '../types.js';
import type { WatchResult } from './watchResult.js';

/**
 * The verdict fold: what one check's observations mean, in three values and no
 * more.
 *
 * Pure, and separated from the desk that spawns the processes for the reason
 * {@link parseWatchResult} is separated from the observer — this is the rule, and
 * a rule that can only be exercised by standing a server up is a rule nobody
 * exercises.
 *
 * Two lines carry the whole module:
 *
 * **`unknown` never folds to `clean`.** A failed observation, a timeout, a result
 * that came back without the id echo and a `presence` query answering zero are all
 * the watch failing to *read* the environment, and only a reading that came back
 * can say anything about the work. Read as clean they are indistinguishable on the
 * glass, and the cockpit would state in the operator's own words that a fix is
 * verified for a reason that has nothing to do with the fix. This is
 * `GoalReachStatus`' rule one layer up, and the same rule because it is the same
 * mistake.
 *
 * **A measure is a second arm, not a reinterpretation of the first.** A signal
 * folds on `tolerate` and answers about rows; a measure folds on the threshold or
 * the baseline it declared and answers about one number. Neither reads the
 * other's columns, and a signal's verdict does not change shape because measures
 * exist.
 *
 * **Nothing here rolls up to a word.** There is one verdict per check and no fold
 * across them: a goal whose signal passed and whose measure failed is a fix that
 * worked and a proc that is still slow, and a single `regressed` would hide the
 * half that is good news — which is the half the ticket was about.
 *
 * → `docs/spec/29-post-deploy-watch.md#the-verdict`
 */

/** One check's reading, as the store writes it and the card draws it. */
interface WatchCheckReading {
  verdict: WatchCheckVerdict;
  /** How many rows the check's own query matched, or null when nothing was read. */
  rows: number | null;
  /** Why, in words. Null only for a `clean` — every other verdict says what it is. */
  detail: string | null;
}

/**
 * Fold one check's two observations into its verdict.
 *
 * `presence` is passed as null where the check declares none, and that is the only
 * shape in which a missing presence read is acceptable: a signal that declares one
 * and could not have it answered is `unknown`, and its own query is not consulted
 * at all. Whatever a query would say about a defect inside a code path the
 * telemetry has never heard of is not a reading.
 */
export function watchCheckVerdict(input: {
  check: GoalWatch;
  environment: string;
  /** What the presence query answered, or null where the check declares none. */
  presence: WatchResult | null;
  /** What the check's own query answered. Not read at all when presence is silent. */
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

/**
 * A measure's comparison: one number against what it declared.
 *
 * **Every way of not having a number to compare is `unknown`.** A row count other
 * than one and a non-numeric `value` are already refused by
 * {@link parseWatchResult}, and this adds the third: a measure that declared
 * `noWorseThan: "baseline"` whose baseline was never taken has nothing to compare
 * against, and a comparison against nothing is not a passing one. The dry run is
 * where a baseline comes from, so a check whose declaration was never put to an
 * environment lands here.
 *
 * The baseline is read lower-is-better — a percentile, a duration, a queue depth
 * — and a measure whose good news is a bigger number declares an `over` instead.
 * → `docs/spec/29-post-deploy-watch.md#the-baseline-and-why-a-measure-is-not-trusted-without-one`
 */
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

/** Outside what was declared, in the words the card draws it in. */
function regressed(detail: string): WatchCheckReading {
  return { verdict: 'regressed', rows: null, detail };
}

/**
 * An observation that did not answer, in the words the cockpit uses for it — never
 * in the vocabulary of a clean one.
 */
function unreadable(environment: string, why: string): WatchCheckReading {
  return { verdict: 'unknown', rows: null, detail: `the watch could not read ${environment} — ${why}` };
}
