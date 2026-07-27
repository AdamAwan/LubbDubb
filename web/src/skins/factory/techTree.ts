import type { PlanPart } from '../../types.js';

/**
 * A plan, laid out as a tech tree.
 *
 * `PlanPart.dependsOn` holds at most one slug, enforced at the server's zod
 * boundary — so the graph is a forest of chains that fan out where several parts
 * name the same prerequisite. That is the same shape a tech tree has, which is
 * why this is a tree rather than a nicer-looking stack: depth *is* the number of
 * merges that must land before a part can start, and a list cannot show it.
 *
 * Pure, and separate from the component, because the interesting part is the
 * layout and the interesting part is what wants testing.
 */

/**
 * A part's state in the game's terms. The mapping is one-way from
 * `PlanPart.status`, so nothing here can disagree with the plan panel about
 * whether a part is done.
 */
export type PartState = 'researched' | 'researching' | 'available' | 'locked' | 'blocked';

interface TreeNode {
  part: PlanPart;
  state: PartState;
  /** Dependency depth — 0 for a part that stacks on nothing. */
  col: number;
  /** Position within the column, in `seq` order. */
  row: number;
}

interface TreeEdge {
  fromSlug: string;
  toSlug: string;
  /** The prerequisite has merged, so the edge is a path work can actually travel. */
  lit: boolean;
}

export interface TreeLayout {
  nodes: TreeNode[];
  edges: TreeEdge[];
  cols: number;
  rows: number;
}

/**
 * `retired` is excluded here rather than drawn greyed, matching `liveParts` on
 * the server: a replan that dropped a part dropped it, and showing it would
 * imply the plan still owes that work.
 */
function isLive(part: PlanPart): boolean {
  return part.status !== 'retired';
}

function stateOf(part: PlanPart): PartState {
  switch (part.status) {
    case 'merged':
      return 'researched';
    case 'in_review':
    case 'dispatched':
      return 'researching';
    case 'ready':
      return 'available';
    case 'blocked':
      return 'blocked';
    default:
      return 'locked';
  }
}

/**
 * Depth by walking the dependency chain.
 *
 * Memoised, and guarded with an in-progress set: the server rejects cycles at
 * ingestion, but this runs against whatever the snapshot happens to carry and a
 * cockpit that hangs is a worse failure than one that draws a cycle flat. A
 * prerequisite that is absent (retired by a replan) also reads as depth 0 —
 * nothing is left to wait for.
 */
function depths(parts: PlanPart[]): Map<string, number> {
  const bySlug = new Map(parts.map((p) => [p.slug, p]));
  const out = new Map<string, number>();
  const walking = new Set<string>();

  const depthOf = (part: PlanPart): number => {
    const cached = out.get(part.slug);
    if (cached !== undefined) return cached;
    if (walking.has(part.slug)) return 0;

    const parentSlug = part.dependsOn[0];
    const parent = parentSlug ? bySlug.get(parentSlug) : undefined;
    walking.add(part.slug);
    const depth = parent ? depthOf(parent) + 1 : 0;
    walking.delete(part.slug);

    out.set(part.slug, depth);
    return depth;
  };

  for (const part of parts) depthOf(part);
  return out;
}

export function layoutTechTree(allParts: readonly PlanPart[]): TreeLayout {
  const parts = allParts
    .filter(isLive)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const byDepth = depths(parts);
  const filled = new Map<number, number>();

  const nodes: TreeNode[] = parts.map((part) => {
    const col = byDepth.get(part.slug) ?? 0;
    const row = filled.get(col) ?? 0;
    filled.set(col, row + 1);
    return { part, state: stateOf(part), col, row };
  });

  const live = new Set(parts.map((p) => p.slug));
  const merged = new Set(parts.filter((p) => p.status === 'merged').map((p) => p.slug));
  const edges: TreeEdge[] = [];
  for (const part of parts) {
    const from = part.dependsOn[0];
    if (from && live.has(from)) edges.push({ fromSlug: from, toSlug: part.slug, lit: merged.has(from) });
  }

  return {
    nodes,
    edges,
    cols: Math.max(1, ...nodes.map((n) => n.col + 1)),
    rows: Math.max(1, ...nodes.map((n) => n.row + 1)),
  };
}

/**
 * The research queue: what is being worked, then what could start now.
 *
 * Ordered rather than filtered so the strip answers "what happens next" in one
 * read. Locked parts are deliberately absent — a part whose prerequisite has not
 * merged is not queued for anything, and listing it would put five items in a
 * queue that can only ever start one.
 */
export function researchQueue(layout: TreeLayout): TreeNode[] {
  const rank: Record<PartState, number> = {
    researching: 0,
    available: 1,
    blocked: 2,
    researched: 3,
    locked: 4,
  };
  return layout.nodes
    .filter((n) => n.state === 'researching' || n.state === 'available' || n.state === 'blocked')
    .slice()
    .sort((a, b) => rank[a.state] - rank[b.state] || a.part.seq - b.part.seq);
}
