import type { PlanPart } from '../types.js';

/**
 * Scheduling a multi-PR plan's parts, as pure functions over the part rows.
 *
 * The store holds intent and the reconciler folds reality onto it; everything
 * here — readiness, base selection, ordering, the prompt's "what else is going
 * on" context — is derived, so the dispatcher and the cockpit can't disagree
 * about a plan the way two independent readings would.
 */

/** The origin a part's agent is dispatched against — per-part, so every origin-keyed mechanism works unchanged. */
export function partOrigin(issueNumber: number, slug: string): string {
  return `issue:${issueNumber}:part:${slug}`;
}

/**
 * The branch a part works on. Note this is why the planner lives on `plan/issue/<n>`
 * and why an issue that was ever worked as `single` blocks its own parts: git stores
 * refs as files, so `refs/heads/issue/12` and `refs/heads/issue/12/<slug>` cannot
 * coexist — the second needs the first to be a directory.
 */
export function partBranch(issueNumber: number, slug: string): string {
  return `issue/${issueNumber}/${slug}`;
}

/** The issue number a plan hangs off (`issue:12` → 12), or null for a malformed ref. */
export function planIssueNumber(originRef: string): number | null {
  const match = /^issue:(\d+)$/.exec(originRef);
  return match ? Number(match[1]) : null;
}

/** Parts by slug, for the dependency walks below. */
export function bySlug(parts: PlanPart[]): Map<string, PlanPart> {
  return new Map(parts.map((p) => [p.slug, p]));
}

/**
 * A part's single dependency, or null. Ingestion caps `dependsOn` at one entry
 * (see `planDocument.ts`), which is the static form of "a part may stack on at
 * most one *open* dependency" — with two declared dependencies both could be in
 * review at the same moment and there would be no single branch to base on.
 */
export function dependencyOf(part: PlanPart, index: Map<string, PlanPart>): PlanPart | null {
  const slug = part.dependsOn[0];
  return slug === undefined ? null : (index.get(slug) ?? null);
}

/**
 * How deep in a stack a part sits — 0 for a part with no dependency. Bottoms are
 * dispatched first, so the branch a dependent will base on exists sooner. Bounded
 * by the part count so a dependency cycle that survived ingestion can't spin.
 */
export function partDepth(part: PlanPart, index: Map<string, PlanPart>): number {
  let depth = 0;
  let current: PlanPart | null = part;
  const seen = new Set<string>();
  while (current && !seen.has(current.slug)) {
    seen.add(current.slug);
    current = dependencyOf(current, index);
    if (current) depth += 1;
  }
  return depth;
}

/**
 * Has a part produced a branch a dependent could actually base on? `merged` is
 * unconditional; otherwise the branch has to carry commits beyond the integration
 * branch, which is the whole reason `dispatched` isn't enough on its own — a
 * dispatched part's branch exists the moment its worktree does, and basing on an
 * empty branch gains nothing. `pushed` is the git observer's answer (the only
 * source that sees a branch before a PR exists).
 */
export function dependencySatisfied(dep: PlanPart, pushed: (part: PlanPart) => boolean): boolean {
  if (dep.status === 'merged') return true;
  if (dep.status === 'dispatched' || dep.status === 'in_review') return pushed(dep);
  return false;
}

/**
 * The base a part's branch is cut from: its dependency's branch while that
 * dependency is still in flight (this is the stack), the integration branch once
 * the dependency merged or when there is none.
 */
export function partBase(
  part: PlanPart,
  index: Map<string, PlanPart>,
  issueNumber: number,
  defaultBranch: string,
): string {
  const dep = dependencyOf(part, index);
  if (!dep || dep.status === 'merged') return defaultBranch;
  return dep.branch ?? partBranch(issueNumber, dep.slug);
}

/** How far a plan has got, for the cockpit's per-issue chip. */
export function planProgress(parts: PlanPart[]): { merged: number; total: number } {
  return { merged: parts.filter((p) => p.status === 'merged').length, total: parts.length };
}

/**
 * What a part agent is told about its siblings — goal 3 of the design, and the
 * thing a second agent on the same issue has never had. Split by whether the work
 * exists yet, because the two halves mean different things to the agent: the first
 * is code it may find on its branch and must not redo, the second is work that is
 * explicitly *not* its to do.
 */
export function siblingContext(parts: PlanPart[], current: PlanPart): { done: string; remaining: string } {
  const others = parts.filter((p) => p.slug !== current.slug);
  const exists = (p: PlanPart): boolean => p.status === 'merged' || p.status === 'in_review';
  return {
    done: describe(others.filter(exists), 'Nothing has landed yet — this is the first part.'),
    remaining: describe(
      others.filter((p) => !exists(p)),
      'Nothing — this is the last part.',
    ),
  };
}

function describe(parts: PlanPart[], empty: string): string {
  if (parts.length === 0) return empty;
  return parts
    .map((p) => {
      const where = p.prNumber !== null ? ` (PR #${p.prNumber})` : p.branch !== null ? ` (branch ${p.branch})` : '';
      return `- ${p.title} [${p.slug}, ${p.status}${where}] — ${p.scope}`;
    })
    .join('\n');
}
