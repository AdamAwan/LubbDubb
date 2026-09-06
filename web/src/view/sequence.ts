import type { FeatureSequenceEdge } from '../types.js';

// → docs/spec/17-cockpit.md

interface Wave {
  depth: number;
  issues: number[];
}

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

export function waitsOn(issue: number, edges: readonly FeatureSequenceEdge[]): number[] {
  return edges
    .filter((e) => e.issue === issue)
    .map((e) => e.dependsOn)
    .sort((a, b) => a - b);
}

export function waitingOnThis(issue: number, edges: readonly FeatureSequenceEdge[]): number[] {
  return edges
    .filter((e) => e.dependsOn === issue)
    .map((e) => e.issue)
    .sort((a, b) => a - b);
}

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
