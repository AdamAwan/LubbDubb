import type {
  Decision,
  Issue,
  IssueAppraisal,
  IssueDelivery,
  IssueRun,
  ObstacleBlock,
  ObstacleStanding,
  Plan,
  PlanPart,
  PullRequest,
  TaskSummary,
  WorldEvent,
} from '../types.js';
import { deliveryHold } from '../delivery/delivery.js';
import { blockedGoals } from '../obstacles/blocked.js';
import { containerPickupReason, isContainerIssue } from '../issueRelations.js';
import { appraisalHold, appraisalOrigin, hasWorkStarted, isAppraised } from '../intake/appraisal.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatchCooldown.js';
import { issueOrigin, planOrigin, plannerVerdict, resolvePlanRoute } from '../plans/planning.js';
import { liveParts, planProgress } from '../plans/parts.js';
import { isActiveTask } from '../tasks.js';
import type { IssueSequencing } from '../sequence/readiness.js';

/**
 * How the dispatcher gates and orders issue pickup, derived from operator config.
 * Dispatcher-level and provider-agnostic. Issues are opt-in: only tagged with
 * `watchLabel` are picked up; untagged issues stay visible but left alone. PRs gate
 * the same way — see `src/watchLabels.ts`.
 */
export interface IssuePickupPolicy {
  /** The `${labelPrefix}-watch` tag. Empty/unset = no watch gate, act on every open issue. */
  watchLabel?: string;
  /**
   * When set, the watch label only counts if the authenticated viewer added it
   * themselves — reads `labelsAddedByViewer` instead of `labels`, so a third party
   * cannot tag an item onto the fleet. Needs a provider that resolves tag authorship
   * (github/azure); if it left authorship unknown, no tag counts as the viewer's and
   * nothing passes — a provider that never populates the field silently stops all pickup.
   */
  requireOwnLabel?: boolean;
  /** Label → priority weight; higher is dispatched first under limited headroom. */
  priorityLabels: Record<string, number>;
  /** Weight for an issue carrying no matching priority label. */
  defaultPriority: number;
  /**
   * When non-empty, only issues whose provider-native `workItemState` is in this
   * list are eligible (e.g. `["Ready", "Doing"]` for Azure DevOps). Issues with no
   * `workItemState` skip this gate entirely. Unset/empty = no state gate.
   */
  pickupStates?: string[];
  /**
   * The state a work item moves to once a PR is open for it, so it isn't re-picked
   * under review (e.g. Azure "In Review"). Needs `pickupStates` set too and a
   * provider that can write state back. Unset = no automatic transition.
   */
  inReviewState?: string;
  /**
   * The state a work item moves to once an agent is actually working it (e.g. Azure
   * "Doing"). {@link effectivePickupStates} folds it into `pickupStates` so such an
   * item stays pickup-eligible without the operator listing it twice.
   */
  inProgressState?: string;
  /**
   * Provider-native item types that hold other work rather than being work (e.g.
   * `["Feature", "Epic"]`) — never picked up. Issues with no `issueType` skip the
   * gate. Unset falls back to `DEFAULT_CONTAINER_TYPES`; `[]` turns it off.
   */
  containerTypes?: string[];
  /**
   * Provider-native item types expected to hang off a container. One with no parent
   * is an orphan, reported in the appraisal prompt and the cockpit. Unset falls back
   * to `DEFAULT_PARENTED_TYPES`; `[]` turns the orphan report off.
   */
  parentedTypes?: string[];
  /**
   * How much of the sequencing gate is switched on — `off` (default), `links`, or
   * `full`. {@link isIssuePickupEligible} does not read it — it is pure over issue +
   * policy, and readiness is a question about the world. → `docs/spec/33-story-sequencing.md`
   */
  sequencing?: IssueSequencing;
  /** `issueSequenceMaxChildren` — above this a Feature is not sequenced at all. Unset falls back to {@link DEFAULT_SEQUENCE_MAX_CHILDREN}. */
  sequenceMaxChildren?: number;
}

/**
 * The pickup states as every gate must actually read them: the operator's list plus
 * the in-progress state the harness writes itself — without the fold, an item the
 * harness moved falls into a hole, never picked up again, with nothing red.
 * `deliveryHold` must **not** use this: it asks about a pickup state to mean "a
 * human moved it back", which a harness-written state is not. `undefined`/empty
 * stays that way — an empty gate must stay off.
 */
export function effectivePickupStates(
  // The two fields it reads, not the whole policy: the cockpit's readers hold a
  // `Config` rather than a dispatch policy.
  policy: Pick<IssuePickupPolicy, 'pickupStates' | 'inProgressState'>,
): string[] | undefined {
  const states = policy.pickupStates;
  if (!states || states.length === 0) return states;
  const inProgress = policy.inProgressState;
  if (!inProgress || states.includes(inProgress)) return states;
  return [...states, inProgress];
}

/** The branch rule `issue-pickup` puts an issue's agent on — and how a PR is matched back to its issue. */
export function issueBranch(number: number): string {
  return `issue/${number}`;
}

/**
 * The open pull request resolving this issue, or null when none is open.
 * `linkedPrNumber` is sticky (stays set after merge), so it's resolved against the
 * live PRs; the branch convention is checked too. `openPrs` must be every open PR,
 * unwatched included — a hidden PR would re-pick its issue and send a second agent
 * onto the same branch.
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
 * Whether an open, unlinked issue may be picked up under the policy's gate, with why
 * not when it may not. Pure over the issue + policy alone.
 */
export function isIssuePickupEligible(issue: Issue, policy: IssuePickupPolicy): IssuePickupEligibility {
  const reasons: string[] = [];
  // Type gate (Azure): an agent is never put on a Feature/Epic. Asked before the state gate — a container in a pickup state is still a container.
  const container = containerPickupReason(issue, policy.containerTypes);
  if (container) reasons.push(container);
  // State gate (Azure): only pick up items in an allowed workflow state. Items with no tracked state bypass this entirely.
  const pickupStates = effectivePickupStates(policy);
  if (pickupStates && pickupStates.length > 0 && issue.workItemState !== undefined) {
    if (!pickupStates.includes(issue.workItemState)) {
      // The review back-off state is the expected parking spot — name it as such.
      if (policy.inReviewState && issue.workItemState === policy.inReviewState) reasons.push('in review');
      else reasons.push(`state "${issue.workItemState}" not in pickup states`);
    }
  }
  const unwatched = issueWatchReason(issue, policy);
  if (unwatched) reasons.push(unwatched);
  return { eligible: reasons.length === 0, reasons };
}

/** The opt-in watch gate: an issue must carry the watch tag to be worked. Empty watch label = gate off. */
function issueWatchReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  if (!policy.watchLabel) return null;
  // With requireOwnLabel, reads labelsAddedByViewer instead of labels — a provider
  // that never populates it resolves every issue's labels to [] and nothing is picked up.
  const labels = policy.requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
  if (labels.includes(policy.watchLabel)) return null;
  // Distinguish "not tagged" from "tagged, but not by you" so the operator knows which knob to turn.
  if (policy.requireOwnLabel && issue.labels.includes(policy.watchLabel)) {
    return `watch label "${policy.watchLabel}" not added by you`;
  }
  return `no watch label "${policy.watchLabel}"`;
}

/**
 * The label half of the gate on its own — the one parts inherit; the tag is
 * evaluated once, on the parent issue. Deliberately without the workflow-state gate,
 * or `work-item-in-review` parking on the first part's PR would strand the rest.
 */
export function issueWatchGateReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  return issueWatchReason(issue, policy);
}

/** What LubbDubb is doing (or not) with one issue, and why. */
type IssuePickupStatusKind =
  | 'done' // closed, and the harness holds no run — nothing to do
  | 'retained' // closed, but its run lives until dismissed (issue #234)
  | 'has_pr' // resolved into a PR; the PR rules own it now
  | 'active' // an agent/task is on it right now
  | 'container' // a Feature/Epic — its children are the work, never it
  | 'unwatched' // not opted in (no watch tag) or parked by a state gate
  | 'planning' // in the plan funnel — a verdict is owed, or it split into parts
  | 'delivered' // assessed as delivered — parked until the world or the operator says otherwise
  | 'appraisal' // its goal is being checked, or was found unworkable — nothing is dispatched for it
  | 'obstacle' // an agent could not finish it, and named what stopped it: parked until that clears
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
  tasks: TaskSummary[];
  recentDecisions: Decision[];
  /** Every open PR the world knows about, for {@link openPrForIssue}. Unfiltered — an unwatched PR is hidden from dispatch but is still open for this gate. */
  openPrs: PullRequest[];
  /** The plan funnel's state and policy. Omitted = funnel off, every issue routes straight to pickup. */
  plans?: Plan[];
  /** Every plan's parts, so a `parts` verdict can report progress rather than a flat string. */
  planParts?: PlanPart[];
  /** Standing `delivered` verdicts and the world transitions that may have ended one, so the chip predicts what `issue-pickup` gates on. Absent = nothing parked. */
  deliveries?: IssueDelivery[];
  deliverySignals?: WorldEvent[];
  /** Standing goal-appraisal verdicts and the transitions that may have ended one. Absent = nothing appraised, which holds nothing. */
  appraisals?: IssueAppraisal[];
  /**
   * Goals parked behind an obstacle and the board that lifts them. Absent = nothing
   * parked. → `docs/spec/27-obstacles.md#blocked-is-an-answer`
   */
  obstacleBlocks?: ObstacleBlock[];
  obstacles?: ObstacleStanding[];
  /** The harness's runs at each goal, so a closed issue can be told from a closed ticket (issue #234). Absent = nothing retained. */
  runs?: IssueRun[];
  /** Remaining dispatch slots this cycle (0 while paused). */
  headroom: number;
  paused: boolean;
}

/**
 * Fold every gate that decides issue pickup — intrinsic and contextual — into one
 * per-item verdict, mirroring `prHealth` for PRs. Pure over the issue + context,
 * checked in the same order `issue-pickup` applies them, so the verdict matches
 * what actually happens next cycle.
 */
export function issuePickupStatus(issue: Issue, ctx: IssuePickupContext): IssuePickupStatus {
  if (issue.state !== 'open') {
    // A close is the tracker's answer, not the run's end — while the run lives the harness may still act on the goal.
    const run = ctx.runs?.find((r) => r.issueNumber === issue.number) ?? null;
    if (run !== null && run.dismissedAt === null) {
      return {
        eligible: false,
        status: 'retained',
        reasons: [
          run.completedAt !== null
            ? 'closed; run kept until you dismiss it'
            : 'closed mid-run; kept until you dismiss it',
        ],
      };
    }
    return { eligible: false, status: 'done', reasons: ['closed'] };
  }

  // Plan comes before the PR gate: linkedPrNumber is sticky and points at a part's PR, which would else misreport "has open PR".
  const plan = ctx.plans?.find((p) => p.originRef === issueOrigin(issue.number)) ?? null;
  const parts = plan ? (ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [];
  const planVerdict = resolvePlanRoute({
    plan,
    verdict: plannerVerdict(issue.number, plan, ctx.now, ctx.recentDecisions, ctx.cooldown),
    existingParts: liveParts(parts).length,
  });
  if (planVerdict.route === 'awaiting_approval' && plan) {
    const total = liveParts(parts).length;
    return {
      eligible: false,
      status: 'planning',
      // No parts is the single-PR verdict awaiting approval, not an empty decomposition.
      reasons: [
        total === 0
          ? 'awaiting your approval of the single-PR plan'
          : `awaiting your approval of the ${total}-part plan`,
      ],
    };
  }

  if (planVerdict.route === 'parts' && plan) {
    const { settled, total } = planProgress(parts);
    // A complete plan never moves again on its own — name the two ways out instead of "N/N done".
    const reason =
      total === 0
        ? 'plan split this into parts'
        : plan.status === 'complete'
          ? `plan complete — all ${total} part${total === 1 ? '' : 's'} finished; close the issue or replan`
          : `${settled}/${total} parts done`;
    return { eligible: false, status: 'planning', reasons: [reason] };
  }

  const openPr = openPrForIssue(issue, ctx.openPrs);
  if (openPr) return { eligible: false, status: 'has_pr', reasons: [`has open PR #${openPr.number}`] };

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

  const held = deliveryHold(ctx.deliveries?.find((d) => d.originRef === origin) ?? null, issue, {
    pickupStates: ctx.policy.pickupStates,
    signals: ctx.deliverySignals,
  });
  if (held) return { eligible: false, status: 'delivered', reasons: [held] };

  // → `docs/spec/27-obstacles.md#blocked-is-an-answer`
  const block = blockedGoals(ctx.obstacleBlocks ?? [], ctx.obstacles ?? []).get(origin);
  if (block) {
    return {
      eligible: false,
      status: 'obstacle',
      reasons: [`blocked behind ${block.obstacleId}: ${block.note}`],
    };
  }

  const intrinsic = isIssuePickupEligible(issue, ctx.policy);
  if (!intrinsic.eligible) {
    // A container is its own answer — tagging it changes nothing, so "unwatched" would mislead.
    const status = isContainerIssue(issue, ctx.policy.containerTypes) ? 'container' : 'unwatched';
    return { eligible: false, status, reasons: intrinsic.reasons };
  }

  const appraisal = appraisalFor(issue, ctx);
  if (appraisal) return { eligible: false, status: 'appraisal', reasons: [appraisal] };

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
 * Why the goal appraisal is the reason nothing is happening to this issue, or null
 * when it isn't. A `workable` verdict returns null from both arms, releasing the
 * issue to the funnel.
 */
function appraisalFor(issue: Issue, ctx: IssuePickupContext): string | null {
  const origin = `issue:${issue.number}`;
  const stored = ctx.appraisals?.find((a) => a.originRef === origin) ?? null;
  const held = appraisalHold(stored, issue);
  if (held) return held;
  if (isAppraised(stored, issue)) return null;
  if (hasWorkStarted(issue.number, ctx.tasks)) return null;
  if (ctx.plans?.some((p) => p.originRef === origin)) return null;
  const running = ctx.tasks.find((t) => t.originRef === appraisalOrigin(issue.number) && isActiveTask(t));
  if (running) return running.status === 'waiting' ? 'goal appraisal waiting on you' : 'a goal appraisal is running';
  const verdict = dispatchVerdict(appraisalOrigin(issue.number), ctx.now, ctx.recentDecisions, ctx.cooldown);
  // A spent cap fails open: the issue carries on into the funnel.
  if (verdict.kind === 'escalate' || verdict.kind === 'hold') return null;
  return verdict.kind === 'cooldown' ? 'goal appraisal on cooldown' : 'awaiting a goal appraisal';
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

/** Parse an issue's priority from its labels: the highest matching weight, or the configured default. Pure. */
export function issuePriority(labels: string[], policy: IssuePickupPolicy): number {
  let best: number | null = null;
  for (const label of labels) {
    const weight = policy.priorityLabels[label];
    if (weight !== undefined && (best === null || weight > best)) best = weight;
  }
  return best ?? policy.defaultPriority;
}
