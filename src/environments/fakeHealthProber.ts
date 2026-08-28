import { parseHealthReport, unreadable, type EnvironmentHealthReport } from './health.js';
import type { EnvironmentHealthProber } from './healthProber.js';

/**
 * A scripted health prober: answers with whatever stdout a test scripted for an
 * environment's name, and "could not say" for anything unscripted — the honest
 * default, since a check nobody has told what to answer has not answered.
 *
 * It scripts the command's **output**, not the parsed report, so a test goes
 * through the real {@link parseHealthReport}. Scripting the verdict instead would
 * leave the whole output contract untested at every seam that matters.
 *
 * The seam exists so no test spawns a shell. A test that let the real prober run
 * would be asserting on the machine's `sh` and on whatever `LUBBDUBB_*` the
 * developer happened to have exported.
 */
export class FakeEnvironmentHealthProber implements EnvironmentHealthProber {
  /** Every environment asked, in order — what a test asserts the per-pulse cost with. */
  readonly asked: string[] = [];

  constructor(private readonly output: Record<string, string> = {}) {}

  check(environment: string, _command: string): Promise<EnvironmentHealthReport> {
    this.asked.push(environment);
    const stdout = this.output[environment];
    if (stdout === undefined) return Promise.resolve(unreadable('unscripted'));
    return Promise.resolve(parseHealthReport(stdout));
  }
}
