import type {
  Decision,
  Issue,
  IssueAssay,
  IssueDelivery,
  Plan,
  PlanPart,
  PullRequest,
  Task,
  WorldEvent,
} from '../types.js';
import { deliveryHold } from '../delivery/delivery.js';
import { assayHold, assayOrigin, hasWorkStarted, isAssayed, type AssayPolicy } from '../intake/assay.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatchCooldown.js';
import {
  DEFAULT_PLANNING,
  issueOrigin,
  planOrigin,
  plannerVerdict,
  resolvePlanRoute,
  type PlanningPolicy,
} from '../plans/planning.js';
import { liveParts, planProgress } from '../plans/parts.js';
import { isActiveTask } from '../tasks.js';

/**
 * How the dispatcher gates and orders issue pickup, derived from operator config.
 *
 * This is *dispatcher-level* and provider-agnostic (fake, github or azure): it
 * decides which visible issues an agent is started for. Issues are **opt-in**: an
 * issue is only picked up when it carries the `watchLabel` (and no `ignoreLabel`);
 * an untagged issue stays visible in the world/cockpit but is left alone. Mirrors
 * the PR side's opt-out exclusion — see `src/watchLabels.ts` for the shared model.
 */
export interface IssuePickupPolicy {
  /**
   * The `${labelPrefix}-watch` tag. When set, only issues whose `labels` include it
   * are eligible for pickup (opt-in). Empty/unset = no watch gate, act on every
   * open issue — the backward-compatible default the no-arg `RuleDispatcher` uses.
   */
  watchLabel?: string;
  /**
   * The `${labelPrefix}-ignore` tag. An issue carrying it is never picked up, even
   * if it also carries the watch label (ignore wins). Empty/unset = no ignore gate.
   */
  ignoreLabel?: string;
  /**
   * When set, the watch label only counts if the authenticated viewer added it
   * themselves — the gate reads `labelsAddedByViewer` instead of `labels`. Stops a
   * third party from tagging an item to get an agent onto it. Off by default; needs
   * a provider that resolves tag authorship (github/azure). If the provider didn't
   * populate authorship (unknown), no tag counts as the viewer's, so nothing passes.
   */
  requireOwnLabel?: boolean;
  /** Label → priority weight; higher is dispatched first under limited headroom. */
  priorityLabels: Record<string, number>;
  /** Weight for an issue carrying no matching priority label. */
  defaultPriority: number;
  /**
   * When non-empty, only issues whose provider-native `workItemState` is in this
   * list are eligible for pickup (e.g. `["Ready", "Doing"]` for Azure DevOps).
   * Issues with no `workItemState` (GitHub, the fake) skip this gate entirely, so
   * it stays a no-op for providers with only open/closed. Unset/empty = no state
   * gate (the backward-compatible default).
   */
  pickupStates?: string[];
  /**
   * The state a work item is moved to once a pull request is open for it, so it
   * stops being re-picked while under review (e.g. Azure "In Review"). When set
   * *and* `pickupStates` is non-empty, the dispatcher emits a `set_work_item_state`
   * action for a still-in-pickup item that has an open PR. Unset = no automatic
   * transition (the default). Needs a provider that can write the state back.
   */
  inReviewState?: string;
}

/** The branch rule `issue-pickup` puts an issue's agent on — and how a PR is matched back to its issue. */
export function issueBranch(number: number): string {
  return `issue/${number}`;
}

/**
 * The open pull request resolving this issue, or `null` when none is open.
 *
 * `linkedPrNumber` is the *last* PR that ever cross-referenced the issue, with no
 * open/merged filter (see `linkedPrFromTimeline`) — so it stays set after that PR
 * merges. Gating pickup on it alone retires an issue the moment any PR touches it,
 * which kills an issue that needs a second PR; resolving it against the live PRs
 * instead is what keeps the loop moving. The branch convention is checked too, so a
 * PR the provider hasn't linked yet still counts.
 *
 * `openPrs` must be **every** open PR — including ones the operator's `-ignore` tag
 * hides from the dispatch world (`Harness.runCycle` filters them out, so the
 * dispatcher passes them back in via `DispatchContext.excludedPrs`). Both providers
 * list only open/active PRs, so absence otherwise reads as "merged" — and an ignored
 * PR would get its issue re-picked and a second agent onto the very same branch.
 *
 * Not covered: a `prAuthor` filter narrows the provider's PR list, so a linked PR
 * opened by someone else is invisible here and reads as gone.
 */
export function openPrForIssue(issue: Issue, openPrs: PullRequest[]): PullRequest | null {
  const branch = issueBranch(issue.number);
  for (const pr of openPrs) {
    if (pr.merged) continue;
    if (pr.number === issue.linkedPrNumber || pr.branch === branch) return pr;
  }
  return null;
}

/** The intrinsic pickup verdict, same shape as `prHealth`: eligible, or why not. */
interface IssuePickupEligibility {
  eligible: boolean;
  /** Human-readable reasons the issue isn't eligible. Empty when eligible. */
  reasons: string[];
}

/**
 * Whether an open, unlinked issue may be picked up under the policy's gate —
 * with *why not* when it may not, so the cockpit can explain an untouched item
 * instead of leaving it implied. Pure over the issue + policy alone.
 */
export function isIssuePickupEligible(issue: Issue, policy: IssuePickupPolicy): IssuePickupEligibility {
  const reasons: string[] = [];
  // Ignore wins over everything else: an explicitly-ignored item is left alone
  // regardless of state or watch tag (mirrors the PR exclusion tag).
  const ignored = issueIgnoreReason(issue, policy);
  if (ignored) reasons.push(ignored);
  // State gate (Azure work items): only pick up items in an allowed workflow state
  // — e.g. "Ready"/"Doing", not "In Review". Items with no tracked state (GitHub,
  // fake) bypass this entirely, so it's a no-op unless the provider populates it.
  if (policy.pickupStates && policy.pickupStates.length > 0 && issue.workItemState !== undefined) {
    if (!policy.pickupStates.includes(issue.workItemState)) {
      // The review back-off state is the expected parking spot — name it as such.
      if (policy.inReviewState && issue.workItemState === policy.inReviewState) reasons.push('in review');
      else reasons.push(`state "${issue.workItemState}" not in pickup states`);
    }
  }
  const unwatched = issueWatchReason(issue, policy);
  if (unwatched) reasons.push(unwatched);
  return { eligible: reasons.length === 0, reasons };
}

/** The explicit "leave it alone" tag, as a reason — or null when it isn't set. */
function issueIgnoreReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  if (policy.ignoreLabel && issue.labels.includes(policy.ignoreLabel)) return `ignored ("${policy.ignoreLabel}")`;
  return null;
}

/**
 * The opt-in watch gate: an issue must carry the watch tag to be worked. Empty
 * watch label = gate off (the no-arg dispatcher / test default), so every open
 * issue passes as before.
 */
function issueWatchReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  if (!policy.watchLabel) return null;
  const labels = policy.requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
  if (labels.includes(policy.watchLabel)) return null;
  // Distinguish "not tagged at all" from "tagged, but not by you" (the ownership
  // gate failing closed) so the operator knows which knob to turn.
  if (policy.requireOwnLabel && issue.labels.includes(policy.watchLabel)) {
    return `watch label "${policy.watchLabel}" not added by you`;
  }
  return `no watch label "${policy.watchLabel}"`;
}

/**
 * The label half of the gate on its own — the one parts inherit. There is no
 * per-part watch check: the tag is evaluated once, on the parent issue, and parts
 * follow it. Deliberately **without** the workflow-state gate: rule `work-item-in-review` parks a work
 * item in the review state as soon as any part's PR opens, and re-applying the
 * state gate there would stop the plan's remaining parts from ever being scheduled.
 */
export function issueWatchGateReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  return issueIgnoreReason(issue, policy) ?? issueWatchReason(issue, policy);
}

/** What LubbDubb is doing (or not) with one issue, and why. */
type IssuePickupStatusKind =
  | 'done' // closed — nothing to do
  | 'has_pr' // resolved into a PR; the PR rules own it now
  | 'active' // an agent/task is on it right now
  | 'ignored' // carries the ignore tag — the operator said leave it alone
  | 'unwatched' // not opted in (no watch tag) or parked by a state gate
  | 'planning' // in the plan funnel — a verdict is owed, or it split into parts
  | 'delivered' // assessed as delivered — parked until the world or the operator says otherwise
  | 'assay' // its goal is being checked, or was found unworkable — nothing is dispatched for it
  | 'cooldown' // attempted recently; waiting out the re-dispatch gap
  | 'escalated' // attempt cap spent; parked on a human
  | 'blocked' // eligible, but no capacity (paused or cap reached)
  | 'eligible'; // would be picked up next cycle

export interface IssuePickupStatus {
  /** True only when the dispatcher would start an agent for it next cycle. */
  eligible: boolean;
  status: IssuePickupStatusKind;
  /** Human-readable explanation, most actionable first. Empty when eligible. */
  reasons: string[];
}

/** The runtime context the contextual gates need — everything rule `issue-pickup` consults. */
export interface IssuePickupContext {
  policy: IssuePickupPolicy;
  cooldown: CooldownPolicy;
  /** "Now" for cooldown arithmetic — the world snapshot's `takenAt`. */
  now: string;
  tasks: Task[];
  recentDecisions: Decision[];
  /**
   * Every open PR the world knows about, for {@link openPrForIssue}. The cockpit
   * reads the connector directly, so it passes the unfiltered list — an `-ignore`
   * tagged PR is hidden from dispatch but is still an open PR for this gate.
   */
  openPrs: PullRequest[];
  /**
   * The plan funnel's state and policy — the same inputs rules `issue-plan` and `issue-pickup` consult.
   * Omitted = funnel off, so every issue routes straight to pickup as before.
   */
  plans?: Plan[];
  /** Every plan's parts, so a `parts` verdict can report progress rather than a flat string. */
  planParts?: PlanPart[];
  /**
   * Omitted means the funnel is **out**, matching `RuleDispatcher`'s own fallback
   * for an unnamed policy — the chip and the rule have to disagree about nothing,
   * and the operator default (on, in `src/config.ts`) reaches both through the
   * composition root rather than through either of these fallbacks.
   */
  planning?: PlanningPolicy;
  /**
   * Standing `delivered` verdicts and the world transitions that may have ended
   * one — the same two lists rule `issue-pickup` gates on, so the chip predicts it. Absent =
   * nothing parked, which is every deployment until an issue is assessed.
   */
  deliveries?: IssueDelivery[];
  deliverySignals?: WorldEvent[];
  /**
   * Standing goal-assay verdicts and the transitions that may have ended one —
   * the same two lists rule `issue-assay` and the `eligibleIssues` filter gate on, so the chip
   * predicts them. Absent = nothing assayed, which holds nothing.
   */
  assays?: IssueAssay[];
  assaySignals?: WorldEvent[];
  /**
   * Whether the goal assay is on. Needed as well as the verdicts because the chip
   * reports the *pending* case too — an issue rule `issue-assay` will assay next cycle is not
   * eligible, and saying so is the difference between a queue and a silence.
   */
  assay?: AssayPolicy;
  /** Remaining dispatch slots this cycle (0 while paused). */
  headroom: number;
  paused: boolean;
}

/**
 * Fold every gate that decides issue pickup — intrinsic policy gates *and* the
 * contextual ones (active task, cooldown/attempt cap, capacity) — into one
 * per-item verdict, mirroring `prHealth` for PRs. Pure over the issue + context,
 * and checked in the same order rule `issue-pickup` of the rule dispatcher applies them, so
 * the verdict matches what actually happens next cycle.
 */
export function issuePickupStatus(issue: Issue, ctx: IssuePickupContext): IssuePickupStatus {
  if (issue.state !== 'open') return { eligible: false, status: 'done', reasons: ['closed'] };

  // The plan comes *before* the PR gate for an issue that split into parts, and it
  // has to: a part's PR is on `issue/<n>/<slug>`, but `linkedPrNumber` is sticky and
  // will point at one, so the PR gate below would report "has open PR #n" for every
  // mid-plan issue — hiding the plan behind whichever part happened to open last.
  const plan = ctx.plans?.find((p) => p.originRef === issueOrigin(issue.number)) ?? null;
  const parts = plan ? (ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [];
  const planVerdict = resolvePlanRoute({
    planning: ctx.planning ?? { ...DEFAULT_PLANNING, enabled: false },
    plan,
    verdict: plannerVerdict(issue.number, plan, ctx.now, ctx.recentDecisions, ctx.cooldown),
    existingParts: liveParts(parts).length,
  });
  // Answered here, beside the `parts` arm and before the PR gate, for the same
  // reason: an issue whose decomposition is awaiting approval is planned, and a
  // part's PR (a replan of a live plan) would otherwise report it as "has open
  // PR #n" — hiding the one thing the operator has to do about it.
  if (planVerdict.route === 'awaiting_approval' && plan) {
    const total = liveParts(parts).length;
    return {
      eligible: false,
      status: 'planning',
      reasons: [`awaiting your approval of the ${total}-part plan`],
    };
  }

  if (planVerdict.route === 'parts' && plan) {
    const { settled, total } = planProgress(parts);
    // A `complete` plan is the one arm that never moves again on its own: rule `plan-part`
    // schedules nothing and pickup stays narrowed off, which is correct while a
    // human decides whether the issue is done — but "3/3 parts done" reads like
    // a plan still in flight. Say what the two ways out are instead.
    //
    // "done" rather than "merged": a part can finish as a report or a
    // determination, and counting only merges would understate a finished plan.
    const reason =
      total === 0
        ? 'plan split this into parts'
        : plan.status === 'complete'
          ? `plan complete — all ${total} part${total === 1 ? '' : 's'} finished; close the issue or replan`
          : `${settled}/${total} parts done`;
    return { eligible: false, status: 'planning', reasons: [reason] };
  }

  // Resolved against the live PRs, not the sticky `linkedPrNumber` — the reason
  // says "open", so it has to be one, and a merged PR must not park the issue.
  const openPr = openPrForIssue(issue, ctx.openPrs);
  if (openPr) return { eligible: false, status: 'has_pr', reasons: [`has open PR #${openPr.number}`] };

  // An active task on this origin owns the issue — report the agent's state.
  const origin = `issue:${issue.number}`;
  const active = ctx.tasks.find((t) => t.originRef === origin && isActiveTask(t));
  if (active) {
    const reason =
      active.status === 'running'
        ? 'agent running'
        : active.status === 'queued'
          ? 'agent queued'
          : 'agent waiting on you';
    return { eligible: false, status: 'active', reasons: [reason] };
  }

  // The harness's own park, asked *after* `has_pr` and `active`: a delivered issue
  // that somehow has an open PR is honestly `has_pr` — the PR rules own it — and
  // one with a live agent is honestly `active`. Same predicate rule `issue-pickup` gates on, so
  // the chip cannot promise what the next cycle refuses.
  const held = deliveryHold(ctx.deliveries?.find((d) => d.originRef === origin) ?? null, issue, {
    pickupStates: ctx.policy.pickupStates,
    signals: ctx.deliverySignals,
  });
  if (held) return { eligible: false, status: 'delivered', reasons: [held] };

  const intrinsic = isIssuePickupEligible(issue, ctx.policy);
  if (!intrinsic.eligible) {
    // Explicit ignore vs "just not opted in" — so the cockpit can mark the two
    // apart the way it marks an ignored PR (the ignore tag always wins above).
    const ignored = ctx.policy.ignoreLabel !== undefined && issue.labels.includes(ctx.policy.ignoreLabel);
    return { eligible: false, status: ignored ? 'ignored' : 'unwatched', reasons: intrinsic.reasons };
  }

  // The content gate (issue #158), asked *after* the intrinsic policy gates and
  // *before* the plan funnel — which is exactly where rule `issue-assay` sits. After, because
  // an unwatched or state-parked issue is never assayed, so reporting an assay for
  // one would promise something that cannot happen; before, because an assay that
  // refused the goal is the reason no planner and no pickup agent is coming.
  const assay = assayFor(issue, ctx);
  if (assay) return { eligible: false, status: 'assay', reasons: [assay] };

  // The rest of the funnel sits between eligibility and pickup: narrowing rule `issue-pickup`
  // without reporting it here would leave the chip saying "eligible" for an issue
  // that is actually waiting on a planner. (The `parts` arm is answered above,
  // before the PR gate can mistake a part's PR for the issue's.)
  const route = planVerdict;
  if (route.route === 'parts') {
    return { eligible: false, status: 'planning', reasons: ['plan split this into parts'] };
  }
  if (route.route === 'planning') {
    const planner = ctx.tasks.find((t) => t.originRef === planOrigin(issue.number) && isActiveTask(t));
    const reason = planner
      ? `planning agent ${planner.status === 'waiting' ? 'waiting on you' : planner.status}`
      : route.planner === 'cooldown'
        ? 'planning on cooldown'
        : 'awaiting a planning agent';
    return { eligible: false, status: 'planning', reasons: [reason] };
  }

  const verdict = dispatchVerdict(origin, ctx.now, ctx.recentDecisions, ctx.cooldown);
  if (verdict.kind === 'cooldown') {
    const attempts = countAttempts(origin, ctx.recentDecisions);
    return {
      eligible: false,
      status: 'cooldown',
      reasons: [`on cooldown after ${attempts} attempt${attempts === 1 ? '' : 's'}`],
    };
  }
  if (verdict.kind === 'escalate' || verdict.kind === 'hold') {
    const attempts = verdict.kind === 'escalate' ? verdict.attempts : countAttempts(origin, ctx.recentDecisions);
    return {
      eligible: false,
      status: 'escalated',
      reasons: [`${attempts} failed attempt${attempts === 1 ? '' : 's'} — escalated to a human`],
    };
  }

  if (ctx.paused) return { eligible: false, status: 'blocked', reasons: ['dispatch paused'] };
  if (ctx.headroom <= 0) return { eligible: false, status: 'blocked', reasons: ['no agent capacity'] };

  return { eligible: true, status: 'eligible', reasons: [] };
}

/**
 * Why the goal assay is the reason nothing is happening to this issue, or null
 * when it isn't.
 *
 * Two arms, in the order rule `issue-assay` resolves them. A **standing** `unclear` verdict
 * first — asked through the same pure `assayHold` the dispatcher asks, so the chip
 * cannot say "parked" for an issue the next cycle dispatches, nor the reverse.
 * Then the **pending** case: an issue rule `issue-assay` would assay, or is assaying now.
 * Reporting that matters as much as the hold — an issue silently waiting a cycle
 * for a verdict looks exactly like an idle fleet, which is the invisibility
 * `capped` and `unapproved` were added to `QueueItem` to fix.
 *
 * A `workable` verdict returns null from both arms: it releases the issue to
 * whatever the funnel says next, which is the whole of its effect.
 */
function assayFor(issue: Issue, ctx: IssuePickupContext): string | null {
  const origin = `issue:${issue.number}`;
  const stored = ctx.assays?.find((a) => a.originRef === origin) ?? null;
  const held = assayHold(stored, issue, { signals: ctx.assaySignals });
  if (held) return held;
  if (!ctx.assay?.enabled) return null;
  // Same preconditions rule `issue-assay` applies, in its order.
  if (isAssayed(stored, issue)) return null;
  if (hasWorkStarted(issue.number, ctx.tasks)) return null;
  if (ctx.plans?.some((p) => p.originRef === origin)) return null;
  const running = ctx.tasks.find((t) => t.originRef === assayOrigin(issue.number) && isActiveTask(t));
  if (running) return running.status === 'waiting' ? 'goal assay waiting on you' : 'a goal assay is running';
  const verdict = dispatchVerdict(assayOrigin(issue.number), ctx.now, ctx.recentDecisions, ctx.cooldown);
  // A spent cap is the fail-open: the issue carries on into the funnel, so this
  // says nothing about it and lets the arms below explain what happens instead.
  if (verdict.kind === 'escalate' || verdict.kind === 'hold') return null;
  return verdict.kind === 'cooldown' ? 'goal assay on cooldown' : 'awaiting a goal assay';
}

/** Executed dispatches for one origin in the recent audit window. */
function countAttempts(origin: string, decisions: Decision[]): number {
  let n = 0;
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if ((a.type === 'dispatch_code_agent' || a.type === 'dispatch_desk_agent') && a.originRef === origin) n += 1;
  }
  return n;
}

/**
 * Parse an issue's priority from its labels: the highest weight among labels that
 * match the scheme, or the configured default when none match. Pure — no world,
 * no side effects — so the label → weight mapping is unit-testable in isolation.
 */
export function issuePriority(labels: string[], policy: IssuePickupPolicy): number {
  let best: number | null = null;
  for (const label of labels) {
    const weight = policy.priorityLabels[label];
    if (weight !== undefined && (best === null || weight > best)) best = weight;
  }
  return best ?? policy.defaultPriority;
}
