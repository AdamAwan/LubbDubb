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
 * An observation that did not answer, in the words the cockpit uses for it — never
 * in the vocabulary of a clean one.
 */
function unreadable(environment: string, why: string): WatchCheckReading {
  return { verdict: 'unknown', rows: null, detail: `the watch could not read ${environment} — ${why}` };
}
