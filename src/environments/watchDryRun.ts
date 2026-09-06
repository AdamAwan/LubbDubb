import type { Store } from '../store/store.js';
import type { GoalWatch, WatchReadingVerdict } from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import type { EnvironmentObserver } from './observer.js';
import type { WatchResult } from './watchResult.js';

// → docs/spec/24-environments.md

export interface WatchDryRunner {
  run(originRef: string): Promise<string[]>;
}

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
    return { verdict, presence, rows: result.rows!.length, value: null, detail: null };
  }
}

function verdictOf(result: WatchResult): WatchReadingVerdict {
  if (result.verdict === 'unknown' || result.rows === null) return 'unknown';
  return result.rows.length === 0 ? 'zero' : 'fires';
}

function dryRunEnvironment(environments: readonly EnvironmentConfig[]): EnvironmentConfig | null {
  return environments.find((env) => env.watch !== undefined && env.watch.observe.trim() !== '') ?? null;
}
