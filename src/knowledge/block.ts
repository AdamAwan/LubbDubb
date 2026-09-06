import { corroborationGoal } from './knowledge.js';

// → docs/spec/27-obstacles.md

export function dispatchFactScopes(originRef: string | null, ciChecks: readonly string[] | null): string[] {
  const goal = corroborationGoal(originRef);
  return [...(goal ? [`goal:${goal}`] : []), ...(ciChecks ?? []).map((name) => `check:${name}`)];
}
