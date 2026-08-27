import type { Store } from '../store/store.js';
import type { GoalWatch, WatchReadingVerdict } from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import type { EnvironmentObserver } from './observer.js';
import type { WatchResult } from './watchResult.js';

/**
 * The dry run: **a declared check is run once, immediately, against the
 * environment it will watch** — at plan submission, and again on each amendment.
 * The reading is stored on the check and drawn on the plan sheet; a query that
 * cannot resolve is handed back to the author as a refusal it can act on, the way
 * a schema violation from `plan_submit` is.
 *
 * A syntactically valid query against a table that exists, matching nothing,
 * forever, is the failure this subsystem is most able to produce and least able
 * to notice — and this is where it is cheap to catch, before an agent has spent a
 * day on the work.
 *
 * **What a dry run proves is that the query parses and resolves, never that it
 * will ever match.** Whether the pipe is live at watch time is `presence`'s job.
 * Two failures, two guards, and neither folded into the other.
 *
 * **A measure's baseline rides this same call.** The number the dry run reads is
 * the before — the same query, from the same source, taken days before the
 * arrival — and it is stored rather than discarded. Not a second spawn and not a
 * second code path: one that asked separately would be free to ask a different
 * question of a system that had already changed.
 *
 * → `docs/spec/29-post-deploy-watch.md#the-dry-run`
 */
export interface WatchDryRunner {
  /** Ask the environment about every check this goal declares. Returns what the author must fix. */
  run(originRef: string): Promise<string[]>;
}

/** What the observer and the config are, and where the readings land. */
interface WatchDryRunDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
}

export class WatchDryRun implements WatchDryRunner {
  constructor(private readonly deps: WatchDryRunDeps) {}

  /** @public the seam `plan_submit` and the plan-file drain both reach it through */
  async run(originRef: string): Promise<string[]> {
    const environment = dryRunEnvironment(this.deps.environments);
    // No environment declares telemetry, so there is nothing to put the query to
    // and nothing the author could fix. Off by default, in `environments`' own
    // terms: the checks are still declared and still drawn, with no reading.
    if (environment === null) return [];
    const checks = this.deps.store.listGoalWatches().filter((c) => c.originRef === originRef);
    const refusals: string[] = [];
    for (const check of checks) {
      const reading = await this.read(environment, check);
      this.deps.store.recordWatchDryRun(originRef, check.id, { environment: environment.name, ...reading });
      if (reading.detail !== null) refusals.push(`${check.id}: ${reading.detail}`);
    }
    return refusals;
  }

  /**
   * One check, put to one environment: the presence query first, then the check's
   * own.
   *
   * Presence first because it is what decides whether the second answer means
   * anything. **Presence zero is `unknown`**, and the check's own query is not
   * even asked — the telemetry has never heard of this code path, so whatever it
   * would answer about a defect inside it is not a reading.
   */
  private async read(
    environment: EnvironmentConfig,
    check: GoalWatch,
  ): Promise<{
    verdict: WatchReadingVerdict;
    presence: WatchReadingVerdict | null;
    rows: number | null;
    detail: string | null;
    value: number | null;
  }> {
    const command = environment.watch!.observe;
    if (check.presence !== null) {
      const probe = await this.deps.observer.observe({
        environment: environment.name,
        command,
        checkId: check.id,
        query: check.presence,
        kind: 'presence',
      });
      const presence = verdictOf(probe);
      if (presence === 'unknown')
        return {
          verdict: 'unknown',
          presence,
          rows: null,
          value: null,
          detail: `the watch could not read ${environment.name} — ${probe.detail ?? 'the observation did not answer'}`,
        };
      if (presence === 'zero')
        return {
          verdict: 'unknown',
          presence,
          rows: null,
          value: null,
          detail:
            `the presence query matched nothing on ${environment.name}, so the telemetry has never heard of this ` +
            'code path — wrong name, wrong application, or nothing instrumented. A signal cannot report clean ' +
            'while its presence query is silent.',
        };
    }
    const result = await this.deps.observer.observe({
      environment: environment.name,
      command,
      checkId: check.id,
      query: check.query,
      kind: check.kind === 'measure' ? 'measure' : 'signal',
    });
    const verdict = verdictOf(result);
    const presence = check.presence === null ? null : ('fires' as const);
    if (verdict === 'unknown')
      return {
        verdict,
        presence,
        rows: null,
        value: null,
        detail: `the watch could not read ${environment.name} — ${result.detail ?? 'the observation did not answer'}`,
      };
    // A measure answered, so this number **is** the baseline: the same query,
    // from the same source, before anything changed. Kept rather than discarded,
    // which is the whole of why it can be trusted as a before — a second call, on
    // a second schedule, would be free to ask a different question of a system
    // that had already changed.
    if (check.kind === 'measure')
      return { verdict, presence, rows: result.rows!.length, value: result.value, detail: null };
    if (verdict === 'zero')
      return {
        verdict,
        presence,
        rows: 0,
        value: null,
        detail:
          `the code path runs on ${environment.name} and the thing this reports is not happening. Either the ` +
          'query is wrong or the ticket is — one of the two is worth settling before any of this is built.',
      };
    // Fires on both: the query is proven live and the reported defect is proven
    // real. Nothing to hand back.
    return { verdict, presence, rows: result.rows!.length, value: null, detail: null };
  }
}

/**
 * `fires`, `zero` or `unknown` for one observation.
 *
 * **`unknown` never folds to either of the others.** An expired credential, a
 * missing binary, a job that never ran and a genuinely quiet release all fail
 * identically here, and only the last is about the work — read as zero they are
 * indistinguishable, and read as clean one layer up the cockpit would state in the
 * operator's own words that a fix is verified for a reason that has nothing to do
 * with the fix.
 */
function verdictOf(result: WatchResult): WatchReadingVerdict {
  if (result.verdict === 'unknown' || result.rows === null) return 'unknown';
  return result.rows.length === 0 ? 'zero' : 'fires';
}

/**
 * Which environment a dry run is put to: the first that declares telemetry.
 *
 * One, not all of them. A dry run answers "does this query parse and resolve",
 * which is a property of the query rather than of the deployment — and asking
 * every environment would spawn a process per environment per check on every plan
 * submission, to learn the same thing several times. Where the answer legitimately
 * differs between environments is exactly the case `presence` exists for, and that
 * is asked at watch time, per environment.
 */
function dryRunEnvironment(environments: readonly EnvironmentConfig[]): EnvironmentConfig | null {
  return environments.find((env) => env.watch !== undefined && env.watch.observe.trim() !== '') ?? null;
}
