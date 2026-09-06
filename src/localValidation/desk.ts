import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import type { LocalRun, LocalValidation, LocalValidationFinding, Task } from '../types.js';
import { localValidationOriginParts, localValidationOutputDir } from './origin.js';
import { localValidationIsOpen, validationRunStale } from './stale.js';

// → docs/spec/32-local-validation.md

interface DeskEvents {
  changed: [];
}

interface LocalValidationDeskDeps {
  store: Store;
  validationRoot: string;
  errors: ErrorRecorder;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;

export class LocalValidationDesk extends EventEmitter {
  constructor(private readonly deps: LocalValidationDeskDeps) {
    super();
  }

  override emit<K extends keyof DeskEvents>(event: K, ...args: DeskEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof DeskEvents>(event: K, listener: (...args: DeskEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  outputDir(row: LocalValidation): string {
    return localValidationOutputDir(this.deps.validationRoot, row.originRef, row.id);
  }

  request(input: { originRef: string; run: LocalRun }): LocalValidation {
    const row = this.deps.store.createLocalValidation({
      originRef: input.originRef,
      runId: input.run.id,
      ref: input.run.ref,
      commit: input.run.commit,
    });
    try {
      mkdirSync(this.outputDir(row), { recursive: true });
    } catch (err) {
      this.deps.errors.record({
        source: 'cycle',
        message: `Could not create the screenshot directory for a local validation of ${input.originRef}: ${(err as Error).message}`,
      });
    }
    this.emit('changed');
    return row;
  }

  open(originRef: string): LocalValidation | null {
    const row = this.deps.store.latestLocalValidation(originRef);
    return row !== null && localValidationIsOpen(row) ? row : null;
  }

  cancel(originRef: string): LocalValidation | null {
    const row = this.open(originRef);
    if (row === null) return null;
    const settled = this.deps.store.abandonLocalValidation(row.id, 'called off from the cockpit');
    if (settled !== null) this.emit('changed');
    return settled;
  }

  recordPlan(task: Task, plan: string): { ok: true } | { ok: false; error: string } {
    const target = this.resolve(task);
    if (!target.ok) return target;
    if (!localValidationIsOpen(target.row))
      return {
        ok: false,
        error: `This validation is already ${target.row.status} — ${target.row.note ?? 'it was settled while you were working'}. Nothing was recorded.`,
      };
    this.deps.store.setLocalValidationPlan(target.row.id, plan);
    this.emit('changed');
    return { ok: true };
  }

  report(
    task: Task,
    result: {
      status: 'passed' | 'failed' | 'blocked';
      summary: string;
      findings: LocalValidationFinding[];
      visited: string[];
    },
  ): { ok: true; row: LocalValidation } | { ok: false; error: string } {
    const target = this.resolve(task);
    if (!target.ok) return target;
    const { row } = target;
    if (result.status !== 'blocked') {
      const stale = validationRunStale(row, this.deps.store.liveLocalRun());
      if (stale !== null)
        return {
          ok: false,
          error:
            `Nothing was recorded: ${stale}. A pass or a failure has to be a reading of the code you planned ` +
            `against, and it is no longer what is running. Report "blocked" with what you did manage to see.`,
        };
    }
    const written = this.deps.store.recordLocalValidationReport(row.id, {
      status: result.status,
      summary: result.summary,
      findings: result.findings,
      visited: result.visited,
      screenshots: this.screenshots(row),
      note: result.status === 'blocked' ? result.summary : null,
    });
    if (written === null)
      return {
        ok: false,
        error: 'This validation was already settled while you were working, so nothing was recorded.',
      };
    this.emit('changed');
    return { ok: true, row: written };
  }

  sweep(): void {
    try {
      const live = this.deps.store.liveLocalRun();
      for (const row of this.deps.store.listOpenLocalValidations()) {
        const stale = validationRunStale(row, live);
        if (stale !== null) {
          if (this.deps.store.abandonLocalValidation(row.id, stale) !== null) this.emit('changed');
          continue;
        }
        if (row.status !== 'dispatched' || row.taskId === null) continue;
        const task = this.deps.store.getTask(row.taskId);
        if (task === null || isActiveTask(task)) continue;
        if (
          this.deps.store.abandonLocalValidation(
            row.id,
            'the agent running it ended without reporting — its transcript says what happened',
          ) !== null
        )
          this.emit('changed');
      }
    } catch (err) {
      this.deps.errors.record({
        source: 'cycle',
        message: `The local validation sweep failed: ${(err as Error).message}`,
      });
    }
  }

  private screenshots(row: LocalValidation): string[] {
    const dir = this.outputDir(row);
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && IMAGE.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      this.deps.errors.record({
        source: 'cycle',
        message: `Could not read the screenshots of a local validation of ${row.originRef}: ${(err as Error).message}`,
      });
      return [];
    }
  }

  private resolve(task: Task): { ok: true; row: LocalValidation } | { ok: false; error: string } {
    const parts = localValidationOriginParts(task.originRef);
    if (parts === null)
      return {
        ok: false,
        error:
          'This tool belongs to a local validation, and you were not dispatched for one. Which validation a ' +
          'report is about is settled by what you were sent to do, so there is nothing here for you to write to.',
      };
    const row = this.deps.store.getLocalValidation(parts.id);
    if (row === null) return { ok: false, error: 'The validation you were dispatched for no longer exists.' };
    return { ok: true, row };
  }
}
