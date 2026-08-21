import type { EnvironmentGate } from '../types.js';

/**
 * One environment a goal's landed work travels to, how to ask where it has got
 * to, and what arriving there means.
 * → `docs/spec/24-environments.md#configuring-an-environment`
 */
export interface EnvironmentConfig {
  /**
   * What the operator calls it — `testUk`, `liveEu`, `prod`. It is the display
   * label *and* the key every reading and arrival is stored against, so renaming
   * one discards what was known about it rather than migrating it.
   */
  name: string;
  /**
   * The command that prints the commit (or commits) this environment is **at**,
   * run in a shell in `repoRoot` with `LUBBDUBB_ENVIRONMENT` set.
   *
   * Not "does it have this commit": that question costs a process spawn per
   * landing per environment per pulse, and this one is asked once per environment
   * however many goals are in flight. Nothing about a commit is passed *in*, so
   * there is no placeholder for an operator's command to have never learned about
   * — the harness answers every landing from the output, locally.
   * → {@link CommandEnvironmentProber}
   */
  at: string;
  /** What arriving here means. Absent = the environment is observed and nothing more. */
  arrival?: EnvironmentArrival;
}

/** The obligations an arrival may open — see {@link EnvironmentGate}. */
const ENVIRONMENT_GATES: readonly EnvironmentGate[] = ['validate', 'close_out'];

/** What arriving at one environment does. → `docs/spec/24-environments.md#what-an-arrival-means` */
interface EnvironmentArrival {
  /**
   * Which delivered-goal obligations arriving here opens. Declared on more than
   * one environment, the gate is satisfied by whichever the goal reaches first —
   * two acceptance environments are two entries, not a ranking.
   */
  opens?: EnvironmentGate[];
  /** Post one comment on the goal's ticket when its whole work arrives here. */
  comment?: boolean;
}

/**
 * Refuse a list that cannot mean what it says.
 *
 * Every failure here is otherwise silent in the same direction: a nameless entry
 * stores its readings under `""`, a duplicate name has two commands writing over
 * one key, and an empty command names no commit at all — which under the old
 * exit-code contract reported *every* goal as shipped, and under this one reports
 * every goal as unknown, forever.
 */
export function validateEnvironments(environments: EnvironmentConfig[]): void {
  if (!Array.isArray(environments))
    throw new Error('environments: must be a list of {name, at} entries — one per environment to probe.');
  const seen = new Set<string>();
  environments.forEach((env, i) => {
    const where = `environments[${i}]`;
    if (typeof env.name !== 'string' || env.name.trim() === '')
      throw new Error(`${where}: "name" must be a non-empty name — it is the key every reading is stored against.`);
    if (seen.has(env.name))
      throw new Error(
        `${where}: "${env.name}" is declared twice. Readings are keyed on the name, so the second command would ` +
          "overwrite the first's answers rather than adding an environment.",
      );
    seen.add(env.name);
    // Named rather than ignored. `command` was the previous key and asked a
    // different question, so a file carrying it would otherwise load with an
    // environment that never answers anything — the exact silence the three
    // verdicts exist to prevent.
    if ('command' in env)
      throw new Error(
        `${where} ("${env.name}"): "command" is no longer read. An environment now names the commit it is *at* — ` +
          'replace it with "at", a command printing the deployed commit, and the harness answers every landing from it.',
      );
    if (typeof env.at !== 'string' || env.at.trim() === '')
      throw new Error(
        `${where} ("${env.name}"): "at" must be a non-empty command printing the commit this environment is at. ` +
          'An empty one names nothing, which leaves every goal unanswered forever.',
      );
    validateArrival(env.arrival, `${where} ("${env.name}")`);
  });
}

function validateArrival(arrival: EnvironmentArrival | undefined, where: string): void {
  if (arrival === undefined) return;
  if (typeof arrival !== 'object' || arrival === null || Array.isArray(arrival))
    throw new Error(`${where}: "arrival" must be an object — {"opens": [...], "comment": true}.`);
  if (arrival.comment !== undefined && typeof arrival.comment !== 'boolean')
    throw new Error(`${where}: "arrival.comment" must be true or false.`);
  if (arrival.opens !== undefined) {
    if (!Array.isArray(arrival.opens))
      throw new Error(`${where}: "arrival.opens" must be a list of ${ENVIRONMENT_GATES.join(' / ')}.`);
    // An empty list reads as a gate and gates nothing — the shape most likely to
    // be written by somebody who meant one and left it for later.
    if (arrival.opens.length === 0)
      throw new Error(
        `${where}: "arrival.opens" is empty. It reads as a gate and opens nothing — drop it, or name ` +
          `${ENVIRONMENT_GATES.join(' / ')}.`,
      );
    for (const gate of arrival.opens)
      if (!ENVIRONMENT_GATES.includes(gate))
        throw new Error(
          `${where}: "${String(gate)}" is not an obligation the harness files. ` +
            `"arrival.opens" names ${ENVIRONMENT_GATES.join(' / ')}.`,
        );
  }
  // An arrival block that opens nothing and says nothing is a declaration its
  // author meant to finish. Refused rather than ignored, for `opens: []`'s reason.
  if (arrival.opens === undefined && arrival.comment !== true)
    throw new Error(
      `${where}: "arrival" declares nothing. Name what arriving here opens, or set "comment": true — or drop it, ` +
        'and the environment is observed and nothing more.',
    );
}
