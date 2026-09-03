import { corroborationGoal } from './knowledge.js';

/**
 * Which scopes one dispatch matches — the goal it is for, and each check it
 * answers.
 *
 * What is left of the fleet-wide claim store's delivery module. The injected
 * block, the scoped note and the cost accounting over both went with the store
 * they read; this is the one computation the obstacle board kept, because it is
 * the harness's single spelling of *what is this dispatch about* and two
 * spellings of that would drift.
 *
 * → `docs/spec/27-obstacles.md#delivery`
 */

/**
 * The scopes one dispatch matches: the goal it is for, and each check it answers.
 *
 * **The goal, never the dispatch concern.** `pr:412:ci` and `pr:412:comments` are
 * two origins of one goal, and something filed against the goal is true of both —
 * `corroborationGoal` is the harness's one spelling of that collapse, so the scope
 * a row is *delivered* on and the scope it is *judged* against cannot drift.
 *
 * **A check name is matched exactly**, which is `priorRemedies`' choice and the
 * same fragility accepted for the same reason: a check name is a provider
 * identifier, and a prefix match would put another job's history in front of an
 * agent under a name it would read as its own.
 */
export function dispatchFactScopes(originRef: string | null, ciChecks: readonly string[] | null): string[] {
  const goal = corroborationGoal(originRef);
  return [...(goal ? [`goal:${goal}`] : []), ...(ciChecks ?? []).map((name) => `check:${name}`)];
}
