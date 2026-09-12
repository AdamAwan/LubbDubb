import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import type { PullRequest, WorkNode, WorldSnapshot } from '../types.js';
import { issueForPr } from '../pr/prIssue.js';
import { prState } from '../pr/prHealth.js';

// → docs/spec/24-environments.md

interface LandingToRecord {
  prNumber: number;
  goalRef: string;
  sha: string;
}

interface LandingSweepInput {
  world: WorldSnapshot;
  nodes: WorkNode[];
  landed: ReadonlySet<number>;
  integrationBranch: string;
}

export function unrecordedLandings(input: LandingSweepInput): LandingToRecord[] {
  const goals = goalOfPr(input.nodes);
  const out: LandingToRecord[] = [];
  for (const pr of mergedPulls(input.world)) {
    if (input.landed.has(pr.number)) continue;
    if (pr.mergeCommitSha === undefined || pr.mergeCommitSha === '') continue;
    if (pr.baseBranch !== undefined && pr.baseBranch !== input.integrationBranch) continue;
    const goalRef = goals.get(pr.number) ?? issueRefFor(pr, input.world);
    if (goalRef === null) continue;
    out.push({ prNumber: pr.number, goalRef, sha: pr.mergeCommitSha });
  }
  return out;
}

export function unattributedMerges(goalRef: string, nodes: WorkNode[], landed: ReadonlySet<number>): number {
  const goals = goalOfPr(nodes);
  let n = 0;
  for (const node of nodes) {
    if (node.kind !== 'pr' || node.status !== 'merged') continue;
    const number = prNumberOf(node.ref);
    if (number === null || goals.get(number) !== goalRef) continue;
    if (node.baseRef !== null) continue;
    if (!landed.has(number)) n += 1;
  }
  return n;
}

function mergedPulls(world: WorldSnapshot): PullRequest[] {
  return [...world.pullRequests, ...(world.closedPullRequests ?? [])].filter((pr) => prState(pr) === 'merged');
}

function goalOfPr(nodes: WorkNode[]): Map<number, string> {
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const out = new Map<number, string>();
  for (const node of nodes) {
    if (node.kind !== 'pr') continue;
    const number = prNumberOf(node.ref);
    if (number === null) continue;
    let current: WorkNode | undefined = node;
    for (let hops = 0; hops < nodes.length && current !== undefined; hops += 1) {
      if (isGoalRoot(current.ref)) {
        out.set(number, current.ref);
        break;
      }
      current = current.parentRef === null ? undefined : byRef.get(current.parentRef);
    }
  }
  return out;
}

function issueRefFor(pr: PullRequest, world: WorldSnapshot): string | null {
  const issue = issueForPr(pr, world.issues);
  return issue === null ? null : issueOriginRef('root', issue.number);
}

function isGoalRoot(ref: string): boolean {
  return issueOriginNumber('root', ref) !== null;
}

function prNumberOf(ref: string): number | null {
  const m = /^pr:(\d+)$/.exec(ref);
  return m?.[1] === undefined ? null : Number(m[1]);
}
