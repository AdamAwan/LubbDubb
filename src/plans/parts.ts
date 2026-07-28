import { prState } from '../prHealth.js';
import type { PartOutcomeKind, Plan, PlanPart, PlanStatus, PullRequest } from '../types.js';

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
  if (partSettled(dep)) return true;
  if (dep.status === 'dispatched' || dep.status === 'in_review') return pushed(dep);
  return false;
}

/**
 * The base a part's branch is cut from: its dependency's branch while that
 * dependency is still in flight (this is the stack), the integration branch once
 * the dependency reached a terminal or when there is none.
 *
 * `partSettled` rather than `merged` is load-bearing here, not tidiness. A
 * *concluded* dependency produced no pull request and may never have pushed its
 * branch at all, so returning that branch would hand `WorktreeManager.ensure` a ref
 * it cannot resolve — which throws, deliberately, rather than falling back to an
 * incidental base.
 */
export function partBase(
  part: PlanPart,
  index: Map<string, PlanPart>,
  issueNumber: number,
  defaultBranch: string,
): string {
  const dep = dependencyOf(part, index);
  if (!dep || partSettled(dep)) return defaultBranch;
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

/**
 * Has this part reached a terminal?
 *
 * `merged` and `concluded` both mean finished, and this is the one place that says
 * so. Every roll-up, progress count, dependency test and sibling description asks
 * it rather than comparing to `merged` — which is what stops those sites drifting
 * into disagreeing about what "done" is, the way two independent readings always
 * eventually do.
 */
export function partSettled(part: PlanPart): boolean {
  return part.status === 'merged' || part.status === 'concluded';
}

/**
 * What a part produced, or null while it is still in flight.
 *
 * `code` is **derived from `merged`, never stored**: a part that merged a pull
 * request has said what it produced by producing it, and writing the column too
 * would put a second answer inside `observePartPr`'s path — one more thing the PR
 * fold could get wrong, for nothing.
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
 * observable, the caller's other folds get a turn".
 *
 * The readings, in the order they're allowed to fire:
 *
 * 1. **An open PR on the branch** — the part is in review. Unchanged.
 * 2. **A merged PR** in the closed window, matched by branch *or* number. Merged
 *    is terminal and idempotent, so the looser match is safe and catches a part
 *    whose PR opened and merged between two pulses.
 * 3. **A closed-unmerged PR**, matched by **number only**, and only when this
 *    part was tracking that number. It goes back to `ready` with `prNumber`
 *    cleared, so the plan re-does the work instead of quietly completing on an
 *    abandoned PR. Matching by *branch* here would be a trap: a dead PR sits in
 *    the retention window for hours, so the part would be yanked back to `ready`
 *    on every pulse — including the ones after it was re-dispatched. Clearing the
 *    number is what makes the transition fire exactly once.
 * 4. **Absence** — the pre-existing inference, and still the fallback: a part
 *    that *was* in review whose PR is in neither list merged, out of sight. It
 *    has to stay, or a PR that merged before the retention window would read as
 *    un-merged and its plan would reopen days of finished work. The observed
 *    signals above replace the inference only *within* the window.
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
 * The status an ingested (or amended) plan resolves to, given the parts that
 * survive it. A `parts` verdict is `active` (the roll-up moves it to `complete`
 * when the last part merges) — or `awaiting_approval` when the operator asked to
 * approve decompositions before anything is scheduled from them (issue #109
 * phase 3). That is the whole implementation of the gate on the write side: the
 * status *is* the verdict's standing, so releasing it is a one-way transition on
 * this row rather than a proposal lookup that could expire or be re-read wrongly.
 *
 * `requireApproval` gates only the `parts` arm. A `single` verdict proposes
 * nothing — it is the path the funnel already falls open to — so gating it would
 * park an issue on a question with no decision in it.
 *
 * A `single` verdict can only stand while nothing is in flight. Once a part has a
 * branch or a PR, the issue *is* already split: collapsing it back would hand rule
 * 4 the flat `issue/<n>` branch, which git cannot create beside the existing
 * `issue/<n>/<slug>` refs, and would orphan the open PRs besides. So the plan stays
 * `active` and the caller says so out loud rather than the collapse failing later
 * as an unattributable git error.
 */
export function amendedPlanStatus(
  verdict: 'single' | 'parts',
  surviving: PlanPart[],
  requireApproval = false,
): PlanStatus {
  if (verdict === 'parts') return requireApproval ? 'awaiting_approval' : 'active';
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
    const where =
      p.status === 'concluded'
        ? `${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'}`
        : p.prNumber !== null
          ? `PR #${p.prNumber}`
          : (p.branch ?? 'no branch yet');
    const dep = p.dependsOn[0];
    const stacks = dep === undefined ? '' : `, stacks on "${dep}"`;
    // Only when it says something: every other part is expected to produce code,
    // and saying so on each line would bury the two that don't.
    const expects = p.expectedKind && p.expectedKind !== 'code' ? `, planned as a ${p.expectedKind}` : '';
    return `- "${p.slug}": ${p.title} [${p.status}, ${where}${stacks}${expects}] — ${p.scope}`;
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
  const exists = (p: PlanPart): boolean => partSettled(p) || p.status === 'in_review';
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
      // A concluded part left a record, not code. Naming a PR or a branch for one
      // would send the agent looking on disk for work that was never written.
      const where =
        p.status === 'concluded'
          ? ` (${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'})`
          : p.prNumber !== null
            ? ` (PR #${p.prNumber})`
            : p.branch !== null
              ? ` (branch ${p.branch})`
              : '';
      return `- ${p.title} [${p.slug}, ${p.status}${where}] — ${p.scope}`;
    })
    .join('\n');
}

/**
 * What a part expected to produce no code is told, appended to its rendered prompt.
 *
 * **Appended, never filled into the template.** Prompt templates are
 * operator-overridable and `loadPromptTemplates` rejects only *unknown*
 * placeholders, so a `{kind}` token would be silently dropped by exactly the
 * deployments that customised most — and this is the instruction without which the
 * part cannot finish at all. Appending has no fallback to get wrong. Same reason
 * `outstandingWorkNote` and the rejection note append.
 *
 * Empty for a `code` or unstated part: its prompt already tells it to open a pull
 * request, and a part that turns out to need no code learns `conclude_part` from
 * the tool list, where a tool belongs.
 */
export function partOutcomeNote(part: PlanPart): string {
  if (!part.expectedKind || part.expectedKind === 'code') return '';
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
