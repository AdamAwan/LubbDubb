import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { DAY_MS } from '../primitives.js';
import type { Store } from '../store/store.js';
import { GROUP_RETENTION_DAYS, mergeGroup, readSince, retainedDays, spreadCounts } from './groups.js';
import type { AppErrorReader } from './reader.js';
import { errorsCommand } from './report.js';

// → docs/spec/39-app-errors.md#the-desk

interface AppErrorDeskDeps {
  store: Store;
  environments: EnvironmentConfig[];
  reader: AppErrorReader;
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
    const now = this.now();
    const read = await Promise.all(
      this.deps.environments.map(async (environment) => {
        try {
          return await this.read(environment, now);
        } catch (err) {
          this.deps.errors?.record({
            source: 'cycle',
            message: `reading the errors on ${environment.name} failed: ${(err as Error).message}`,
          });
          return false;
        }
      }),
    );
    if (!read.includes(true)) return;
    this.deps.store.appErrors.prune({
      dayBefore: retainedDays(now)[0]!,
      seenBefore: new Date(now - GROUP_RETENTION_DAYS * DAY_MS).toISOString(),
    });
  }

  private async read(environment: EnvironmentConfig, now: number): Promise<boolean> {
    const list = environment.errors?.list;
    if (list === undefined) return false;
    const { store, errors } = this.deps;
    const standing = store.appErrors.getRead(environment.name);
    if (standing !== null && Date.parse(standing.readAt) > now - this.deps.intervalMs) return false;
    const since = readSince(standing?.okAt ?? null, now);
    const report = await this.deps.reader.list({
      environment: environment.name,
      command: errorsCommand(list, since),
      since,
    });
    const readAt = new Date(now).toISOString();
    if (report.status === 'unknown') {
      store.appErrors.recordRead(
        { environment: environment.name, readAt, status: 'unknown', detail: report.detail },
        [],
      );
      return true;
    }
    if (report.refused.length > 0)
      errors?.record({
        source: 'cycle',
        message:
          `the errors command for ${environment.name} printed ${String(report.refused.length)} row(s) the ` +
          'contract refuses; they were left out of the reading',
        detail: report.refused.slice(0, 10).join('\n'),
      });
    const held = store.appErrors.groupMarks(environment.name);
    const groups = report.rows.map((row) => ({
      group: mergeGroup(held.get(row.fingerprint), environment.name, row),
      days: spreadCounts(row, since),
    }));
    const detail =
      report.dropped > 0
        ? `kept the ${String(report.rows.length)} most frequent groups; ${String(report.dropped)} more were left out`
        : null;
    store.appErrors.recordRead({ environment: environment.name, readAt, status: 'ok', detail }, groups);
    return true;
  }
}
