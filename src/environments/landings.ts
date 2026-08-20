import type { PullRequest, WorkNode, WorldSnapshot } from '../types.js';
import { issueForPr } from '../prIssue.js';
import { prState } from '../prHealth.js';

/** One merge to attribute: the pull request, the goal it was for, and the commit it landed as. */
interface LandingToRecord {
  prNumber: number;
  goalRef: string;
  sha: string;
}

/** Everything the fold reads. */
interface LandingSweepInput {
  world: WorldSnapshot;
  /** The persisted work graph, which remembers a merge long after the closed window forgets it. */
  nodes: WorkNode[];
  /** Pull requests already attributed — `Store.landedPrs()`. */
  landed: ReadonlySet<number>;
}

/**
 * Every merged pull request carrying a merge commit that nothing has attributed to
 * a goal yet.
 *
 * **A sweep, not a hook on the merge.** Attributing on the pulse that *saw* the
 * transition is the shape that loses landings silently: the harness restarts across
 * it, or a person merges in the web UI between two pulses, and that commit is never
 * recorded — which the cockpit then draws identically to work that never shipped.
 * Asking "which merges have no landing" instead means any pulse inside
 * `closedPrWindowMs` records it, and the first pulse after this feature ships
 * back-fills every merge already in the window.
 *
 * What it cannot reach is a pull request that merged and left the window before any
 * pulse saw it — the harness down for longer than `closedPrWindowMs`. That landing
 * is lost rather than wrong: {@link goalReach} counts the goal's merges the sweep
 * could not attribute and reports `unknown`, never `absent`.
 * → `docs/spec/24-environments.md#recording-a-landing`
 */
export function unrecordedLandings(input: LandingSweepInput): LandingToRecord[] {
  const goals = goalOfPr(input.nodes);
  const out: LandingToRecord[] = [];
  for (const pr of mergedPulls(input.world)) {
    if (input.landed.has(pr.number)) continue;
    if (pr.mergeCommitSha === undefined || pr.mergeCommitSha === '') continue;
    const goalRef = goals.get(pr.number) ?? issueRefFor(pr, input.world);
    if (goalRef === null) continue;
    out.push({ prNumber: pr.number, goalRef, sha: pr.mergeCommitSha });
  }
  return out;
}

/**
 * How many of a goal's merged pull requests have no landing recorded — the count
 * that separates "this goal has not reached the environment" from "nobody can say".
 *
 * Read from the **work graph**, not the world: `closedPullRequests` forgets a merge
 * after `closedPrWindowMs`, so a world-only count would report every goal fully
 * accounted for the moment its merges aged out, which is exactly backwards.
 */
export function unattributedMerges(goalRef: string, nodes: WorkNode[], landed: ReadonlySet<number>): number {
  const goals = goalOfPr(nodes);
  let n = 0;
  for (const node of nodes) {
    if (node.kind !== 'pr' || node.status !== 'merged') continue;
    const number = prNumberOf(node.ref);
    if (number === null || goals.get(number) !== goalRef) continue;
    if (!landed.has(number)) n += 1;
  }
  return n;
}

/** Open and recently-closed together — a provider may report a merge in either list. */
function mergedPulls(world: WorldSnapshot): PullRequest[] {
  return [...world.pullRequests, ...(world.closedPullRequests ?? [])].filter((pr) => prState(pr) === 'merged');
}

/**
 * Each PR node's goal, by walking `parentRef` to the `issue:` root.
 *
 * The graph is the right source because it is the one that *persists* the edge: a
 * pull request whose branch was reaped and whose issue the world has closed still
 * has its node and its parent chain. The world-side {@link issueForPr} is the
 * fallback for the case the graph cannot serve: a merged pull request whose node
 * the fold never gave a parent, because nothing ever linked it to a goal.
 */
function goalOfPr(nodes: WorkNode[]): Map<number, string> {
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const out = new Map<number, string>();
  for (const node of nodes) {
    if (node.kind !== 'pr') continue;
    const number = prNumberOf(node.ref);
    if (number === null) continue;
    // Bounded by the node count: a cycle would otherwise be an infinite walk, and
    // `parentRef` is written by a fold that has no opinion about acyclicity.
    let current: WorkNode | undefined = node;
    for (let hops = 0; hops < nodes.length && current !== undefined; hops += 1) {
      if (current.ref.startsWith('issue:')) {
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
  return issue === null ? null : `issue:${issue.number}`;
}

function prNumberOf(ref: string): number | null {
  const m = /^pr:(\d+)$/.exec(ref);
  return m?.[1] === undefined ? null : Number(m[1]);
}
