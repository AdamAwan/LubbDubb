import type { Plan, PlanPart, PullRequest } from '../types.js';

/**
 * The stack model: a chain of open pull requests, each based on the one beneath it.
 *
 * **Derived, never stored.** The edge is the one `basePrOf` already walks —
 * `pr.baseBranch` naming another open PR's `branch` — so a stack is a fact about
 * the world, and the world is re-read every pulse. A `stacks` table would be a
 * second answer to a question the world answers, needing reconciling against the
 * world the way `plan_parts` already does.
 *
 * **A plan adopts a stack; it never owns one.** Rung identity is the *pull
 * request*, so a chain a human opened by hand is a stack on exactly the same terms
 * as one a plan produced — which is the point, since `plan_parts` was previously
 * the only record that a chain was a chain.
 *
 * **It is a lens.** Nothing in `src/dispatcher/` may read it: every input it folds
 * is already a gate that fires on its own, so a rule consulting this would be a
 * second opinion about a decision made elsewhere, from a function sitting nowhere
 * near the rule it duplicates. `test/stacks.test.ts` asserts that structurally.
 */

interface StackRung {
  prNumber: number;
  title: string;
  branch: string;
  /** The branch this rung targets — the rung beneath it, or the default branch at the bottom. */
  base: string;
  /** 1-based, bottom-first. */
  position: number;
  /** The plan part this rung delivers, when a plan adopted the stack. */
  partSlug: string | null;
}

export interface Stack {
  /**
   * `stack:<bottom rung's PR number>` — stable while the bottom rung is open, and
   * `stack:<bottom>:<leaf>` for one path of a fork, whose paths share a bottom.
   */
  ref: string;
  issueNumber: number | null;
  issueTitle: string | null;
  planId: string | null;
  /** Bottom-first: `rungs[0]` is the one based on the default branch. */
  rungs: StackRung[];
}

/**
 * Fold the open pull requests into stacks.
 *
 * Takes the **unfiltered** open list (the dispatch world plus `unwatchedPrs`), for
 * the reason `inheritedCiFailure` and `prAttentionStatus` take it: an unwatched rung
 * would otherwise put a hole in the chain and misattribute everything above it.
 */
export function buildStacks(openPrs: PullRequest[], plans: Plan[], parts: PlanPart[], defaultBranch: string): Stack[] {
  const live = openPrs.filter((p) => !p.merged);
  const byBranch = new Map<string, PullRequest>();
  for (const pr of live) byBranch.set(pr.branch, pr);

  // A rung is only a rung if its base names another open PR's branch. Everything
  // else is a bottom, including a PR based on the default branch.
  const baseOf = (pr: PullRequest): PullRequest | null => {
    if (pr.baseBranch === undefined || pr.baseBranch === defaultBranch) return null;
    const base = byBranch.get(pr.baseBranch);
    return base && base.number !== pr.number ? base : null;
  };

  const bottoms = live.filter((pr) => baseOf(pr) === null);
  const stacks: Stack[] = [];

  // Children in list order, so a chain that does not fork is folded in exactly
  // the order it always was.
  const childrenOf = (pr: PullRequest): PullRequest[] => live.filter((p) => p.baseBranch === pr.branch);

  for (const bottom of bottoms) {
    // **Every root-to-leaf path, not one child per rung.** A branch with two open
    // pull requests based on it is a fork, and it is what the planning funnel
    // produces for a diamond plan: `partBase` returns the first unsettled
    // dependency's branch, so two parts each depending on the same part are both
    // dispatched and both based on it. Walked with `find`, the second sibling was
    // in no chain at all — not a bottom, never reached — so it had no head line,
    // no readiness verdict and no "land the stack" control, while `isStackedPr`
    // stayed true for it so no rule would merge it either. Which sibling survived
    // was the order the provider listed the pull requests in, which is not a fact
    // about the world. → `docs/spec/07-pull-requests.md`
    for (const path of pathsFrom(bottom, childrenOf)) {
      if (path.length < 2) continue;
      stacks.push(assemble(path, plans, parts, forks(bottom, childrenOf)));
    }
  }

  return stacks.sort(
    (a, b) =>
      (a.rungs[0]?.prNumber ?? 0) - (b.rungs[0]?.prNumber ?? 0) ||
      (a.rungs[a.rungs.length - 1]?.prNumber ?? 0) - (b.rungs[b.rungs.length - 1]?.prNumber ?? 0),
  );
}

/**
 * Every root-to-leaf path from this bottom, bottom-first.
 *
 * The `seen` set is per path and is not tidiness: a malformed world can cycle the
 * base edges, and an unguarded walk would hang the pulse rather than report a bad
 * stack. Per path rather than shared, because two siblings legitimately share
 * every rung beneath them — a shared set would drop the second one, which is the
 * bug this function exists to fix.
 */
function pathsFrom(bottom: PullRequest, childrenOf: (pr: PullRequest) => PullRequest[]): PullRequest[][] {
  const out: PullRequest[][] = [];
  const walk = (path: PullRequest[], seen: Set<number>): void => {
    const current = path[path.length - 1];
    if (!current) return;
    const next = childrenOf(current).filter((p) => !seen.has(p.number));
    if (next.length === 0) {
      out.push(path);
      return;
    }
    for (const child of next) walk([...path, child], new Set([...seen, child.number]));
  };
  walk([bottom], new Set([bottom.number]));
  return out;
}

/** Whether this bottom's tree branches anywhere — what decides how a ref is spelled. */
function forks(bottom: PullRequest, childrenOf: (pr: PullRequest) => PullRequest[]): boolean {
  return pathsFrom(bottom, childrenOf).filter((p) => p.length >= 2).length > 1;
}

function assemble(prs: PullRequest[], plans: Plan[], parts: PlanPart[], forked: boolean): Stack {
  const bottom = prs[0];
  const partByPr = new Map<number, PlanPart>();
  for (const part of parts) if (part.prNumber !== null) partByPr.set(part.prNumber, part);

  const rungs: StackRung[] = prs.map((pr, i) => ({
    prNumber: pr.number,
    title: pr.title,
    branch: pr.branch,
    base: pr.baseBranch ?? '',
    position: i + 1,
    partSlug: partByPr.get(pr.number)?.slug ?? null,
  }));

  // The plan is adopted from the parts the rungs deliver, not from a branch-name
  // convention — a rung's part is the only thing that says which plan it belongs to.
  const planIds = new Set(
    prs.map((pr) => partByPr.get(pr.number)?.planId).filter((id): id is string => id !== undefined),
  );
  const planId = planIds.size === 1 ? [...planIds][0]! : null;
  const plan = planId !== null ? (plans.find((p) => p.id === planId) ?? null) : null;

  const leaf = prs[prs.length - 1];
  return {
    // `stack:<bottom>` while the bottom carries one chain, which is every stack a
    // linear plan produces and every ref written before forks were modelled. A
    // fork's paths share a bottom, so each names its leaf as well or they would
    // collide — and a click on one path would authorize the other's rungs.
    ref: forked ? `stack:${bottom?.number ?? 0}:${leaf?.number ?? 0}` : `stack:${bottom?.number ?? 0}`,
    issueNumber: plan ? issueNumberOf(plan.originRef) : null,
    issueTitle: plan?.title ?? null,
    planId,
    rungs,
  };
}

/** `issue:12` -> 12. Null for anything else — a stack with no plan names no issue. */
function issueNumberOf(originRef: string): number | null {
  const match = /^issue:(\d+)$/.exec(originRef);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}
