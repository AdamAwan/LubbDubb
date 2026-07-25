import type { Plan, PlanPart, PlanStatus } from '../types.js';

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

/**
 * The parts a plan is still delivering — everything an amended plan hasn't
 * retired. Every count, roll-up and prompt reads this rather than the raw rows,
 * so a retired part stays visible in the graph without being counted as work.
 */
export function liveParts(parts: PlanPart[]): PlanPart[] {
  return parts.filter((p) => p.status !== 'retired');
}

/** How far a plan has got, for the cockpit's per-issue chip. */
export function planProgress(parts: PlanPart[]): { merged: number; total: number } {
  const live = liveParts(parts);
  return { merged: live.filter((p) => p.status === 'merged').length, total: live.length };
}

/**
 * Has anything real been started for this part? An agent ran, a branch exists, a
 * PR is open, or it merged. The dividing line an amended plan respects: intent
 * can be rewritten freely, work that reached the outside world cannot.
 */
export function partHasWork(part: PlanPart): boolean {
  return part.status === 'dispatched' || part.status === 'in_review' || part.status === 'merged';
}

/**
 * Amending a plan: which existing parts the new declaration retires.
 * `upsertPlanParts` merges on slug and never deletes, so without this a part
 * dropped from an amended plan simply lingers, indistinguishable from one still
 * to come.
 *
 * A part the planner no longer declares is retired **only when nothing was
 * started for it**. One with an agent on it, a branch, or an open/merged PR is
 * left exactly as it is: retiring it would strand a PR that the reconciler still
 * folds reality onto, and a human reviewing that PR would have no idea the
 * harness had written it off. Un-declaring in-flight work is a request to *stop*,
 * which is a kill, not a plan edit.
 */
export function partsToRetire(existing: PlanPart[], declared: string[]): PlanPart[] {
  const keep = new Set(declared);
  return existing.filter((p) => !keep.has(p.slug) && p.status !== 'retired' && !partHasWork(p));
}

/**
 * The status an amended plan resolves to, given the parts that survive the
 * amendment. A `parts` verdict is always `active` (the roll-up moves it to
 * `complete` when the last part merges).
 *
 * A `single` verdict can only stand while nothing is in flight. Once a part has a
 * branch or a PR, the issue *is* already split: collapsing it back would hand rule
 * 4 the flat `issue/<n>` branch, which git cannot create beside the existing
 * `issue/<n>/<slug>` refs, and would orphan the open PRs besides. So the plan stays
 * `active` and the caller says so out loud rather than the collapse failing later
 * as an unattributable git error.
 */
export function amendedPlanStatus(verdict: 'single' | 'parts', surviving: PlanPart[]): PlanStatus {
  if (verdict === 'parts') return 'active';
  return surviving.some(partHasWork) ? 'active' : 'single';
}

/**
 * The current plan, rendered for a *replanning* agent — the state the `issue-plan`
 * template has no placeholder for, and the whole reason a replan is more than a
 * re-run. It has to carry each part's slug (the merge key an amendment turns on)
 * and each part's real-world position, because what the planner may still change
 * depends entirely on whether work has left the harness.
 */
export function currentPlanSummary(plan: Plan, parts: PlanPart[]): string {
  const live = liveParts(parts);
  if (live.length === 0) return `The current plan is "${plan.status}" and declares no parts.`;
  const lines = live.map((p) => {
    const where = p.prNumber !== null ? `PR #${p.prNumber}` : (p.branch ?? 'no branch yet');
    const dep = p.dependsOn[0];
    const stacks = dep === undefined ? '' : `, stacks on "${dep}"`;
    return `- "${p.slug}": ${p.title} [${p.status}, ${where}${stacks}] — ${p.scope}`;
  });
  const why = plan.reason ? `\nIt was split because: ${plan.reason}` : '';
  return `The current plan is "${plan.status}" with ${live.length} part(s).${why}\n${lines.join('\n')}`;
}

/**
 * What a part agent is told about its siblings — goal 3 of the design, and the
 * thing a second agent on the same issue has never had. Split by whether the work
 * exists yet, because the two halves mean different things to the agent: the first
 * is code it may find on its branch and must not redo, the second is work that is
 * explicitly *not* its to do.
 */
export function siblingContext(parts: PlanPart[], current: PlanPart): { done: string; remaining: string } {
  const others = liveParts(parts).filter((p) => p.slug !== current.slug);
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
