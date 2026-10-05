import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import type { GoalLanding, PullRequest, WorkNode, WorldSnapshot } from '../types.js';
import { issueForPr } from '../pr/prIssue.js';
import { prState } from '../pr/prHealth.js';
import { prNumberOf } from '../primitives.js';

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

interface CarrySweepInput {
  world: WorldSnapshot;
  nodes: WorkNode[];
  landings: GoalLanding[];
  integrationBranch: string;
}

interface CarriedLanding extends LandingToRecord {
  onIntegration: boolean | null;
}

export function carriedLandings(input: CarrySweepInput): CarriedLanding[] {
  const goals = goalOfPr(input.nodes);
  const landings = new Map(input.landings.map((l) => [l.prNumber, l]));
  const pulls = pullsByNumber(input.world);
  const stack = stackOf(input, pulls);
  const out: CarriedLanding[] = [];
  for (const number of stack.merged) {
    const own = landings.get(number);
    if (own !== undefined && own.onIntegration !== false) continue;
    const first = stack.carrierOf(number);
    if (first === null || mergedAfter(pulls.get(number), pulls.get(first))) continue;
    const carrier = carrierLanding(first, landings, stack.carrierOf, stack.merged.size);
    if (carrier === undefined || carrier.sha === own?.sha) continue;
    const pr = pulls.get(number);
    const goalRef = own?.goalRef ?? goals.get(number) ?? (pr === undefined ? null : issueRefFor(pr, input.world));
    if (goalRef === null) continue;
    out.push({ prNumber: number, goalRef, sha: carrier.sha, onIntegration: carrier.onIntegration });
  }
  return out;
}

function pullsByNumber(world: WorldSnapshot): Map<number, PullRequest> {
  const out = new Map<number, PullRequest>();
  for (const pr of allPulls(world)) if (!out.has(pr.number)) out.set(pr.number, pr);
  return out;
}

function stackOf(
  input: CarrySweepInput,
  pulls: ReadonlyMap<number, PullRequest>,
): { merged: Set<number>; carrierOf: (number: number) => number | null } {
  const byBranch = new Map<string, PullRequest>();
  for (const pr of pulls.values()) {
    if (prState(pr) === 'closed') continue;
    const held = byBranch.get(pr.branch);
    if (held === undefined || prState(pr) === 'merged') byBranch.set(pr.branch, pr);
  }
  const graphBase = new Map<number, number>();
  const merged = new Set<number>();
  for (const pr of pulls.values()) if (prState(pr) === 'merged') merged.add(pr.number);
  for (const node of input.nodes) {
    const number = node.kind === 'pr' ? prNumberOf(node.ref) : null;
    if (number === null) continue;
    if (node.status === 'merged') merged.add(number);
    const base = node.baseRef === null ? null : prNumberOf(node.baseRef);
    if (base !== null) graphBase.set(number, base);
  }
  const carrierOf = (number: number): number | null => {
    const base = pulls.get(number)?.baseBranch;
    if (base === input.integrationBranch) return null;
    const viaWorld = base === undefined ? undefined : byBranch.get(base)?.number;
    return viaWorld ?? graphBase.get(number) ?? null;
  };
  return { merged, carrierOf };
}

function carrierLanding(
  first: number,
  landings: ReadonlyMap<number, GoalLanding>,
  carrierOf: (number: number) => number | null,
  limit: number,
): GoalLanding | undefined {
  let current: number | null = first;
  for (let hops = 0; current !== null && hops <= limit; hops += 1) {
    const held = landings.get(current);
    if (held !== undefined && held.onIntegration !== false) return held;
    current = carrierOf(current);
  }
  return undefined;
}

function mergedAfter(pr: PullRequest | undefined, carrier: PullRequest | undefined): boolean {
  if (pr?.closedAt === undefined || carrier?.closedAt === undefined || prState(carrier) !== 'merged') return false;
  return pr.closedAt > carrier.closedAt;
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
  return allPulls(world).filter((pr) => prState(pr) === 'merged');
}

function allPulls(world: WorldSnapshot): PullRequest[] {
  return [...world.pullRequests, ...(world.closedPullRequests ?? [])];
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
