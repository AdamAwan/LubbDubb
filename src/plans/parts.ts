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
 * A part's declared dependencies, in declared order, skipping any slug the index
 * doesn't hold — an amendment may have retired a part something else still names,
 * and a dangling slug is not a dependency anything can wait for.
 *
 * `dependsOn` used to be capped at one entry at the zod boundary, as the static
 * form of "a part may stack on at most one *open* dependency" (issue #170). The
 * rule it approximated is real; the approximation refused something safe. A part
 * with several prerequisites is a **rejoin**: it starts only once all of them have
 * settled, at which point *none* is open and its base is unambiguously the
 * integration branch. The dangerous case — two dependencies still in flight, with
 * no single branch to cut from — is still refused, but dynamically, by
 * `PlanReconciler.readiness`, which is where the rule was always true.
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
 * How deep in a stack a part sits — 0 for a part with no dependency. Bottoms are
 * dispatched first, so the branch a dependent will base on exists sooner.
 *
 * **Longest path, not the first prerequisite that happens to be listed.** A part
 * waiting on several must never sort ahead of something it waits on, and
 * `dependsOn[0]` gets exactly that wrong the first time a plan rejoins. Cycle-
 * guarded by the walking set: ingestion refuses cycles, but this runs against
 * whatever the store happens to hold, and a dispatch-order heuristic must not spin.
 *
 * (`layoutFloor` in the cockpit's factory skin computes the same longest-path
 * depth for a *column*. Deliberately not shared: the two answer for different
 * purposes, and `test/workGraph.test.ts` asserts `src/` and `web/` stay apart.)
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
 * The base a part's branch is cut from: the branch of its one **unsettled**
 * dependency while that dependency is still in flight (this is the stack), the
 * integration branch once every dependency has reached a terminal or when there are
 * none. So a rejoin — a part naming several prerequisites — bases on the
 * integration branch, because it is only ever asked once all of them have settled.
 *
 * It is never asked to choose between two in-flight dependencies:
 * `PlanReconciler.readiness` holds a part `pending` while more than one is
 * unsettled, which is the dynamic form of the arity cap ingestion used to enforce.
 * Declared order decides if it somehow is, rather than throwing — a base that is
 * merely the wrong one of two is a rebase; a throw here takes the pulse's whole
 * dispatch down.
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
 * How the issue is being delivered — one pull request, or several.
 *
 * **Read, never stored.** The planner's verdict is a decision about shape, and the
 * parts already record it: a `parts` verdict always declares at least one part
 * (`planDocument` refuses an empty one) and ingestion writes them before anything
 * is scheduled, while a `single` verdict retires every part nothing was started
 * for. So "no live parts" *is* the single arm. A column would be a second answer
 * to a question the rows already answer, and a *status* — which is what this was
 * until the shape was pulled out of `PlanStatus` — was worse: it made shape and
 * lifecycle exclusive, so a single-PR plan could never also be `active`.
 */
export function planShape(parts: readonly PlanPart[]): 'single' | 'parts' {
  return liveParts(parts).length === 0 ? 'single' : 'parts';
}

/**
 * Is this plan still scheduling something for its issue?
 *
 * The one reading of "the plan owns this issue", asked by the conclusion resolver
 * and by rule `issue-assess`. Both used to compare the status against a list, and
 * both had to be told about the shape when it stopped being one: an `active` plan
 * with no live parts schedules **nothing** — its issue is worked whole through
 * ordinary pickup — so reading it as in flight would say `more_work` for ever and
 * would hold the assessor off the one arm it exists for.
 */
export function planInFlight(plan: Plan, parts: readonly PlanPart[]): boolean {
  if (plan.status === 'active') return planShape(parts) === 'parts';
  return plan.status === 'planning' || plan.status === 'awaiting_approval';
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
 * Is this part work a person does by hand rather than work an agent is dispatched
 * for? The one predicate that says so, asked by rule `plan-part` (which produces
 * no candidate for one), by the reconciler (which neither folds a PR onto one nor
 * stalls it), and by `partOutcomeNote` (which has no prompt to append to).
 *
 * It reads the *declaration*, not the backing `human_tasks` row, deliberately:
 * a part with no agent, no branch and no PR must be recognisable as such from the
 * part alone, including on the paths that never load the task — otherwise a human
 * part whose row failed to write would quietly be dispatched to an agent, which is
 * the one outcome the whole feature exists to prevent.
 */
export function partIsHuman(part: PlanPart): boolean {
  return part.expectedKind === 'human';
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
 * survive it — `active`, or `awaiting_approval` when the operator asked to approve
 * verdicts before anything is scheduled from them (issue #109 phase 3). That is
 * the whole implementation of the gate on the write side: the status *is* the
 * verdict's standing, so releasing it is a one-way transition on this row rather
 * than a proposal lookup that could expire or be re-read wrongly.
 *
 * Which *shape* was ingested is not written here at all — it is the parts, read
 * back by {@link planShape}.
 *
 * `requireApproval` gates **both** arms. A `single` verdict is a verdict — the
 * planner has decided this issue is one agent, one branch and one pull request,
 * which is a shape an operator may disagree with exactly as they may disagree with
 * a split — so it is put to them too, and nothing is scheduled until they answer.
 * Gating only the `parts` arm meant the commonest route started work with no
 * acceptance step at all, which is the hole this closes.
 *
 * The one arm that is **never gated** is a `single` verdict the world has already
 * overruled: once a part has a branch or a PR, the issue *is* split, and
 * collapsing it back would hand rule `issue-pickup` the flat `issue/<n>` branch
 * git cannot create beside the existing `issue/<n>/<slug>` refs, orphaning the
 * open PRs besides. The collapse is refused, so there is no proposal left in it —
 * asking a human to approve a verdict the harness has already overruled would be a
 * question with no decision in it, on the one path where work is genuinely
 * running. {@link singleOverruled} is that reading, asked by the caller that
 * reports it.
 */
export function amendedPlanStatus(
  verdict: 'single' | 'parts',
  surviving: PlanPart[],
  requireApproval = false,
): PlanStatus {
  if (singleOverruled(verdict, surviving)) return 'active';
  return requireApproval ? 'awaiting_approval' : 'active';
}

/**
 * A `single` verdict the world has already overruled — parts are in flight, so the
 * plan stays split and the caller says so out loud rather than the collapse
 * failing later as an unattributable git error. See {@link amendedPlanStatus}.
 */
export function singleOverruled(verdict: 'single' | 'parts', surviving: PlanPart[]): boolean {
  return verdict === 'single' && surviving.some(partHasWork);
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
    // Every declared prerequisite, not the first: an amendment turns on slugs, so a
    // summary naming one of a rejoin's two would invite the replanner to drop the other.
    const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
    // Only when it says something: every other part is expected to produce code,
    // and saying so on each line would bury the two that don't.
    const expects = partIsHuman(p)
      ? ', a step for a person'
      : p.expectedKind && p.expectedKind !== 'code'
        ? `, planned as a ${p.expectedKind}`
        : '';
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
