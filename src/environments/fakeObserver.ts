import type { EnvironmentObservationRequest, EnvironmentObserver } from './observer.js';
import { parseWatchResult, unanswered, WATCH_ID_COLUMN, type WatchResult } from './watchResult.js';

/**
 * A scripted observer: answers with whatever stdout a test scripted for
 * `<checkId>:<kind>`, and "could not say" for anything unscripted — the honest
 * default, since an environment nobody has told what to answer has not answered.
 *
 * It scripts the command's **output**, not the parsed result, so a test goes
 * through the real {@link parseWatchResult} and the real echo check. Scripting the
 * verdict instead would leave the one guard this subsystem turns on untested at
 * every seam that matters.
 *
 * The seam exists so no test spawns a shell. A test that let the real observer run
 * would be asserting on the machine's `sh` and on whatever telemetry credential
 * the developer happened to have.
 */
export class FakeEnvironmentObserver implements EnvironmentObserver {
  /** Every question asked, in order — what a test asserts the per-goal cost with. */
  readonly asked: { environment: string; checkId: string; kind: string; query: string }[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    const { environment, checkId, kind, query } = request;
    this.asked.push({ environment, checkId, kind, query });
    const stdout = this.output[`${checkId}:${kind}`];
    if (stdout === undefined) return Promise.resolve(unanswered('unscripted'));
    return Promise.resolve(parseWatchResult(stdout, checkId, kind));
  }
}

/** One scripted row, with the echo the harness's projection would have added. Saves every test writing it. */
export function watchRow(checkId: string, row: Record<string, string | number> = {}): Record<string, unknown> {
  return { ...row, [WATCH_ID_COLUMN]: checkId };
}
