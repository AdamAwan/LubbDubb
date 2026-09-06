import { bySlug, liveParts, partBase, partBranch } from '../plans/parts.js';
import type { Issue, Plan, PlanPart } from '../types.js';

// → docs/spec/11-mcp-tools.md

interface OpenPrTarget {
  issueNumber: number;
  issueTitle: string;
  branch: string;
  base: string;
  position: number;
  total: number;
}

export interface OpenPrContext {
  issues: Issue[];
  plan: Plan | null;
  parts: PlanPart[];
  defaultBranch: string;
}

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
      'A PR-concern agent already has a pull request; a planner, appraiser, assessor or desk job writes no code. ' +
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

function isUnpushedHead(message: string): boolean {
  return /"field"\s*:\s*"head"/.test(message) && /"code"\s*:\s*"invalid"/.test(message);
}

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
