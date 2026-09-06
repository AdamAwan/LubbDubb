import type { EnvironmentGate } from '../types.js';

// → docs/spec/24-environments.md

export interface EnvironmentConfig {
  name: string;
  at: string;
  health?: string;
  arrival?: EnvironmentArrival;
  watch?: EnvironmentWatch;
}

interface EnvironmentWatch {
  observe: string;
  schema?: string;
  describe?: string;
  forMs?: number;
  holds?: EnvironmentGate[];
}

const ENVIRONMENT_GATES: readonly EnvironmentGate[] = ['validate', 'close_out'];

interface EnvironmentArrival {
  opens?: EnvironmentGate[];
  comment?: boolean;
}

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
    if (env.health !== undefined && (typeof env.health !== 'string' || env.health.trim() === ''))
      throw new Error(
        `${where} ("${env.name}"): "health" must be a non-empty command printing a {"state": …} report, ` +
          'or be left out — with none, this environment is observed for reach and draws no health row.',
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
  if (arrival.opens === undefined && arrival.comment !== true)
    throw new Error(
      `${where}: "arrival" declares nothing. Name what arriving here opens, or set "comment": true — or drop it, ` +
        'and the environment is observed and nothing more.',
    );
}

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
