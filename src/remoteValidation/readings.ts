import { copyFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { EnvironmentProber } from '../environments/prober.js';
import type { Store } from '../store/store.js';
import type { RemoteRun, RemoteSheetRow, ValidationCheck } from '../types.js';
import { validationGoalDir } from '../validation/resources.js';
import { handsBackAScreen, stepScript } from '../validation/steps.js';
import { remoteValidationRunDir } from './origin.js';
import { foldCapture, foldRowOutcome, parseRunReport, type RowOutcome, type RunReport } from './report.js';

// → docs/spec/36-remote-validation.md#the-report-is-the-only-source-of-row-outcomes

interface ReadingDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  prober: EnvironmentProber;
  /** Where a goal's validation directory is, which is where a capture outlives the run that took it. */
  validationRoot: string;
  errors?: ErrorRecorder;
  /** How the run's report file is read. Injected only so a test need not lay one on disk. */
  read?: (path: string) => Promise<string>;
  /** How a capture is moved out of the run's artefacts. Injected so a test lays no image on disk. */
  keep?: (from: string, to: string) => Promise<void>;
}

interface Settled {
  ok: true;
  run: RemoteRun;
  /** How many rows the report answered — passed or failed. */
  read: number;
  /** How many learned nothing, each of which writes on no check at all. */
  blocked: number;
  /** How many checks took a `spec` or `script` reading. Which of the two is on each row. */
  wrote: number;
  /** How many screens the run handed back for somebody to look at. */
  captured: number;
  /** The checks a run did not overwrite, because somebody else's reading is on them. */
  kept: string[];
  /** Whether the environment moved under the run, which is what the asymmetry cuts on. */
  moved: boolean;
}

interface Refused {
  ok: false;
  error: string;
}

/**
 * The one reader of a run's report, and the one writer of what it says. It is a desk rather than a
 * body in `src/mcp/tools/remoteValidationReport.ts` because the fold needs the environment's config
 * and its `at` command, which a tool module has no business holding: the tool stays an origin fence
 * and a parse call, `deps.state` and `deps.localValidations`' arrangement exactly.
 */
export class RemoteReadingDesk {
  private readonly read: (path: string) => Promise<string>;
  private readonly keep: (from: string, to: string) => Promise<void>;

  constructor(private readonly deps: ReadingDeps) {
    this.read = deps.read ?? ((path) => readFile(path, 'utf8'));
    this.keep =
      deps.keep ??
      (async (from, to) => {
        await mkdir(join(to, '..'), { recursive: true });
        await copyFile(from, to);
      });
  }

  /**
   * A handback writes **no readings**, leaves every row exactly as it was, and carries the agent's
   * reason to the operator. An agent that could not reach the environment has learned nothing about
   * the goal, and with only a report available its options would be a lie and silence.
   *
   * @public the seam `remote_validation_report` settles a run it could not carry out through
   */
  handback(runId: string, reason: string): { ok: true; run: RemoteRun } | Refused {
    const live = this.live(runId);
    if ('error' in live) return live;
    const ended = this.deps.store.remoteValidation.endRemoteRun(live.run.id, {
      status: 'abandoned',
      note: `The agent could not carry this run out: ${reason}`,
    });
    return { ok: true, run: ended ?? live.run };
  }

  /**
   * The report, folded into a reading per confirmed row and a `spec` reading on the checks those
   * rows stand for, and then the run settled. The deployed sha is read from `at` again here — the
   * start of it is already on the row — because a run that finished against a different build is
   * the thing [the asymmetry](docs/spec/36-remote-validation.md#the-environment-moved-asymmetry)
   * cuts on.
   *
   * @public the seam `remote_validation_report` settles a carried-out run through
   */
  async settle(runId: string, input: { reportPath: string; artefacts: string | null }): Promise<Settled | Refused> {
    const live = this.live(runId);
    if ('error' in live) return live;
    const { run } = live;
    const { store } = this.deps;
    const environment = this.deps.environments.find((e) => e.name === run.environment);

    const report = await this.report(input.reportPath);
    const endedSha = environment === undefined ? null : await this.deployedSha(environment);
    // An environment that moved **forward** still holds the goal's work; what the asymmetry is about
    // is a run that started against one build and finished against another, whichever way it went.
    const moved = run.startedSha !== null && endedSha !== null && endedSha !== run.startedSha;

    const rows = confirmedCheckRows(store.remoteValidation.listRemoteSheetRows(), run);
    const checks = new Map(store.validation.listValidationChecks(run.goalRef).map((check) => [check.id, check]));

    let read = 0;
    let blocked = 0;
    let wrote = 0;
    let captured = 0;
    const kept: string[] = [];

    for (const row of rows) {
      const check = checks.get(row.sourceId);
      if (check === undefined) continue;
      // Two instruments, and which one this row ran decides both what the report is read against and
      // what the reading is worth. A `suite` step's area selects reviewed code and is verified
      // against the pre-flight's listing; a one-off script has no listing — it was written for this
      // check — and reports under the check's own id. A check declaring both is read as a spec: the
      // reviewed instrument is the stronger evidence, and the two are never folded into one word.
      const instrument =
        check.area !== null ? ('spec' as const) : stepScript(check.steps) !== null ? ('script' as const) : null;
      // A `screenshot` step is neither: it asserts nothing, so it is not a third instrument and it
      // never decides what a reading is worth. A check that only hands a screen back still runs
      // here — this is the only channel with a browser and a tenant — and one that also asserts
      // hands its screen back beside the assertion.
      const screen = handsBackAScreen(check.steps);
      if (instrument === null && !screen) continue;
      const asserted =
        instrument === null
          ? null
          : this.moveAware(
              foldRowOutcome({
                environment: run.environment,
                area: instrument === 'spec' ? (check.area as string) : check.id,
                matched: row.matched,
                instrument,
                report,
              }),
              moved,
              run,
              endedSha,
            );
      const folded = screen ? await this.withScreen(run, check, asserted, report) : (asserted as RowOutcome);
      const settling =
        folded.outcome === 'blocked' ? null : this.writeCheck(run, check, folded, instrument, folded.capture ?? null);
      if (settling !== null && settling.kept !== null) kept.push(settling.kept);
      if (settling?.wrote === true) wrote += 1;
      if (settling?.wrote === true && folded.outcome === 'captured') captured += 1;

      store.remoteValidation.recordRemoteReading({
        goalRef: run.goalRef,
        environment: run.environment,
        rowId: row.rowId,
        runId: run.id,
        outcome: folded.outcome,
        rows: row.matched,
        value: null,
        detail: joined(folded.detail, settling?.kept ?? null),
        startedSha: run.startedSha,
        endedSha,
        executed: folded.executed,
        retries: folded.retries,
        durationMs: folded.durationMs,
        artefacts: input.artefacts,
      });
      if (folded.outcome === 'blocked') blocked += 1;
      else read += 1;
    }

    // Every reading this run took, the press's deterministic ones included, is attributed to the
    // commits it straddled: a reading with no commit beside it is a reading of a product nobody can
    // name, and only the end of the run knows what the second one was.
    store.remoteValidation.attributeRemoteReadings(run.id, endedSha);
    const ended = store.remoteValidation.endRemoteRun(run.id, {
      status: 'ended',
      endedSha,
      reportPath: input.reportPath,
      artefacts: input.artefacts,
    });
    return { ok: true, run: ended ?? run, read, blocked, wrote, captured, kept, moved };
  }

  /**
   * The row a `screenshot` step's check comes back as, once the screen it handed back is folded in
   * beside whatever else the row asserted. Three rules, and each is one this design already holds
   * somewhere else:
   *
   * - **A red the product earned is never withheld.** A row whose assertion failed stays `failed`,
   *   and the screen rides it as evidence for the failure rather than replacing it.
   * - **A screen that never arrived is `blocked`, even where the assertion passed.** Handing the
   *   screen back is the whole of what a `screenshot` step is for, so a run that came back without
   *   one has not carried the check out — and a `passed` here would be green about something else,
   *   which is the thing this reading exists to refuse.
   * - **Otherwise the row is `captured`**, never `passed`: nobody has looked yet, and a result is
   *   declared and never derived. → 20-validation.md#states
   */
  private async withScreen(
    run: RemoteRun,
    check: ValidationCheck,
    asserted: RowOutcome | null,
    report: RunReport,
  ): Promise<RowOutcome> {
    const base: RowOutcome = asserted ?? {
      outcome: 'captured',
      detail: null,
      executed: 0,
      retries: 0,
      durationMs: null,
    };
    const found = foldCapture(check.id, report);
    const kept = found.ok ? await this.keepCapture(run, check.id, found.capture) : found;
    if (!kept.ok) {
      if (asserted?.outcome === 'failed') return { ...asserted, detail: joined(asserted.detail, kept.detail) };
      return { ...base, outcome: 'blocked', detail: joined(asserted?.detail ?? null, kept.detail) };
    }
    const waiting = `A screen was handed back for somebody to look at: \`${kept.capture}\`.`;
    if (asserted?.outcome === 'failed')
      return { ...asserted, capture: kept.capture, detail: joined(asserted.detail, waiting) };
    return {
      ...base,
      outcome: 'captured',
      capture: kept.capture,
      detail: joined(asserted?.detail ?? null, `${waiting} Nothing here says it is right — a person judges that.`),
    };
  }

  /**
   * The screen, moved out of the run's artefacts and into the goal's validation directory. That move
   * is the whole difference between a capture and an artefact: the publish command's output is the
   * run's and is swept on the runner's own schedule, and an image somebody still has to look at
   * outlives the run that took it.
   *
   * The report names a **file name** and the harness decides both directories, so nothing a report
   * says can reach outside the run's artefacts or land anywhere but this goal's own directory. The
   * name it is kept under is the harness's too — the goal's directory also holds its resources, and
   * two checks that both handed back `screen.png` must not be one file.
   *
   * A copy that fails is not swallowed: it comes back as the row's own `blocked` reason, which is
   * where an operator reads it, rather than into the error log where nothing connects it to a check.
   */
  private async keepCapture(
    run: RemoteRun,
    checkId: string,
    name: string,
  ): Promise<{ ok: true; capture: string } | { ok: false; detail: string }> {
    const from = join(remoteValidationRunDir(this.deps.validationRoot, run.goalRef, run.id), 'artefacts', name);
    const capture = `capture-${slug(checkId)}-${slug(run.id)}${slug(extname(name))}`;
    try {
      await this.keep(from, join(validationGoalDir(this.deps.validationRoot, run.goalRef), capture));
      return { ok: true, capture };
    } catch (err) {
      return {
        ok: false,
        detail:
          `the report names \`${name}\` as the screen for \`${checkId}\`, and it could not be taken out of the ` +
          `run's artefacts — ${(err as Error).message}. There is nothing to look at, so this row is not a reading.`,
      };
    }
  }

  /**
   * **A failure is `blocked`. A pass is still a pass.** A run that started against one build and
   * finished against another cannot support a claim that the product is broken — the thing under
   * test changed underneath it — but it can perfectly well support the claim that a journey
   * completed, because it did. Treating both alike either discards good readings, starving any
   * project that deploys faster than it validates, or reports failures the code did not earn.
   */
  private moveAware(folded: RowOutcome, moved: boolean, run: RemoteRun, endedSha: string | null): RowOutcome {
    if (!moved || folded.outcome !== 'failed') return folded;
    return {
      ...folded,
      outcome: 'blocked',
      detail:
        `${folded.detail ?? 'the run reported a failure.'} ${run.environment} moved under this run — it started ` +
        `at ${short(run.startedSha)} and finished at ${short(endedSha)} — so nothing here can support a claim ` +
        'that the product is broken: the thing under test changed underneath the run. A pass across the same ' +
        'two commits would still have been a pass, because a journey that completed completed.',
    };
  }

  /**
   * **A run writes onto the check row only where the current reading is `unrun`, or was one this
   * instrument itself took.** A reading a person, an agent or a desktop session took is theirs, and
   * overwriting it with a machine's is the harness deciding it knows better than whoever watched the
   * thing happen. Where the check is settled by somebody else the row still runs, the reading still
   * lands on the sheet, and the sheet says whose reading it is not replacing.
   *
   * The predicate is the instrument's **own** attribution and not "a machine took it": a script must
   * not overwrite a reviewed spec's reading and a spec must not overwrite a script's, because the two
   * are never folded — an operator counting green rows would otherwise be told a throwaway and a
   * reviewed spec are the same evidence, by the one route that looks like tidying.
   *
   * A `blocked` row never reaches here at all: no reading was taken.
   */
  private writeCheck(
    run: RemoteRun,
    check: ValidationCheck,
    folded: RowOutcome,
    by: 'spec' | 'script' | null,
    capture: string | null,
  ): { wrote: boolean; kept: string | null } {
    // A row that only handed a screen back ran no instrument: nothing asserted, so there is nothing
    // to attribute to a reviewed suite or to a throwaway, and it is the fleet that took the picture.
    const took = by ?? 'agent';
    if (check.state !== 'unrun' && check.resultBy !== took)
      return {
        wrote: false,
        kept:
          `This is not written onto the goal's own check: it already reads \`${check.state}\`, recorded by ` +
          `${whose(check)}, and a reading somebody took is theirs. The sheet keeps this one instead.`,
      };
    this.deps.store.validation.recordValidationResult(run.goalRef, check.id, {
      state: folded.outcome === 'passed' ? 'passed' : folded.outcome === 'captured' ? 'captured' : 'failed',
      note: `${folded.detail ?? 'the run reported it.'} → the validation sheet for \`${run.environment}\`.`,
      by: took,
      ...(capture === null ? {} : { capture }),
    });
    return { wrote: true, kept: null };
  }

  private async report(path: string): Promise<RunReport> {
    try {
      return parseRunReport(await this.read(path));
    } catch (err) {
      return { tests: null, detail: `the report at \`${path}\` could not be opened — ${(err as Error).message}` };
    }
  }

  private async deployedSha(environment: EnvironmentConfig): Promise<string | null> {
    try {
      const head = await this.deps.prober.at(environment.name, environment.at);
      return head.commits?.[0] ?? null;
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `reading the closing commit of ${environment.name} failed: ${(err as Error).message}`,
      });
      return null;
    }
  }

  private live(runId: string): { run: RemoteRun } | Refused {
    const run = this.deps.store.remoteValidation.getRemoteRun(runId);
    if (run === null)
      return {
        ok: false,
        error: `Run "${runId}" is no longer on this goal's sheet. Nothing was recorded, and nothing more is needed from you on it.`,
      };
    if (run.status !== 'pending' && run.status !== 'dispatched')
      return {
        ok: false,
        error:
          `Run "${runId}" was already settled as ${run.status}${run.note === null ? '' : ` — ${run.note}`}. ` +
          'Nothing was recorded a second time.',
      };
    return { run };
  }
}

/** The rows this run is for: this sheet's `check` rows, selected and with nothing already blocking them. */
function confirmedCheckRows(rows: readonly RemoteSheetRow[], run: RemoteRun): RemoteSheetRow[] {
  return rows.filter(
    (row) =>
      row.goalRef === run.goalRef &&
      row.environment === run.environment &&
      row.kind === 'check' &&
      row.selected &&
      row.blockedReason === null,
  );
}

function whose(check: ValidationCheck): string {
  if (check.resultBy === 'operator') return 'a person who carried the steps out';
  if (check.resultBy === 'agent') return 'the fleet, unattended';
  if (check.resultBy === 'desktop') return 'the operator’s own Claude, at their keyboard';
  if (check.resultBy === 'spec') return 'the project’s own reviewed browser suite';
  if (check.resultBy === 'script') return 'a one-off script written for this check, which nobody reviewed';
  return 'somebody this build cannot name';
}

function joined(detail: string | null, kept: string | null): string | null {
  if (kept === null) return detail;
  return detail === null ? kept : `${detail} ${kept}`;
}

function short(sha: string | null): string {
  return sha === null ? 'a commit it would not name' : sha.slice(0, 7);
}

/** A name the harness wrote, made safe for a directory it also holds resources in. */
function slug(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-');
}
