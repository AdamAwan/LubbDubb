import type { AppState, OpenPullRequest } from '../types.js';
import { goalNumber, goalOfPr } from './goalRefs.js';

// → docs/spec/17-cockpit.md#grouped-by-goal-stacks-as-a-tree

interface RackRung {
  pr: OpenPullRequest;
  depth: number;
  base: number | null;
}

export interface RackGoal {
  goal: string | null;
  rungs: RackRung[];
}

export function rackByGoal(state: AppState, prs: readonly OpenPullRequest[]): RackGoal[] {
  const baseOf = stackBases(state);
  const groups = new Map<string | null, OpenPullRequest[]>();
  for (const pr of prs) {
    const goal = goalOfPr(state, pr.number);
    pushTo(groups, goal, pr);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => goalOrder(a) - goalOrder(b))
    .map(([goal, members]) => ({ goal, rungs: tree(members, baseOf) }));
}

function stackBases(state: AppState): Map<number, number> {
  const bases = new Map<number, number>();
  for (const stack of state.stacks ?? []) {
    stack.rungs.forEach((rung, i) => {
      const below = stack.rungs[i - 1];
      if (below !== undefined) bases.set(rung.prNumber, below.prNumber);
    });
  }
  return bases;
}

function goalOrder(goal: string | null): number {
  if (goal === null) return Infinity;
  return goalNumber(goal) ?? Number.MAX_SAFE_INTEGER;
}

const MAX_DEPTH = 4;

function tree(members: OpenPullRequest[], baseOf: ReadonlyMap<number, number>): RackRung[] {
  const sorted = [...members].sort((a, b) => a.number - b.number);
  const inGroup = new Set(sorted.map((pr) => pr.number));
  const children = new Map<number, OpenPullRequest[]>();
  const roots: OpenPullRequest[] = [];
  for (const pr of sorted) {
    const base = baseOf.get(pr.number);
    if (base === undefined || !inGroup.has(base)) roots.push(pr);
    else pushTo(children, base, pr);
  }
  const out: RackRung[] = [];
  const seen = new Set<number>();
  const walk = (pr: OpenPullRequest, depth: number): void => {
    if (seen.has(pr.number)) return;
    seen.add(pr.number);
    out.push({ pr, depth: Math.min(depth, MAX_DEPTH), base: baseOf.get(pr.number) ?? null });
    for (const child of children.get(pr.number) ?? []) walk(child, depth + 1);
  };
  for (const pr of [...roots, ...sorted]) walk(pr, 0);
  return out;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
