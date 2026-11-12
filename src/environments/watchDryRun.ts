import type { Store } from '../store/store.js';
import type { GoalWatch, WatchReadingVerdict } from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import { observationAsk, type EnvironmentObserver } from './observer.js';
import { scalarShaped, unanswered, type WatchResult } from './watchResult.js';
import { carriesUntil, missingUntilRefusal } from '../validation/watchQueryShape.js';
import { beforeMergePeriod } from './watchWindow.js';
import { goalMergedAt } from './landings.js';
import { resolveWatchSource, watchSources } from './watchSource.js';
import type { WatchAsks } from './watchAsks.js';

// → docs/spec/24-environments.md

export interface WatchDryRunner {
  run(originRef: string): Promise<string[]>;
}

interface WatchDryRunDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
  /** Asks a person for the baseline of a live check only they can run. */
  asks: Pick<WatchAsks, 'askBaselines'>;
  now?: () => number;
}

export class WatchDryRun implements WatchDryRunner {
  private readonly now: () => number;

  constructor(private readonly deps: WatchDryRunDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** @public the seam `plan_submit` and the plan-file drain both reach it through */
  async run(originRef: string): Promise<string[]> {
    if (!this.deps.environments.some((env) => watchSources(env.watch).length > 0)) return [];
    const checks = this.deps.store.watches.listDryRunWatches(originRef);
    const merged = goalMergedAt(this.deps.store.environments.listGoalLandings(), originRef);
    const answered = this.answeredBaselines(originRef);
    const refusals: string[] = [];
    for (const check of checks) {
      const environment = dryRunEnvironment(this.deps.environments, check.source);
      if (answered.has(check.id) && check.dryRunAt !== null && resolveWatchSource(environment, check).operator !== null)
        continue;
      const { reading, refusal } = await this.read(environment, check, merged);
      this.deps.store.watches.recordWatchDryRun(originRef, check.id, { environment: environment.name, ...reading });
      if (refusal !== null) refusals.push(`${check.id}: ${refusal}`);
    }
    if (checks.some((c) => c.live)) this.deps.asks.askBaselines(originRef);
    return refusals;
  }

  /**
   * The checks whose baseline a person answered, on a query an edit has not changed since — an edit clears
   * the ask with it. Their stored dry run is that answer, which no placeholder may overwrite.
   */
  private answeredBaselines(originRef: string): Set<string> {
    const { store } = this.deps;
    return new Set(
      store.watches
        .listWatchAsks(originRef)
        .filter((a) => a.ask === 'baseline' && store.humanTasks.getHumanTask(a.taskId)?.status === 'done')
        .map((a) => a.checkId),
    );
  }

  /**
   * The check's dry run on one environment, and what it says to the author — nothing, for a source only a
   * person can run, whose baseline ask stands in for the reading.
   */
  private async read(
    environment: EnvironmentConfig,
    check: GoalWatch,
    merged: number | null,
  ): Promise<{ reading: DryRunReading; refusal: string | null }> {
    const resolved = resolveWatchSource(environment, check);
    if (
      (resolved.source !== null || resolved.operator !== null) &&
      merged !== null &&
      check.kind === 'measure' &&
      !carriesUntil(check.query)
    ) {
      const refused = readingOf(environment, check, unanswered(missingUntilRefusal()));
      return { reading: refused, refusal: refused.detail };
    }
    if (resolved.operator !== null) return { reading: operatorDryRun(environment, check), refusal: null };
    const reading = await this.observe(environment, check, resolved, merged);
    return { reading, refusal: reading.detail };
  }

  private async observe(
    environment: EnvironmentConfig,
    check: GoalWatch,
    resolved: ReturnType<typeof resolveWatchSource>,
    merged: number | null,
  ): Promise<DryRunReading> {
    if (resolved.source === null)
      return { verdict: 'unknown', presence: null, rows: null, value: null, detail: resolved.refusal };
    const period = beforeMergePeriod(environment, merged, this.now());
    const ask = observationAsk(environment.name, resolved.source, check.id, period);
    const presence =
      check.presence === null
        ? null
        : await this.deps.observer.observe({ ...ask, query: check.presence, kind: 'presence' });
    const silent = presence === null ? null : presenceRefusal(environment, presence);
    if (silent !== null) return silent;
    const result = await this.deps.observer.observe({
      ...ask,
      query: check.query,
      kind: check.kind === 'measure' ? 'measure' : 'signal',
    });
    return readingOf(environment, check, result);
  }
}

/** A check on a source only a person can run is never put to it: the baseline ask stands in for its dry run. */
function operatorDryRun(environment: EnvironmentConfig, check: GoalWatch): DryRunReading {
  return {
    verdict: 'unknown',
    presence: null,
    rows: null,
    value: null,
    detail:
      `${environment.name} reads this check's source only through a person, so nothing was put to it here. ` +
      (check.live
        ? 'Its baseline is asked for on the bench, as the reading from before the merge.'
        : 'Its baseline is asked for on the bench once the set is accepted.'),
  };
}

/**
 * What a dry run reads off a presence answer and the check's own — the harness's observation or a person's
 * answer to a baseline ask, folded the same way. → docs/spec/29-post-deploy-watch.md#the-dry-run
 */
export function dryRunOf(
  environment: EnvironmentConfig,
  check: GoalWatch,
  presence: WatchResult | null,
  result: WatchResult,
): DryRunReading {
  return (presence === null ? null : presenceRefusal(environment, presence)) ?? readingOf(environment, check, result);
}

/** A presence answer that did not fire: the dry run stops there, and says why. Null where it fired. */
function presenceRefusal(environment: EnvironmentConfig, presence: WatchResult): DryRunReading | null {
  const probed = verdictOf(presence);
  if (probed === 'unknown')
    return {
      verdict: 'unknown',
      presence: probed,
      rows: null,
      value: null,
      detail: `the watch could not read ${environment.name} — ${presence.detail ?? 'the observation did not answer'}`,
    };
  if (probed === 'zero')
    return {
      verdict: 'unknown',
      presence: probed,
      rows: null,
      value: null,
      detail:
        `the presence query matched nothing on ${environment.name}, so the telemetry has never heard of this ` +
        'code path — wrong name, wrong application, or nothing instrumented. A signal cannot report clean ' +
        'while its presence query is silent.',
    };
  return null;
}

interface DryRunReading {
  verdict: WatchReadingVerdict;
  presence: WatchReadingVerdict | null;
  rows: number | null;
  detail: string | null;
  value: number | null;
}

function readingOf(environment: EnvironmentConfig, check: GoalWatch, result: WatchResult): DryRunReading {
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
  if (check.kind === 'measure')
    return { verdict, presence, rows: result.rows!.length, value: result.value, detail: null };
  if (scalarShaped(result.rows!))
    return {
      verdict,
      presence,
      rows: result.rows!.length,
      value: null,
      detail:
        `${environment.name} answered one row carrying one number, which is the shape of a query that ` +
        'aggregated: a signal answers with the matching rows themselves and the harness counts them, so this ' +
        'reads as exactly one occurrence however many there are. Return the rows rather than a count — ' +
        '"tolerate" is how many of them the harness may count.',
    };
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
  return { verdict, presence, rows: result.rows!.length, value: null, detail: null };
}

function verdictOf(result: WatchResult): WatchReadingVerdict {
  if (result.verdict === 'unknown' || result.rows === null) return 'unknown';
  return result.rows.length === 0 ? 'zero' : 'fires';
}

/**
 * The first environment that declares the check's source — or, for a check naming none, the first that
 * watches at all. Where none declares it, the first watched environment, which reads it `unknown` and
 * names the source it lacks.
 */
function dryRunEnvironment(environments: readonly EnvironmentConfig[], source: string | null): EnvironmentConfig {
  const watched = environments.filter((env) => watchSources(env.watch).length > 0);
  if (source === null) return watched[0]!;
  return watched.find((env) => watchSources(env.watch).some((s) => s.name === source)) ?? watched[0]!;
}
