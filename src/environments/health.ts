import type { EnvironmentHealthState, EnvironmentHealthTier } from '../types.js';

/**
 * The output contract of an environment's health check, and all the schema the
 * harness has.
 *
 * The harness knows nothing about pipelines, Solr, pods or dashboards. It imposes
 * a shape on what the operator's command prints and reads nothing else — so this
 * module is the whole of what "the environment is well" means, and it is pure
 * precisely so the contract's edges (a state nobody declared, a tier the cockpit
 * cannot rank, a `reasons` that is not a list) are unit tests rather than
 * integration ones.
 *
 * → `docs/spec/24-environments.md#is-the-environment-well`
 */

/** How many reasons one report may carry. Beyond this the row is a log, not a reading. */
const MAX_REASONS = 12;

/** How long one reason may be. A stack trace pasted into the list is not a reason. */
const MAX_REASON_CHARS = 200;

/** The tiers a report may name, worst first — the order the cockpit ranks them in. */
const TIERS: readonly EnvironmentHealthTier[] = ['red', 'orange'];

/**
 * What one health check answered.
 *
 * Three-valued in the same shape {@link EnvironmentHead} and {@link WatchResult}
 * are, and for their reason: `unknown` is a check that did not answer, and it must
 * never be read as a quiet one. An expired credential, a missing binary and a
 * genuinely well environment all exit a shell the same way, and only the last is
 * about the environment.
 */
export interface EnvironmentHealthReport {
  state: EnvironmentHealthState;
  /** How bad, for an `unhealthy`. Null everywhere else, and null on an untiered one. */
  tier: EnvironmentHealthTier | null;
  /** What the check said is wrong, in its own words. Drawn verbatim, never parsed. */
  reasons: string[];
  /**
   * Why the harness could not read an answer — the exit code, the signal, or what
   * was wrong with the output.
   *
   * **Non-null only for the harness's own refusals**, never for a check that
   * declared `unknown` itself. The prober reads that distinction to decide whether
   * a non-zero exit is the better account of the silence than the parse is.
   */
  detail: string | null;
}

/** A check that did not answer. The one constructor for it, so the shape cannot drift. */
export function unreadable(detail: string): EnvironmentHealthReport {
  return { state: 'unknown', tier: null, reasons: [], detail };
}

/**
 * The pure parse of what the health command printed.
 *
 * **Every failure lands on `unknown`, never on `healthy` and never on
 * `unhealthy`.** Both of the other directions are wrong and both are silent: read
 * as healthy, a broken check is an environment nobody is watching that says it is
 * fine; read as unhealthy, it is a page at 3am about a credential.
 *
 * The vocabulary is deliberately generous on the way in and closed on the way out.
 * `Healthy`, `healthy` and `HEALTHY` are one word, and `NotHealthy` and
 * `unhealthy` are another, because the shape of this contract is a script somebody
 * writes once from an example — but what comes out is one of three values the
 * cockpit can draw and the store can key on.
 *
 * A **tier it cannot rank is refused** rather than kept as text. The tier is what
 * decides how loudly the reading is drawn, so an unrecognised one would be drawn
 * at some tone the operator never asked for; refused, it says so on the glass
 * where the person who wrote the script will read it. A **missing** tier is not
 * refused — the state is the signal and the tier is the detail — and an untiered
 * `unhealthy` is drawn at the loudest tone there is, because an unstated severity
 * is not a reason to be quiet.
 */
export function parseHealthReport(stdout: string): EnvironmentHealthReport {
  const text = stdout.trim();
  // The silent success, for `at`'s reason: a check with a broken query and one
  // with nothing to say print the same thing, and unanswered is the safe direction.
  if (text === '') return unreadable('the health check printed nothing');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return unreadable(`the health check did not answer with JSON: ${(err as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return unreadable('the health check answered with something other than a {"state": …} report');
  const report = json as Record<string, unknown>;
  const state = readState(report['state']);
  if (state === null)
    return unreadable('the health check named no state the harness knows — "Healthy", "NotHealthy" or "Unknown"');
  const reasons = readReasons(report['reasons']);
  if (reasons === null) return unreadable('"reasons" must be a list of sentences saying what is wrong');
  const tier = readTier(report['tier']);
  if (tier === null) return unreadable(`"tier" must be ${TIERS.join(' or ')} — the harness ranks no others`);
  // A healthy report carrying a tier is a script with a bug in it, and the two
  // halves disagree about the only thing the reading is for. Refused rather than
  // ignored: a dropped tier is a severity nobody sees again.
  if (state !== 'unhealthy' && tier !== undefined)
    return unreadable(`a "${state}" report carries no tier — a tier says how bad an unhealthy one is`);
  return { state, tier: tier ?? null, reasons, detail: null };
}

/** The declared state, or null for a word the harness does not know. */
function readState(value: unknown): EnvironmentHealthState | null {
  if (typeof value !== 'string') return null;
  // Punctuation and case are stripped so `NotHealthy`, `not-healthy` and
  // `not healthy` are one word: this contract is written once, from an example.
  const word = value.toLowerCase().replace(/[^a-z]/g, '');
  if (word === 'healthy' || word === 'ok') return 'healthy';
  if (word === 'nothealthy' || word === 'unhealthy') return 'unhealthy';
  if (word === 'unknown') return 'unknown';
  return null;
}

/** The tier, `undefined` where none was named, or null for one the cockpit cannot rank. */
function readTier(value: unknown): EnvironmentHealthTier | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  return TIERS.find((t) => t === word) ?? null;
}

/** The reasons, bounded; null where `reasons` was something other than a list. */
function readReasons(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim().slice(0, MAX_REASON_CHARS))
    .filter((r) => r !== '')
    .slice(0, MAX_REASONS);
}
