import { readFile } from 'node:fs/promises';
import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { EnvironmentProber } from '../environments/prober.js';
import type { Store } from '../store/store.js';
import type { RemoteRun, RemoteSheetRow, ValidationCheck } from '../types.js';
import { foldRowOutcome, parseRunReport, type RowOutcome, type RunReport } from './report.js';

// → docs/spec/36-remote-validation.md#the-report-is-the-only-source-of-row-outcomes

interface ReadingDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  prober: EnvironmentProber;
  errors?: ErrorRecorder;
  /** How the run's report file is read. Injected only so a test need not lay one on disk. */
  read?: (path: string) => Promise<string>;
}

interface Settled {
  ok: true;
  run: RemoteRun;
  /** How many rows the report answered — passed or failed. */
  read: number;
  /** How many learned nothing, each of which writes on no check at all. */
  blocked: number;
  /** How many checks took a `spec` reading. */
  wrote: number;
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

  constructor(private readonly deps: ReadingDeps) {
    this.read = deps.read ?? ((path) => readFile(path, 'utf8'));
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
    const ended = this.deps.store.endRemoteRun(live.run.id, {
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

    const rows = confirmedCheckRows(store.listRemoteSheetRows(), run);
    const checks = new Map(store.listValidationChecks(run.goalRef).map((check) => [check.id, check]));

    let read = 0;
    let blocked = 0;
    let wrote = 0;
    const kept: string[] = [];

    for (const row of rows) {
      const check = checks.get(row.sourceId);
      const area = check?.area ?? null;
      if (check === undefined || area === null) continue;
      const folded = this.moveAware(
        foldRowOutcome({ environment: run.environment, area, matched: row.matched, report }),
        moved,
        run,
        endedSha,
      );
      const settling = folded.outcome === 'blocked' ? null : this.writeCheck(run, check, folded);
      if (settling !== null && settling.kept !== null) kept.push(settling.kept);
      if (settling?.wrote === true) wrote += 1;

      store.recordRemoteReading({
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
    store.attributeRemoteReadings(run.id, endedSha);
    const ended = store.endRemoteRun(run.id, {
      status: 'ended',
      endedSha,
      reportPath: input.reportPath,
      artefacts: input.artefacts,
    });
    return { ok: true, run: ended ?? run, read, blocked, wrote, kept, moved };
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
   * **A run writes onto the check row only where the current reading is `unrun`, or was itself a
   * `spec` reading.** A reading a person, an agent or a desktop session took is theirs, and
   * overwriting it with a spec's is the harness deciding it knows better than whoever watched the
   * thing happen. Where the check is settled by somebody else the row still runs, the reading still
   * lands on the sheet, and the sheet says whose reading it is not replacing.
   *
   * A `blocked` row never reaches here at all: no reading was taken.
   */
  private writeCheck(
    run: RemoteRun,
    check: ValidationCheck,
    folded: RowOutcome,
  ): { wrote: boolean; kept: string | null } {
    if (check.state !== 'unrun' && check.resultBy !== 'spec')
      return {
        wrote: false,
        kept:
          `This is not written onto the goal's own check: it already reads \`${check.state}\`, recorded by ` +
          `${whose(check)}, and a reading somebody took is theirs. The sheet keeps this one instead.`,
      };
    this.deps.store.recordValidationResult(run.goalRef, check.id, {
      state: folded.outcome === 'passed' ? 'passed' : 'failed',
      note: `${folded.detail ?? 'the run reported it.'} → the validation sheet for \`${run.environment}\`.`,
      by: 'spec',
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
    const run = this.deps.store.getRemoteRun(runId);
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
  return 'somebody this build cannot name';
}

function joined(detail: string | null, kept: string | null): string | null {
  if (kept === null) return detail;
  return detail === null ? kept : `${detail} ${kept}`;
}

function short(sha: string | null): string {
  return sha === null ? 'a commit it would not name' : sha.slice(0, 7);
}
