import type { FeatureSequenceEdge } from '../types.js';

/**
 * Waves, derived from an order's edges on read.
 *
 * A wave is **depth in the edge graph**, and it is computed here rather than
 * shipped on the wire for `layoutFloor`'s reason (`web/src/view/workGraph.ts`): a
 * stored wave number would be a second answer to a question the edges already
 * settle, and the two would part company the first time an edge was amended.
 * `partDepth` in `src/plans/parts.ts` computes the same longest-path depth for a
 * plan's parts, and the two are deliberately not shared — `test/workGraph.test.ts`
 * asserts `src/` and `web/` stay apart.
 *
 * Waves are the right vocabulary for the surface because they are honest about
 * parallelism: everything at one depth runs together. A numbered list would read as
 * a chain and would quietly claim an order between two stories nobody ordered.
 * → `docs/spec/33-story-sequencing.md#waves-are-derived-never-stored`
 */

/** One depth of an order: the stories that can all start together. */
interface Wave {
  /** 0 is the first wave — the stories that wait on nothing. */
  depth: number;
  /** The stories at this depth, ascending. */
  issues: number[];
}

/**
 * How deep a story sits — 0 for one that waits on nothing.
 *
 * **Longest path, not the first prerequisite listed.** A story waiting on several
 * must never draw above something it waits on, and `edges[0]` gets that wrong the
 * first time an order rejoins. Cycle-guarded by the walking set: ingestion refuses
 * cycles, but this runs against whatever the payload happens to carry, and a
 * display heuristic must not spin.
 */
export function waveOf(issue: number, edges: readonly FeatureSequenceEdge[]): number {
  const deps = dependencyIndex(edges);
  const depths = new Map<number, number>();
  const walking = new Set<number>();
  const depthOf = (node: number): number => {
    const cached = depths.get(node);
    if (cached !== undefined) return cached;
    if (walking.has(node)) return 0;
    walking.add(node);
    let deepest = 0;
    for (const dep of deps.get(node) ?? []) deepest = Math.max(deepest, depthOf(dep) + 1);
    walking.delete(node);
    depths.set(node, deepest);
    return deepest;
  };
  return depthOf(issue);
}

/**
 * These stories, grouped into waves and ordered by depth.
 *
 * Every story passed in comes back in exactly one wave, whether or not the order
 * mentions it: a story with no edge waits on nothing and belongs in the first, and
 * one silently dropped would be a story the card claimed the Feature did not have.
 */
export function wavesOf(issues: readonly number[], edges: readonly FeatureSequenceEdge[]): Wave[] {
  const byDepth = new Map<number, number[]>();
  for (const issue of issues) {
    const depth = waveOf(issue, edges);
    const group = byDepth.get(depth);
    if (group) group.push(issue);
    else byDepth.set(depth, [issue]);
  }
  return [...byDepth.entries()]
    .map(([depth, group]) => ({ depth, issues: group.sort((a, b) => a - b) }))
    .sort((a, b) => a.depth - b.depth);
}

/** What this story waits on, ascending. Empty for one in the first wave. */
export function waitsOn(issue: number, edges: readonly FeatureSequenceEdge[]): number[] {
  return edges
    .filter((e) => e.issue === issue)
    .map((e) => e.dependsOn)
    .sort((a, b) => a - b);
}

/**
 * What waits on **this** story, ascending — the reading the Goal page's folded
 * header carries.
 *
 * Direct dependants only, not the transitive tail. "2 waiting on this" is a fact an
 * operator can check against the card in front of them; a transitive count would be
 * a number nothing on the page adds up to.
 */
export function waitingOnThis(issue: number, edges: readonly FeatureSequenceEdge[]): number[] {
  return edges
    .filter((e) => e.dependsOn === issue)
    .map((e) => e.issue)
    .sort((a, b) => a - b);
}

/**
 * What accepting this order costs: how many of these stories would start now and
 * will not once it holds.
 *
 * On the proposal card because without it the operator is agreeing to a hold whose
 * size is not on the card. Counted over the stories the caller passes — the ones
 * actually open — so a Feature whose later waves have all merged says nothing is
 * held, which is true.
 */
export function heldByAccepting(issues: readonly number[], edges: readonly FeatureSequenceEdge[]): number {
  const open = new Set(issues);
  return issues.filter((issue) => edges.some((e) => e.issue === issue && open.has(e.dependsOn))).length;
}

function dependencyIndex(edges: readonly FeatureSequenceEdge[]): Map<number, number[]> {
  const deps = new Map<number, number[]>();
  for (const edge of edges) {
    const from = deps.get(edge.issue);
    if (from) from.push(edge.dependsOn);
    else deps.set(edge.issue, [edge.dependsOn]);
  }
  return deps;
}
