import type { Store } from '../store/store.js';
import type { GoalWatch, WatchReadingVerdict } from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import type { EnvironmentObserver } from './observer.js';
import { scalarShaped, unanswered, type WatchPeriod, type WatchResult } from './watchResult.js';
import { carriesUntil, missingUntilRefusal } from '../validation/watchQueryShape.js';
import { watchWindowMs } from './watchWindow.js';
import { goalMergedAt } from './landings.js';
import { resolveWatchSource, watchSources } from './watchSource.js';

// → docs/spec/24-environments.md

export interface WatchDryRunner {
  run(originRef: string): Promise<string[]>;
}

interface WatchDryRunDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
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
    const checks = this.deps.store.watches.listGoalWatches().filter((c) => c.originRef === originRef);
    const merged = goalMergedAt(this.deps.store.environments.listGoalLandings(), originRef);
    const refusals: string[] = [];
    for (const check of checks) {
      const environment = dryRunEnvironment(this.deps.environments, check.source);
      const reading =
        merged !== null && check.kind === 'measure' && !carriesUntil(check.query)
          ? readingOf(environment, check, unanswered(missingUntilRefusal()))
          : await this.read(environment, check, this.period(environment, merged));
      this.deps.store.watches.recordWatchDryRun(originRef, check.id, { environment: environment.name, ...reading });
      if (reading.detail !== null) refusals.push(`${check.id}: ${reading.detail}`);
    }
    return refusals;
  }

  private period(environment: EnvironmentConfig, merged: number | null): WatchPeriod {
    const until = merged ?? this.now();
    return { since: new Date(until - watchWindowMs(environment)).toISOString(), until: new Date(until).toISOString() };
  }

  private async read(environment: EnvironmentConfig, check: GoalWatch, period: WatchPeriod): Promise<DryRunReading> {
    const resolved = resolveWatchSource(environment, check);
    if (resolved.source === null)
      return { verdict: 'unknown', presence: null, rows: null, value: null, detail: resolved.refusal };
    const ask = {
      environment: environment.name,
      command: resolved.source.observe,
      source: resolved.source.name,
      language: resolved.source.language,
      checkId: check.id,
      ...period,
    };
    if (check.presence !== null) {
      const probe = await this.deps.observer.observe({ ...ask, query: check.presence, kind: 'presence' });
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
      ...ask,
      query: check.query,
      kind: check.kind === 'measure' ? 'measure' : 'signal',
    });
    return readingOf(environment, check, result);
  }
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
