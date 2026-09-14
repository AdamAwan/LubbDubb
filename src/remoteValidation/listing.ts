import { readFile } from 'node:fs/promises';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { RemoteRun, RemoteSheetRow } from '../types.js';
import { preflightRows } from './preflight.js';
import { parseSelectorListing, type SelectorListing } from './runner.js';

// → docs/spec/36-remote-validation.md#the-report-is-the-only-source-of-row-outcomes

interface ListingDeps {
  store: Store;
  errors?: ErrorRecorder;
  /** How the run's listing file is read. Injected only so a test need not lay one on disk. */
  read?: (path: string) => Promise<string>;
}

interface Taken {
  ok: true;
  run: RemoteRun;
  /** The selectors that survived, which are the ones the agent invokes the runner with. */
  selectors: string[];
  /** How many `check` rows the listing blocked, each carrying its reason as a reading. */
  blocked: number;
}

interface Refused {
  ok: false;
  error: string;
}

/**
 * The one reader of a run's selector listing, and the one writer of `matched`.
 *
 * The listing is taken by the run agent in its **pinned** checkout, so the denominator describes the
 * commit the environment is running rather than whichever one the harness's own clone stands on. The
 * agent hands back a **path** and the harness parses it: a path says where a file is and not what is
 * in it, which is the whole of why a denominator can come through an agent at all.
 *
 * A reason the listing found is written as a **`blocked` reading** against the run, never as the
 * row's `blockedReason`. A `blockedReason` is a cause no press can overcome, and every reason here is
 * amendable — a reworded area, a restored spec — so writing one from a run would make an amendable
 * mismatch permanently unpressable.
 */
export class RemoteListingDesk {
  private readonly read: (path: string) => Promise<string>;

  constructor(private readonly deps: ListingDeps) {
    this.read = deps.read ?? ((path) => readFile(path, 'utf8'));
  }

  /**
   * @public the seam `remote_validation_listing` reports the runner's own listing through
   */
  async take(runId: string, listingPath: string): Promise<Taken | Refused> {
    const live = this.live(runId);
    if ('error' in live) return live;
    let text: string;
    try {
      text = await this.read(listingPath);
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `the listing for remote run ${runId} could not be read: ${(err as Error).message}`,
      });
      return {
        ok: false,
        error:
          `The listing at \`${listingPath}\` could not be opened — ${(err as Error).message}. Nothing was ` +
          'recorded and every row is exactly as it was. Write the listing command’s output to a file inside ' +
          'the run’s own directory and call again with that path, or give "blocked" and the reason instead.',
      };
    }
    return this.fold(live.run, parseSelectorListing(text), listingPath);
  }

  /**
   * A listing nobody could take. Every `check` row it would have answered for blocks with the agent's
   * reason, exactly as an unanswerable listing does, and the run itself is left open: a run may still
   * owe a one-off script or a screen, neither of which a listing has anything to say about.
   *
   * @public the seam `remote_validation_listing` hands a listing it could not take back through
   */
  blocked(runId: string, reason: string): Taken | Refused {
    const live = this.live(runId);
    if ('error' in live) return live;
    return this.fold(live.run, { offers: null, detail: reason }, null);
  }

  private fold(run: RemoteRun, listing: SelectorListing, listingPath: string | null): Taken {
    const { store } = this.deps;
    const rows = confirmedCheckRows(store.remoteValidation.listRemoteSheetRows(), run);
    const checks = store.validation.listValidationChecks(run.goalRef);
    const verdicts = preflightRows({ environment: run.environment, rows, checks, listing });

    store.remoteValidation.recordRemoteMatched(
      run.goalRef,
      run.environment,
      verdicts.map(({ rowId, matched }) => ({ rowId, matched })),
    );

    let blocked = 0;
    for (const verdict of verdicts) {
      if (verdict.blockedReason === null) continue;
      blocked += 1;
      store.remoteValidation.recordRemoteReading({
        goalRef: run.goalRef,
        environment: run.environment,
        rowId: verdict.rowId,
        runId: run.id,
        outcome: 'blocked',
        rows: verdict.matched,
        value: null,
        detail: verdict.blockedReason,
        startedSha: run.startedSha,
        endedSha: null,
        executed: null,
        retries: null,
        durationMs: null,
        artefacts: null,
      });
    }
    if (listingPath !== null) store.remoteValidation.recordRemoteListingPath(run.id, listingPath);

    const survived = new Set(verdicts.filter((v) => v.blockedReason === null).map((v) => v.rowId));
    const areas = new Map(checks.map((check) => [check.id, check.area]));
    const selectors: string[] = [];
    for (const row of rows) {
      if (!survived.has(row.rowId)) continue;
      const area = areas.get(row.sourceId) ?? null;
      if (area !== null && !selectors.includes(area)) selectors.push(area);
    }
    return { ok: true, run, selectors, blocked };
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
          'Nothing was recorded, and a listing taken after the run ended answers for nothing.',
      };
    return { run };
  }
}

/** The rows a listing is asked about: this run's `check` rows, selected and nothing already blocking them. */
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
