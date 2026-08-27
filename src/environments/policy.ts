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
  /**
   * How this environment's telemetry is asked a declared question, once a goal's
   * work has arrived here. Absent = the environment is observed for reach and
   * nothing more, and no goal draws a watch surface for it.
   * → `docs/spec/29-post-deploy-watch.md#configuring-an-environment`
   */
  watch?: EnvironmentWatch;
}

/**
 * The telemetry half of one environment.
 *
 * An environment's telemetry is a **command**, exactly as its deployed commit is:
 * the harness ships no SDK and holds no opinion about what answers it.
 * → {@link CommandEnvironmentObserver}
 */
interface EnvironmentWatch {
  /**
   * The command that answers a declared query, run in a shell in `repoRoot` with
   * `LUBBDUBB_ENVIRONMENT`, `LUBBDUBB_WATCH_ID` and `LUBBDUBB_WATCH_QUERY` set.
   * It reads the query out of the variable and prints the rows as JSON.
   */
  observe: string;
  /**
   * Prose an author is handed about what this environment's telemetry looks like:
   * what table structured logs land in, what the role names are, where properties
   * live. Fifteen lines an operator writes once, **appended** to the prompt.
   */
  schema?: string;
  /** An optional command whose output is cached and appended the same way. A schema query, a sample row. */
  describe?: string;
  /**
   * How long a window stays open here, in milliseconds. Absent takes the
   * subsystem's own default of 48 hours.
   *
   * Spelled with the `Ms` suffix the rest of the config uses
   * (`environmentProbeIntervalMs`, `closedPrWindowMs`) rather than the spec's
   * original bare `for`: an unsuffixed duration is exactly the unit ambiguity the
   * convention exists to remove, and a window read in the wrong unit is a watch
   * that settles in two minutes or in two months with nothing red.
   */
  forMs?: number;
  /**
   * Which of a delivered goal's obligations an **open** watch here holds. Off by
   * default, and deliberately: a watch reports, and a 48-hour hold on every
   * delivered goal would put every goal on the bench in a state nobody can act on.
   */
  holds?: EnvironmentGate[];
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
    validateWatch(env, `${where} ("${env.name}")`);
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

/**
 * The three refusals whose absence is otherwise silent.
 *
 * Each leaves a watch that looks configured and answers nothing: an empty
 * `observe` makes every check unanswerable forever, a `holds` naming an
 * obligation the harness does not file holds nothing, and a `describe` without an
 * `observe` is a schema for a question nothing asks.
 */
function validateWatch(env: EnvironmentConfig, where: string): void {
  const watch = env.watch;
  if (watch === undefined) {
    if ('describe' in env)
      throw new Error(
        `${where}: "describe" belongs inside "watch", beside the "observe" command it describes the schema for.`,
      );
    return;
  }
  if (typeof watch !== 'object' || watch === null || Array.isArray(watch))
    throw new Error(`${where}: "watch" must be an object — {"observe": "...", "schema": "..."}.`);
  if (typeof watch.observe !== 'string' || watch.observe.trim() === '')
    throw new Error(
      `${where}: "watch.observe" must be a non-empty command that answers a declared query. ` +
        'An empty one leaves every check on this environment unanswerable forever.',
    );
  if (watch.describe !== undefined && (typeof watch.describe !== 'string' || watch.describe.trim() === ''))
    throw new Error(`${where}: "watch.describe" must be a non-empty command, or be left out.`);
  if (
    watch.forMs !== undefined &&
    (typeof watch.forMs !== 'number' || !Number.isFinite(watch.forMs) || watch.forMs <= 0)
  )
    throw new Error(
      `${where}: "watch.forMs" must be a positive number of milliseconds — how long a window stays open.`,
    );
  if (watch.holds === undefined) return;
  if (!Array.isArray(watch.holds))
    throw new Error(`${where}: "watch.holds" must be a list of ${ENVIRONMENT_GATES.join(' / ')}.`);
  for (const gate of watch.holds)
    if (!ENVIRONMENT_GATES.includes(gate))
      throw new Error(
        `${where}: "${String(gate)}" is not an obligation the harness files, so holding it holds nothing. ` +
          `"watch.holds" names ${ENVIRONMENT_GATES.join(' / ')}.`,
      );
}
