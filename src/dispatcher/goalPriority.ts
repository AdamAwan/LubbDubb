import type { GoalPriority, Issue, Plan, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from './issuePickup.js';
import { issueOriginRef, issueOriginRole } from '../issueOrigins.js';
import { markedNumbers } from '../goalPause.js';
import { cascadeToChildren } from '../issueRelations.js';
import { prOriginNumber } from '../primitives.js';

// → docs/spec/05-dispatcher.md

interface GoalWorld {
  openPrs: readonly PullRequest[];
  issues: readonly Issue[];
  plans: readonly Plan[];
  parts: readonly PlanPart[];
}

export function expeditedOrigins(
  goals: readonly GoalPriority[],
  world: GoalWorld,
  containerTypes?: readonly string[],
): (originRef: string) => boolean {
  // A flag on a container covers the work under it, transitively — the same span the
  // pause covers, through the same function, because "get this Feature over the line
  // first" and "stop this Feature" have to mean the same body of work. Expanded here
  // and once: the pull requests, the plans and the parts below are all
  // read off `numbers`, so each of them follows the children without knowing about them.
  const numbers = [...cascadeToChildren(markedNumbers(goals), world.issues, containerTypes)];
  if (numbers.length === 0) return () => false;

  const prNumbers = new Set<number>();
  for (const n of numbers) {
    const branch = issueBranch(n);
    for (const pr of world.openPrs) {
      if (pr.branch === branch || pr.branch.startsWith(`${branch}/`)) prNumbers.add(pr.number);
    }
    const linked = world.issues.find((i) => i.number === n)?.linkedPrNumber;
    if (typeof linked === 'number') prNumbers.add(linked);
  }
  const flaggedPlans = new Set(
    world.plans.filter((p) => numbers.some((n) => p.originRef === issueOriginRef('root', n))).map((p) => p.id),
  );
  for (const part of world.parts) {
    if (part.prNumber !== null && flaggedPlans.has(part.planId)) prNumbers.add(part.prNumber);
  }

  return (originRef: string): boolean => {
    for (const n of numbers) if (issueOriginRole(n, originRef) !== null) return true;
    const pr = prOriginNumber(originRef);
    return pr !== null && prNumbers.has(pr);
  };
}
