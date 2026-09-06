import { prState } from '../prHealth.js';
import { prRef, type PrRefStyle } from '../prRef.js';
import type { PartOutcomeKind, Plan, PlanPart, PullRequest } from '../types.js';

/**
 * Scheduling a multi-PR plan's parts, as pure functions over the part rows. The
 * store holds intent and the reconciler folds reality onto it; everything here is
 * derived, so the dispatcher and the cockpit cannot disagree about a plan.
 */

/** The origin a part's agent is dispatched against — per-part, so every origin-keyed mechanism works unchanged. */
export function partOrigin(issueNumber: number, slug: string): string {
  return `issue:${issueNumber}:part:${slug}`;
}

/**
 * The branch a part works on. Git stores refs as files, so `refs/heads/issue/12`
 * and `refs/heads/issue/12/<slug>` cannot coexist — why the planner lives on
 * `plan/issue/<n>` and an issue ever worked as `single` blocks its own parts.
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
 * A part's declared dependencies, in declared order, skipping any slug the
 * index doesn't hold. Several prerequisites is a rejoin, allowed because it
 * starts only once all have settled; two still in flight is refused by
 * `PlanReconciler.readiness`.
 */
export function dependenciesOf(part: PlanPart, index: Map<string, PlanPart>): PlanPart[] {
  const deps: PlanPart[] = [];
  for (const slug of part.dependsOn) {
    const dep = index.get(slug);
    if (dep) deps.push(dep);
  }
  return deps;
}

/**
 * How deep in a stack a part sits — 0 for a part with no dependency. Bottoms
 * are dispatched first. Longest path, not `dependsOn[0]`, or a rejoin sorts
 * ahead of something it waits on; cycle-guarded, since this runs against
 * whatever the store holds.
 */
export function partDepth(part: PlanPart, index: Map<string, PlanPart>): number {
  const depths = new Map<string, number>();
  const walking = new Set<string>();
  const depthOf = (current: PlanPart): number => {
    const cached = depths.get(current.slug);
    if (cached !== undefined) return cached;
    if (walking.has(current.slug)) return 0;
    walking.add(current.slug);
    let deepest = 0;
    for (const dep of dependenciesOf(current, index)) deepest = Math.max(deepest, depthOf(dep) + 1);
    walking.delete(current.slug);
    depths.set(current.slug, deepest);
    return deepest;
  };
  return depthOf(part);
}

/**
 * Has a part produced a branch a dependent could actually base on? Settled is
 * unconditional; otherwise the branch must carry commits beyond the
 * integration branch. `pushed` is the git observer's answer, the only source
 * that sees a branch before a PR exists.
 */
export function dependencySatisfied(dep: PlanPart, pushed: (part: PlanPart) => boolean): boolean {
  if (partSettled(dep)) return true;
  if (dep.status === 'dispatched' || dep.status === 'in_review') return pushed(dep);
  return false;
}

/**
 * The base a part's branch is cut from: its one unsettled dependency's branch
 * while that is in flight, the integration branch otherwise. Declared order
 * decides rather than throwing on two in flight — a wrong base is a rebase, a
 * throw takes the pulse's whole dispatch down. `partSettled`, not `merged`, is
 * load-bearing: a concluded dependency may never have pushed its branch.
 */
export function partBase(
  part: PlanPart,
  index: Map<string, PlanPart>,
  issueNumber: number,
  defaultBranch: string,
): string {
  const dep = dependenciesOf(part, index).find((d) => !partSettled(d));
  if (!dep) return defaultBranch;
  return dep.branch ?? partBranch(issueNumber, dep.slug);
}

/**
 * The parts a plan is still delivering — everything an amended plan hasn't
 * retired. Every count, roll-up and prompt reads this rather than the raw rows,
 * so a retired part stays visible in the graph without being counted as work.
 */
export function liveParts(parts: readonly PlanPart[]): PlanPart[] {
  return parts.filter((p) => p.status !== 'retired');
}

/**
 * Is this plan still scheduling something for its issue? The one reading of "the
 * plan owns this issue", asked by the conclusion resolver and rule `issue-assess`.
 * Purely a question about the plan's lifecycle — the parts have no bearing on it.
 */
export function planInFlight(plan: Plan): boolean {
  return plan.status === 'active' || plan.status === 'planning' || plan.status === 'awaiting_approval';
}

/**
 * Has this part reached a terminal? `merged` and `concluded` both mean finished,
 * and this is the one place that says so — every roll-up, count, dependency test
 * and sibling description asks it rather than comparing to `merged`.
 */
export function partSettled(part: PlanPart): boolean {
  return part.status === 'merged' || part.status === 'concluded';
}

/**
 * Is this part work a person does by hand rather than work an agent is dispatched
 * for? The one predicate that says so. It reads the *declaration*, never the
 * backing `human_tasks` row: a human part whose row failed to write must still be
 * recognisable from the part alone, or it is quietly dispatched to an agent.
 */
export function partIsHuman(part: PlanPart): boolean {
  return part.expectedKind === 'human';
}

/**
 * What a part produced, or null while it is still in flight. `code` is **derived
 * from `merged`, never stored** — storing it would put a second answer inside
 * `observePartPr`'s path.
 */
export function partOutcomeKind(part: PlanPart): PartOutcomeKind | null {
  if (part.status === 'merged') return 'code';
  if (part.status === 'concluded') return part.outcomeKind;
  return null;
}

/** How far a plan has got, for the cockpit's per-issue chip. Counts every terminal, not just merges. */
export function planProgress(parts: PlanPart[]): { settled: number; total: number } {
  const live = liveParts(parts);
  return { settled: live.filter(partSettled).length, total: live.length };
}

/**
 * What the world says about one part's pull request — the pure core of
 * `PlanReconciler.foldPr`. Returns the patch to apply, or null for "nothing
 * observable". Four readings, in the order they may fire: an open PR on the
 * branch (in review); a merged PR matched by branch *or* number (terminal,
 * idempotent, safe to match loosely); a closed-unmerged PR matched by
 * **number only** and only when this part tracked it (back to `ready`,
 * clearing the number so the transition fires exactly once); or absence — a
 * part that *was* in review whose PR merged out of the retention window,
 * which must still read as merged rather than reopening finished work.
 */
export function observePartPr(
  part: PlanPart,
  branch: string,
  openPrs: PullRequest[],
  closedPrs: PullRequest[],
): Partial<PlanPart> | null {
  const open = openPrs.find((p) => p.branch === branch) ?? openPrs.find((p) => p.number === part.prNumber);
  if (open) {
    return open.merged
      ? { status: 'merged', branch, prNumber: open.number }
      : { status: 'in_review', branch, prNumber: open.number };
  }

  const merged = closedPrs.find((p) => prState(p) === 'merged' && (p.branch === branch || p.number === part.prNumber));
  if (merged) return { status: 'merged', branch, prNumber: merged.number };

  if (part.prNumber !== null) {
    const abandoned = closedPrs.find((p) => p.number === part.prNumber && prState(p) === 'closed');
    if (abandoned) return { status: 'ready', branch, prNumber: null };
  }

  if (part.status === 'in_review' && part.prNumber !== null) return { status: 'merged' };
  return null;
}

/**
 * Has anything real been started for this part? An agent ran, a branch exists, a
 * PR is open, or it merged. The dividing line an amended plan respects: intent
 * can be rewritten freely, work that reached the outside world cannot.
 */
export function partHasWork(part: PlanPart): boolean {
  return part.status === 'dispatched' || part.status === 'in_review' || partSettled(part);
}

/**
 * Amending a plan: which existing parts the new declaration retires.
 * `upsertPlanParts` merges on slug and never deletes, so without this a
 * dropped part lingers. Retired only when nothing was started for it —
 * retiring in-flight work would strand a PR the reconciler still folds onto.
 */
export function partsToRetire(existing: PlanPart[], declared: string[]): PlanPart[] {
  const keep = new Set(declared);
  return existing.filter((p) => !keep.has(p.slug) && p.status !== 'retired' && !partHasWork(p));
}

/**
 * The current plan, rendered for a *replanning* agent. It has to carry each part's
 * slug (the merge key an amendment turns on) and its real-world position, since
 * what the planner may still change depends on whether work has left the harness.
 */
export function currentPlanSummary(plan: Plan, parts: PlanPart[], style: PrRefStyle): string {
  const live = liveParts(parts);
  if (live.length === 0) return `The current plan is "${plan.status}" and declares no parts.`;
  const lines = live.map((p) => {
    const where =
      p.status === 'concluded'
        ? `${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'}`
        : p.prNumber !== null
          ? `PR ${prRef(p.prNumber, style)}`
          : (p.branch ?? 'no branch yet');
    // Every declared prerequisite, not the first — naming one of a rejoin's two
    // would invite the replanner to drop the other.
    const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
    // Only when it says something — every other part expects code.
    const expects = partIsHuman(p)
      ? ', a step for a person'
      : p.expectedKind && p.expectedKind !== 'code'
        ? `, planned as a ${p.expectedKind}`
        : '';
    // A replanner silently empties `touches` on an unchanged part otherwise.
    const owns = p.touches.length === 0 ? '' : `\n  touches: ${p.touches.join(', ')}`;
    const size = p.size === null ? '' : `\n  size: ${p.size}`;
    const done = p.acceptance === null ? '' : `\n  done when: ${p.acceptance}`;
    return `- "${p.slug}": ${p.title} [${p.status}, ${where}${stacks}${expects}] — ${p.scope}${owns}${size}${done}`;
  });
  const why = plan.reason ? `\nIt was split because: ${plan.reason}` : '';
  return `The current plan is "${plan.status}" with ${live.length} part(s).${why}\n${lines.join('\n')}`;
}

/**
 * What a part agent is told about its siblings, split by whether the work exists
 * yet: the first half is code it may find on its branch and must not redo, the
 * second is work that is explicitly not its to do.
 */
export function siblingContext(
  parts: PlanPart[],
  current: PlanPart,
  style: PrRefStyle,
): { done: string; remaining: string } {
  const others = liveParts(parts).filter((p) => p.slug !== current.slug);
  const exists = (p: PlanPart): boolean => partSettled(p) || p.status === 'in_review';
  return {
    done: describe(others.filter(exists), 'Nothing has landed yet — this is the first part.', style),
    remaining: describe(
      others.filter((p) => !exists(p)),
      'Nothing — this is the last part.',
      style,
    ),
  };
}

function describe(parts: PlanPart[], empty: string, style: PrRefStyle): string {
  if (parts.length === 0) return empty;
  return parts
    .map((p) => {
      // A concluded part left a record, not code. Naming a PR or a branch for one
      // would send the agent looking on disk for work that was never written.
      const where =
        p.status === 'concluded'
          ? ` (${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'})`
          : p.prNumber !== null
            ? ` (PR ${prRef(p.prNumber, style)})`
            : p.branch !== null
              ? ` (branch ${p.branch})`
              : '';
      return `- ${p.title} [${p.slug}, ${p.status}${where}] — ${p.scope}`;
    })
    .join('\n');
}

/** One thing a part is done when, and whether a reviewer has said it is true. */
export interface AcceptanceCriterion {
  text: string;
  met: boolean;
}

/**
 * A part's `acceptance` as the checklist the sheet draws. Split on lines rather
 * than sentences (splitting prose on `.` would cut a path in half). Derived on the
 * server and shipped: the tick is stored against the criterion's own **text**, so a
 * second implementation of this split is a tick that silently never matches.
 */
export function acceptanceCriteria(part: PlanPart): AcceptanceCriterion[] {
  if (part.acceptance === null) return [];
  const met = new Set(part.acceptanceMet);
  return part.acceptance
    .split('\n')
    .map((line) =>
      line
        // List markers only: the text is the key, so anything stripped here must
        // be stripped identically forever or every stored tick is orphaned.
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .trim(),
    )
    .filter((text) => text !== '')
    .map((text) => ({ text, met: met.has(text) }));
}

/**
 * The two things a part's own declaration says that its rendered prompt does
 * not: the paths it was given, and what "done" means. Appended, never
 * interpolated. Empty when the planner declared neither.
 */
export function partDeclarationNote(part: PlanPart): string {
  if (part.touches.length === 0 && part.acceptance === null) return '';
  const lines: string[] = [];
  if (part.touches.length > 0) {
    lines.push(
      `**The paths this part owns**, as its planner declared them:\n${part.touches.map((p) => `- ${p}`).join('\n')}\n\n` +
        `Writing outside them is not blocked, and sometimes it is right — but it is recorded and shown to the ` +
        `operator beside this part, so if you have to, say why in your pull request.`,
    );
  }
  if (part.acceptance !== null) {
    lines.push(
      `**This part is done when:** ${part.acceptance}\n\nA reviewer is shown that as a checklist against your ` +
        `pull request, so treat it as the specification rather than as a summary of one.`,
    );
  }
  return `\n\n---\n\n${lines.join('\n\n')}`;
}

/**
 * What a part expected to produce no code is told, appended to its rendered
 * prompt, never interpolated. Empty for a `code` or unstated part.
 * → `docs/spec/09-execution.md`
 */
export function partOutcomeNote(part: PlanPart): string {
  // A human part never reaches an agent — `partIsHuman` keeps it out of the
  // candidate list entirely — so there is no prompt for this to be appended to.
  if (!part.expectedKind || part.expectedKind === 'code' || partIsHuman(part)) return '';
  const what =
    part.expectedKind === 'report'
      ? 'a write-up, a measurement or a document — not a change to the code'
      : 'a determination: whether anything needs doing here at all, and the evidence for it';
  return (
    `\n\n---\n\nThis part was planned to produce ${what}. So it may well end with no pull request, and ` +
    `that is success rather than failure. When you have finished, call **conclude_part** with kind ` +
    `"${part.expectedKind}" and a summary of what you found. That is the only thing that closes a part ` +
    `with no pull request behind it — until you do, this plan and its issue stay open. If the work turns ` +
    `out to need code after all, ignore this and open a pull request as normal.`
  );
}
