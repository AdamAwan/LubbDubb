import type { EnvironmentProber, EnvironmentVerdict } from './prober.js';

/**
 * A scripted prober: answers from a map keyed `"<environment> <sha>"`, and
 * `unknown` for anything unscripted — the honest default, since a probe that has
 * not been told about a commit has not answered about it.
 *
 * The seam exists so no test spawns a shell. A test that let the real prober run
 * would be asserting on the machine's `sh`, its `git`, and whatever `LUBBDUBB_*`
 * the developer happened to export.
 */
export class FakeEnvironmentProber implements EnvironmentProber {
  /** Every `(environment, sha)` asked about, in order — what a test asserts the cap and the interval with. */
  readonly asked: string[] = [];

  constructor(private readonly answers: Record<string, EnvironmentVerdict> = {}) {}

  reached(environment: string, _command: string, sha: string): Promise<EnvironmentVerdict> {
    const key = `${environment} ${sha}`;
    this.asked.push(key);
    return Promise.resolve(this.answers[key] ?? { status: 'unknown', detail: 'unscripted' });
  }
}
