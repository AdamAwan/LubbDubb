import type { Decision, Issue, Task } from '../types.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatchCooldown.js';

/**
 * How the dispatcher gates and orders issue pickup, derived from operator config.
 *
 * This is *dispatcher-level* and provider-agnostic (fake or github): it decides
 * which visible issues an agent is started for. It is deliberately distinct from
 * the GitHub provider's `issueLabel` *ingest* filter, which narrows what's even
 * fetched into the world — untagged issues stay visible here, they're just left
 * alone.
 */
export interface IssuePickupPolicy {
  /**
   * When set, only issues whose `labels` include this are eligible for pickup.
   * Unset = act on all open issues (the backward-compatible default).
   */
  pickupLabel?: string;
  /**
   * When set, the pickup label only counts if the authenticated viewer added it
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

/** The intrinsic pickup verdict, same shape as `prHealth`: eligible, or why not. */
export interface IssuePickupEligibility {
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
  if (policy.pickupLabel) {
    const labels = policy.requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
    if (!labels.includes(policy.pickupLabel)) {
      // Distinguish "not tagged at all" from "tagged, but not by you" (the
      // ownership gate failing closed) so the operator knows which knob to turn.
      if (policy.requireOwnLabel && issue.labels.includes(policy.pickupLabel)) {
        reasons.push(`pickup label "${policy.pickupLabel}" not added by you`);
      } else {
        reasons.push(`no pickup label "${policy.pickupLabel}"`);
      }
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/** What LubbDubb is doing (or not) with one issue, and why. */
export type IssuePickupStatusKind =
  | 'done' // closed — nothing to do
  | 'has_pr' // resolved into a PR; the PR rules own it now
  | 'active' // an agent/task is on it right now
  | 'skipped' // ineligible under the pickup policy (label/state gates)
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

/** The runtime context the contextual gates need — everything rule 4 consults. */
export interface IssuePickupContext {
  policy: IssuePickupPolicy;
  cooldown: CooldownPolicy;
  /** "Now" for cooldown arithmetic — the world snapshot's `takenAt`. */
  now: string;
  tasks: Task[];
  recentDecisions: Decision[];
  /** Remaining dispatch slots this cycle (0 while paused). */
  headroom: number;
  paused: boolean;
}

/**
 * Fold every gate that decides issue pickup — intrinsic policy gates *and* the
 * contextual ones (active task, cooldown/attempt cap, capacity) — into one
 * per-item verdict, mirroring `prHealth` for PRs. Pure over the issue + context,
 * and checked in the same order rule 4 of the rule dispatcher applies them, so
 * the verdict matches what actually happens next cycle.
 */
export function issuePickupStatus(issue: Issue, ctx: IssuePickupContext): IssuePickupStatus {
  if (issue.state !== 'open') return { eligible: false, status: 'done', reasons: ['closed'] };
  if (issue.linkedPrNumber !== null) {
    return { eligible: false, status: 'has_pr', reasons: [`has open PR #${issue.linkedPrNumber}`] };
  }

  // An active task on this origin owns the issue — report the agent's state.
  const origin = `issue:${issue.number}`;
  const active = ctx.tasks.find(
    (t) => t.originRef === origin && (t.status === 'queued' || t.status === 'running' || t.status === 'waiting'),
  );
  if (active) {
    const reason =
      active.status === 'running' ? 'agent running' : active.status === 'queued' ? 'agent queued' : 'agent waiting on you';
    return { eligible: false, status: 'active', reasons: [reason] };
  }

  const intrinsic = isIssuePickupEligible(issue, ctx.policy);
  if (!intrinsic.eligible) return { eligible: false, status: 'skipped', reasons: intrinsic.reasons };

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
