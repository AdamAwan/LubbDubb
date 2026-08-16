import type { Task } from '../types.js';
import { issueOriginRole } from '../issueOrigins.js';

/**
 * The assessor's policy and its ref vocabulary.
 *
 * The assessor is the rule that produces a `delivered` verdict (`delivery.ts` is
 * what the verdict then holds). It fires for an issue that has already had work
 * done on it and currently has nothing in flight — and asks the one question no
 * existing rule asks: *is this finished?*
 */

/**
 * The origin an assessing agent is dispatched on.
 *
 * Its own origin rather than the issue's, so `dispatchVerdict`'s cooldown and
 * attempt cap apply to assessments independently of the pickup attempts on
 * `issue:<n>` — an issue that burned its pickup attempts must still be
 * assessable, and an assessor that keeps failing must not consume the budget
 * that gets the work done.
 */
export function assessOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:assess`;
}

/**
 * The branch an assessing agent works on, in a namespace of its own for the
 * reason `planBranch` has one: git stores refs as files, so `refs/heads/issue/12`
 * and `refs/heads/issue/12/assess` cannot coexist, and `issue/<n>` is exactly what
 * a pickup agent wants. It sits beside `plan/issue/<n>` and collides with neither
 * that nor the part branches.
 *
 * The worktree is cut from the **default branch**, which is not incidental:
 * merged work is *on* the default branch, so it is the only checkout in which
 * "was this delivered" can be answered at all.
 */
export function assessBranch(issueNumber: number): string {
  return `assess/issue/${issueNumber}`;
}

/**
 * Has anything ever been attempted for this issue?
 *
 * This is the condition that stops the assessor being noise, and it does a second
 * job that matters more. Without it a brand-new issue satisfies every other
 * precondition trivially — nothing is in flight because nothing ever started — and
 * every fresh issue would get an assessor reporting that nothing has been done.
 *
 * The second job: an open, watched issue with no open PR is a candidate for *both*
 * pickup and assessment, and this is what tells them apart. No prior tasks means
 * the work has not started, so rule `issue-pickup` picks it up; prior tasks with nothing in
 * flight means it may be finished, so the assessor asks.
 *
 * **Only an origin that could have delivered something counts** — the pickup root,
 * a plan's parts, or an assessment (which is not work but only ever happens
 * downstream of some). The origins where the harness is *deliberating* do not:
 * matching the whole `issue:<n>:*` subtree meant a planner's own task read as work
 * having been done, so an issue the planner routed to `single` was assessed instead
 * of picked up and never got built at all. `issueOriginRole` is where that is
 * decided, once, for every predicate that asks — see `src/issueOrigins.ts` for the
 * full argument and for what an unrecognised origin does.
 *
 * **Answered from the tasks the dispatcher already holds, never from the work
 * graph.** The graph is keyed on these same origin strings, which is why this reads
 * like a graph query. It is the same question, asked of the source that was always
 * there. Nothing in `src/dispatcher/` may read the graph (stage 1's structural
 * property, asserted in `test/workGraph.test.ts`): a rule consulting it would be a
 * second opinion about a gate living nowhere near the gate it duplicates, and
 * would let one agent's own record suppress another's dispatch. The graph is what
 * the assessing *agent* reads, through `world_read`.
 */
export function hasPriorWork(issueNumber: number, tasks: Task[]): boolean {
  return tasks.some((t) => {
    const role = issueOriginRole(issueNumber, t.originRef);
    return role === 'work' || role === 'evidence';
  });
}
