import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { EnvironmentProber } from '../environments/prober.js';
import type { Store } from '../store/store.js';
import {
  DAY_MS,
  GROUP_RETENTION_DAYS,
  RETENTION_DAYS,
  dayOf,
  mergeGroup,
  nextDeploy,
  readSince,
  spreadCounts,
  type AppErrorGroupWrite,
} from './groups.js';
import type { AppErrorReader } from './reader.js';
import { errorsCommand } from './report.js';

// → docs/spec/39-app-errors.md#the-desk

interface AppErrorDeskDeps {
  store: Store;
  environments: EnvironmentConfig[];
  reader: AppErrorReader;
  prober: EnvironmentProber;
  intervalMs: number;
  errors?: ErrorRecorder;
  now?: () => number;
}

export class AppErrorDesk {
  private readonly now: () => number;

  constructor(private readonly deps: AppErrorDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async run(): Promise<void> {
    for (const environment of this.deps.environments) {
      if (environment.errors === undefined) continue;
      try {
        await this.read(environment, environment.errors.list);
      } catch (err) {
        this.deps.errors?.record({
          source: 'cycle',
          message: `reading the errors on ${environment.name} failed: ${(err as Error).message}`,
        });
      }
    }
  }

  private async read(environment: EnvironmentConfig, list: string): Promise<void> {
    const { store, errors } = this.deps;
    const now = this.now();
    const standing = store.appErrors.listReads().find((r) => r.environment === environment.name);
    if (standing !== undefined && Date.parse(standing.readAt) > now - this.deps.intervalMs) return;
    const since = readSince(standing?.okAt ?? null, now);
    const head = await this.deps.prober.at(environment.name, environment.at);
    const report = await this.deps.reader.list({
      environment: environment.name,
      command: errorsCommand(list, since),
      since,
    });
    const at = new Date(now).toISOString();
    const deploy = nextDeploy(standing, head.commits, at);
    const prune = {
      dayBefore: dayOf(now - RETENTION_DAYS * DAY_MS),
      seenBefore: new Date(now - GROUP_RETENTION_DAYS * DAY_MS).toISOString(),
    };
    if (report.status === 'unknown') {
      store.appErrors.recordRead(
        { environment: environment.name, at, status: 'unknown', detail: report.detail, ...deploy },
        [],
        prune,
      );
      return;
    }
    if (report.refused.length > 0)
      errors?.record({
        source: 'cycle',
        message:
          `the errors command for ${environment.name} printed ${String(report.refused.length)} row(s) the ` +
          'contract refuses; they were left out of the reading',
        detail: report.refused.slice(0, 10).join('\n'),
      });
    const held = new Map<string, AppErrorGroupWrite>(
      store.appErrors.listGroups(environment.name).map((g) => [g.fingerprint, g]),
    );
    const groups = report.rows.map((row) => ({
      group: mergeGroup(held.get(row.fingerprint), environment.name, row, at),
      days: spreadCounts(row, since),
    }));
    const detail =
      report.dropped > 0
        ? `kept the ${String(report.rows.length)} most frequent groups; ${String(report.dropped)} more were left out`
        : null;
    store.appErrors.recordRead({ environment: environment.name, at, status: 'ok', detail, ...deploy }, groups, prune);
  }
}
