import type { EnvironmentConfig } from '../environments/policy.js';

// → docs/spec/36-remote-validation.md

/**
 * Environments that declare a command able to put a `state` query to their store. The one predicate
 * three things read: whether `state_declare` is named to an agent, whether it answers a caller at
 * all, and which place a dry run is put to.
 */
export function stateExecutors(environments: readonly EnvironmentConfig[]): EnvironmentConfig[] {
  return environments.filter((env) => (env.validate?.state?.run ?? '').trim() !== '');
}

export function stateExecutor(environments: readonly EnvironmentConfig[], name?: string): EnvironmentConfig | null {
  const executors = stateExecutors(environments);
  if (name === undefined) return executors[0] ?? null;
  return executors.find((env) => env.name === name) ?? null;
}

export const NO_STATE_EXECUTOR =
  'No environment on this deployment declares a "validate.state.run" command, so a state query stored ' +
  'here could never be put to anything. Storing one anyway would leave a question about a deployed ' +
  'store on a goal page with no deployed store to ask — a surface that reads as broken and was never ' +
  'turned on. An operator adds "validate": {"permits": ["state"], "state": {"run": "..."}} to an ' +
  'environment in lubbdubb.config.json, and this tool starts answering.';
