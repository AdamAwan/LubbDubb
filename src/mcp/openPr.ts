import { bySlug, liveParts, partBase, partBranch } from '../plans/parts.js';
import type { Issue, Plan, PlanPart } from '../types.js';

/**
 * Where an agent's pull request goes, resolved from its origin and nothing else.
 *
 * This is what makes `open_pr`'s identity structural: the tool takes no branch,
 * no base and no issue number, so an agent cannot open a pull request against
 * another agent's work however it phrases the call. The same discipline
 * `report_finding` rests on, and with more force — this write puts a pull request
 * into the world under the operator's account.
 *
 * Base selection reuses `partBase` rather than re-deriving it. Two answers to
 * "what does this part stack on" is the drift class the repo pays for repeatedly;
 * the branch gate and the reconciler already read that one.
 */

interface OpenPrTarget {
  issueNumber: number;
  issueTitle: string;
  branch: string;
  base: string;
  /** 1-based position among the plan's live parts; 1 when the issue is worked whole. */
  position: number;
  /** Live part count; 1 when the issue is worked whole, which renders no position clause. */
  total: number;
}

export interface OpenPrContext {
  issues: Issue[];
  plan: Plan | null;
  parts: PlanPart[];
  defaultBranch: string;
}

/**
 * An origin that may open a pull request, or the reason it may not.
 *
 * Refusing beats scoping silently — an agent handed a target it did not ask for
 * would open a PR for work it is not doing. The same reason `conclusionOrigin` and
 * `partConclusionOrigin` refuse by name and point the caller at the right tool.
 */
export function resolveOpenPr(originRef: string | null, ctx: OpenPrContext): OpenPrTarget | { error: string } {
  if (originRef === null) return { error: 'This agent has no origin, so there is no work to open a pull request for.' };

  const part = /^issue:(\d+):part:([^:]+)$/.exec(originRef);
  if (part?.[1] !== undefined && part[2] !== undefined) {
    return partTarget(Number(part[1]), part[2], ctx);
  }

  const pickup = /^issue:(\d+)$/.exec(originRef);
  if (pickup?.[1] !== undefined) return pickupTarget(Number(pickup[1]), ctx);

  return {
    error:
      `open_pr is for the agent doing an issue's work — origin "${originRef}" is not that. ` +
      'A PR-concern agent already has a pull request; a planner, assayer, assessor or desk job writes no code. ' +
      'If you genuinely need a pull request here, open it yourself with the branch named in your prompt.',
  };
}

function pickupTarget(issueNumber: number, ctx: OpenPrContext): OpenPrTarget | { error: string } {
  const issue = ctx.issues.find((i) => i.number === issueNumber);
  if (!issue) return { error: `The harness is not tracking issue #${issueNumber}.` };
  return {
    issueNumber,
    issueTitle: issue.title,
    branch: `issue/${issueNumber}`,
    base: ctx.defaultBranch,
    position: 1,
    total: 1,
  };
}

function partTarget(issueNumber: number, slug: string, ctx: OpenPrContext): OpenPrTarget | { error: string } {
  const issue = ctx.issues.find((i) => i.number === issueNumber);
  if (!ctx.plan) return { error: `Issue #${issueNumber} has no plan, so it has no part "${slug}".` };
  const live = liveParts(ctx.parts);
  const part = live.find((p) => p.slug === slug);
  if (!part) return { error: `Part "${slug}" is not a live part of the plan for issue #${issueNumber}.` };

  // Ordered by seq so the position matches the order the plan states, which is the
  // order the parts were dispatched in and the order the stack reads bottom-first.
  const ordered = [...live].sort((a, b) => a.seq - b.seq);
  return {
    issueNumber,
    issueTitle: issue?.title ?? ctx.plan.title,
    branch: part.branch ?? partBranch(issueNumber, slug),
    base: partBase(part, bySlug(live), issueNumber, ctx.defaultBranch),
    position: ordered.findIndex((p) => p.slug === slug) + 1,
    total: ordered.length,
  };
}

/**
 * GitHub's answer for a head ref it cannot find, told apart from every other
 * create failure.
 *
 * Nothing in the harness pushes a branch — `git push` is the agent's, and until
 * this landed no prompt said so — so an agent that committed and called `open_pr`
 * got `{"resource":"PullRequest","field":"head","code":"invalid"}` back and no way
 * to read it. The generic failure below quotes that blob and then advises opening
 * the pull request by hand, which fails identically against a branch the remote
 * does not have: the observed cost was three refusals and a human opening it.
 *
 * The two fields are matched rather than the sentence around them, because the
 * prose and the docs URL are GitHub's to reword. Azure states an absent source
 * branch differently and falls through to the generic arm, which is honest —
 * a wrong diagnosis is worse than none.
 */
function isUnpushedHead(message: string): boolean {
  return /"field"\s*:\s*"head"/.test(message) && /"code"\s*:\s*"invalid"/.test(message);
}

/**
 * What an agent is told when the create failed. The unpushed-head arm names the
 * one command that fixes it and says to call again rather than to open by hand —
 * the fallback is right for a tool that is unavailable, and wrong for a branch
 * that is merely not pushed yet.
 */
export function openPrFailure(message: string, branch: string, base: string): string {
  if (isUnpushedHead(message)) {
    return (
      `Opening the pull request failed: the provider has no branch ${branch}. Your commits are still ` +
      'local — the harness never pushes, that part is yours. Run `git push -u origin ' +
      `${branch}\` and then call open_pr again. Do not open it by hand: it fails the same way until the ` +
      'branch is on the remote.'
    );
  }
  return `Opening the pull request failed: ${message}. Open it yourself against ${branch} -> ${base}.`;
}
