import type { EnvironmentHead, EnvironmentProber } from './prober.js';

/**
 * A scripted prober: answers from a map keyed on the environment's name, and
 * "could not say" for anything unscripted — the honest default, since a probe
 * nobody has told where it is has not answered.
 *
 * The seam exists so no test spawns a shell. A test that let the real prober run
 * would be asserting on the machine's `sh`, its `git`, and whatever `LUBBDUBB_*`
 * the developer happened to export.
 */
export class FakeEnvironmentProber implements EnvironmentProber {
  /** Every environment asked, in order — what a test asserts the per-pulse cost with. */
  readonly asked: string[] = [];

  constructor(private readonly heads: Record<string, string[]> = {}) {}

  at(environment: string, _command: string): Promise<EnvironmentHead> {
    this.asked.push(environment);
    const commits = this.heads[environment];
    return Promise.resolve(commits === undefined ? { commits: null, detail: 'unscripted' } : { commits, detail: null });
  }
}
