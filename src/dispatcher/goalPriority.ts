import type { GoalPriority, Issue, ObstacleBlock, ObstacleStanding, Plan, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from './issuePickup.js';
import { issueOriginNumber, issueOriginRef, issueOriginRole, obstacleOriginId } from '../issueOrigins.js';

// → docs/spec/05-dispatcher.md

interface GoalWorld {
  openPrs: readonly PullRequest[];
  issues: readonly Issue[];
  plans: readonly Plan[];
  parts: readonly PlanPart[];
  obstacles?: readonly ObstacleStanding[];
  obstacleBlocks?: readonly ObstacleBlock[];
}

export function expeditedOrigins(goals: readonly GoalPriority[], world: GoalWorld): (originRef: string) => boolean {
  const numbers: number[] = [];
  for (const goal of goals) {
    const number = issueOriginNumber('root', goal.originRef);
    if (number !== null) numbers.push(number);
  }
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

  const flaggedGoals = new Set(numbers.map((n) => issueOriginRef('root', n)));
  const flaggedObstacles = new Set([
    ...(world.obstacles ?? [])
      .filter((row) => row.goalRefs.some((ref) => flaggedGoals.has(ref)))
      .map((row) => row.obstacle.id),
    ...(world.obstacleBlocks ?? []).filter((b) => flaggedGoals.has(b.originRef)).map((b) => b.obstacleId),
  ]);

  return (originRef: string): boolean => {
    for (const n of numbers) if (issueOriginRole(n, originRef) !== null) return true;
    const obstacle = obstacleOriginId(originRef);
    if (obstacle !== null) return flaggedObstacles.has(obstacle);
    const pr = /^pr:(\d+)(?::|$)/.exec(originRef);
    return pr ? prNumbers.has(Number(pr[1])) : false;
  };
}
