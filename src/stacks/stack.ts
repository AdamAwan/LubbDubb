import type { Plan, PlanPart, PullRequest } from '../types.js';

// → docs/spec/07-pull-requests.md

interface StackRung {
  prNumber: number;
  title: string;
  branch: string;
  base: string;
  position: number;
  partSlug: string | null;
}

export interface Stack {
  ref: string;
  issueNumber: number | null;
  issueTitle: string | null;
  planId: string | null;
  rungs: StackRung[];
}

export function buildStacks(openPrs: PullRequest[], plans: Plan[], parts: PlanPart[], defaultBranch: string): Stack[] {
  const live = openPrs.filter((p) => !p.merged);
  const byBranch = new Map<string, PullRequest>();
  for (const pr of live) byBranch.set(pr.branch, pr);

  const baseOf = (pr: PullRequest): PullRequest | null => {
    if (pr.baseBranch === undefined || pr.baseBranch === defaultBranch) return null;
    const base = byBranch.get(pr.baseBranch);
    return base && base.number !== pr.number ? base : null;
  };

  const bottoms = live.filter((pr) => baseOf(pr) === null);
  const stacks: Stack[] = [];

  const childrenOf = (pr: PullRequest): PullRequest[] => live.filter((p) => p.baseBranch === pr.branch);

  for (const bottom of bottoms) {
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

  const planIds = new Set(
    prs.map((pr) => partByPr.get(pr.number)?.planId).filter((id): id is string => id !== undefined),
  );
  const planId = planIds.size === 1 ? [...planIds][0]! : null;
  const plan = planId !== null ? (plans.find((p) => p.id === planId) ?? null) : null;

  const leaf = prs[prs.length - 1];
  return {
    ref: forked ? `stack:${bottom?.number ?? 0}:${leaf?.number ?? 0}` : `stack:${bottom?.number ?? 0}`,
    issueNumber: plan ? issueNumberOf(plan.originRef) : null,
    issueTitle: plan?.title ?? null,
    planId,
    rungs,
  };
}

function issueNumberOf(originRef: string): number | null {
  const match = /^issue:(\d+)$/.exec(originRef);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}
