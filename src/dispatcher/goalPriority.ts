import type { GoalPriority, Issue, Plan, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from './issuePickup.js';
import { issueOriginRole } from '../issueOrigins.js';

/** What the expansion below needs of the world — the whole of it, so the caller can pass a slice. */
interface GoalWorld {
  /** Every open pull request the dispatcher can see, including the ones the ignore tag hid. */
  openPrs: readonly PullRequest[];
  /** The issues in the dispatcher's view, for `linkedPrNumber`. */
  issues: readonly Issue[];
  /** The plans, which are what join a part to the goal it decomposes. */
  plans: readonly Plan[];
  /** Every plan part, for the pull request a part has already opened. */
  parts: readonly PlanPart[];
}

/**
 * A goal the operator marked a priority covers **every origin its work takes**, and
 * this is the one place that says which those are.
 *
 * The flag is set on a goal (`issue:<n>`) and the queue is ranked by origin, so
 * without an expansion the flag would move exactly one row — the goal's own pickup
 * — and lose the goal the moment its work became three plan parts and a red build.
 * That is the whole failure the flag exists to prevent, and it would be silent: the
 * goal is still flagged, the chip still says so, and the queue quietly stops
 * honouring it.
 *
 * Two families reach it:
 *
 * - **The `issue:<n>` subtree**, through `issueOriginRole` — the pickup root, the
 *   plan's parts, the planner, the appraisal, the assessor, the retrospective and the
 *   validation checks. Asked through that function rather than by `startsWith` for
 *   its own reason: a bare prefix test matches `issue:19:plan` for goal 1.
 * - **The pull requests the goal's work opened**, whose origins (`pr:<m>:ci`,
 *   `pr:<m>:comments`, …) name the PR and never the goal. Resolved the three ways
 *   the cockpit's `goalOfPr` resolves it — a part's own `prNumber`, the issue's
 *   `linkedPrNumber`, and the branch convention — because a PR concern is usually
 *   the *last* thing standing between a goal and the line, and a priority that
 *   stopped at the goal's own dispatches would rank everything except the work that
 *   actually finishes it.
 *
 * The branch half reads {@link issueBranch} rather than a regex of its own: that
 * function and `partBranch` are what define the convention (`issue/12`, and
 * `issue/12/<slug>` under it), so matching it here as `<branch>` or `<branch>/…`
 * cannot drift from them.
 *
 * Pure, and total over any origin string — a `job:` origin, a ticketless PR or a
 * ref for a goal nobody flagged all answer false.
 */
export function expeditedOrigins(goals: readonly GoalPriority[], world: GoalWorld): (originRef: string) => boolean {
  const numbers: number[] = [];
  for (const goal of goals) {
    const match = /^issue:(\d+)$/.exec(goal.originRef);
    if (match) numbers.push(Number(match[1]));
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
  // A part's PR is matched off the part row as well as off its branch: a part may
  // carry an explicit `branch` that does not follow the convention, and the row is
  // then the only thing that knows the pull request belongs to this goal.
  const flaggedPlans = new Set(
    world.plans.filter((p) => numbers.some((n) => p.originRef === `issue:${n}`)).map((p) => p.id),
  );
  for (const part of world.parts) {
    if (part.prNumber !== null && flaggedPlans.has(part.planId)) prNumbers.add(part.prNumber);
  }

  return (originRef: string): boolean => {
    for (const n of numbers) if (issueOriginRole(n, originRef) !== null) return true;
    const pr = /^pr:(\d+)(?::|$)/.exec(originRef);
    return pr ? prNumbers.has(Number(pr[1])) : false;
  };
}
