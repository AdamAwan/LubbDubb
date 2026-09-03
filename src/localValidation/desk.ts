import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import type { LocalRun, LocalValidation, LocalValidationFinding, Task } from '../types.js';
import { localValidationOriginParts, localValidationOutputDir } from './origin.js';
import { localValidationIsOpen, validationRunStale } from './stale.js';

interface DeskEvents {
  changed: [];
}

interface LocalValidationDeskDeps {
  store: Store;
  validationRoot: string;
  errors: ErrorRecorder;
}

/** Image files are what a screenshot is; anything else the browser dropped is not drawn. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;

/**
 * The one owner of every `local_validations` write, and of the question every
 * writer has to ask first: is the environment this reading was planned against
 * still the one that is up.
 *
 * A desk rather than a set of functions on the routes and the tools, because four
 * things end a row — the agent reporting, the operator calling it off, the pulse
 * noticing a dead agent, and the environment going away — and three of them are not
 * in the caller's hands. Collecting them means the sweep and the report ask
 * `validationRunStale` in one place and the store's `WHERE status IN (open)` guards
 * settle the race between them.
 *
 * It emits `changed`, which the hub turns into one `dirty` — the plan landing while
 * the environment is still coming up is the whole reason the goal's page updates
 * mid-run rather than at the end. Named `changed` and never `error`, for the reason
 * `errorLog` states: an unlistened `error` event throws.
 */
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

  /** Where this row's screenshots go — the same answer the dispatch gave the browser. */
  outputDir(row: LocalValidation): string {
    return localValidationOutputDir(this.deps.validationRoot, row.originRef, row.id);
  }

  /**
   * Record a request against the run that is up, and make the directory its
   * screenshots will land in.
   *
   * The directory is made **here** rather than by the browser, because the browser
   * is handed the path as a command-line flag before it has anything to write: a
   * server that starts by failing to write into a directory nobody created is a
   * launch that fails for a reason the agent cannot diagnose. A failure to make it
   * is recorded and not thrown — the validation is still worth running without
   * pictures.
   */
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

  /** The goal's row if it is still open, for the route's "one at a time" refusal. */
  open(originRef: string): LocalValidation | null {
    const row = this.deps.store.latestLocalValidation(originRef);
    return row !== null && localValidationIsOpen(row) ? row : null;
  }

  /** Call one off. The operator's own answer, and the only one that needs no reason. */
  cancel(originRef: string): LocalValidation | null {
    const row = this.open(originRef);
    if (row === null) return null;
    const settled = this.deps.store.abandonLocalValidation(row.id, 'called off from the cockpit');
    if (settled !== null) this.emit('changed');
    return settled;
  }

  /**
   * Record the test plan an agent wrote before the environment was up.
   *
   * Fenced on the origin, so only the agent dispatched for *this* row can write to
   * it — the fence every tool in the feature shares, and the reason it is resolved
   * from the dispatch rather than passed as an argument.
   */
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

  /**
   * Record what the agent saw, or refuse because the environment moved under it.
   *
   * The refusal is the whole correctness of the feature, and it is deliberately
   * **not** applied to `blocked`: a blocked report says the environment could not be
   * reached, which is a statement about the run rather than a reading against the
   * code, and an agent that spent its turn discovering the environment had gone must
   * be able to say so. `passed` and `failed` are readings, and a reading of a
   * checkout nobody asked about is worse than no reading at all.
   */
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

  /**
   * Settle every open row that will never be answered.
   *
   * Two arms, and the second is the one nothing else covers: an agent that crashed,
   * was killed or spent its stall park leaves a `dispatched` row nobody will ever
   * report against, and without this the goal's control stays absent forever
   * because a validation is apparently still in flight.
   *
   * Called once a pulse **and** on every `changed` from the runner, so a stop or a
   * swap settles the row at the moment it happens rather than up to a heartbeat
   * later — the operator who just swapped the environment is looking at the page.
   */
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
        // A row whose task has gone entirely is left alone: the task table is the
        // one that would have been pruned, and abandoning a validation because its
        // audit row was tidied away would settle a run that is very possibly fine.
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

  /**
   * The pictures in this row's directory.
   *
   * Read off the disk at report time rather than taken from the agent's own list,
   * because the two can disagree and only one of them can be served: a name the
   * agent invented draws a broken image, and a file it saved and forgot to mention
   * is one the operator would never see. The directory is per validation, so
   * everything in it belongs to this row.
   */
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

  /** The row a dispatch is for, refused by name for any other caller. */
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
