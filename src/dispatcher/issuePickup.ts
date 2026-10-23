import { issueOriginRef } from '../issueOrigins.js';
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
import {
  investigateOrigin,
  investigationStanding,
  type InvestigationStanding,
  type InvestigationStandings,
} from '../intake/investigation.js';
import { pickupLabels } from '../watchLabels.js';
import { ALIGNING_REASON, SITTING_REASON, sittingHolds, type ClosedSittings } from '../intake/sitting.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatchCooldown.js';
import { issueOrigin, planOrigin, plannerVerdict, resolvePlanRoute, type PlanRouteVerdict } from '../plans/planning.js';
import { liveParts, planProgress } from '../plans/parts.js';
import { isActiveTask } from '../tasks.js';
import type { IssueSequencing } from '../sequence/readiness.js';

// → docs/spec/05-dispatcher.md

export interface IssuePickupPolicy {
  watchLabel?: string;
  requireOwnLabel?: boolean;
  investigateLabel: string;
  priorityLabels: Record<string, number>;
  defaultPriority: number;
  pickupStates?: string[];
  inReviewState?: string;
  inProgressState?: string;
  containerTypes?: string[];
  parentedTypes?: string[];
  sequencing?: IssueSequencing;
  sequenceMaxChildren?: number;
  pausedIssues?: ReadonlySet<number>;
}

function isGoalPaused(issue: Issue, policy: Pick<IssuePickupPolicy, 'pausedIssues'>): boolean {
  return policy.pausedIssues?.has(issue.number) ?? false;
}

export function effectivePickupStates(
  policy: Pick<IssuePickupPolicy, 'pickupStates' | 'inProgressState'>,
): string[] | undefined {
  const states = policy.pickupStates;
  if (!states || states.length === 0) return states;
  const inProgress = policy.inProgressState;
  if (!inProgress || states.includes(inProgress)) return states;
  return [...states, inProgress];
}

const PAUSED_REASON = 'paused — nothing is picked up until you resume it';

export function issueBranch(number: number): string {
  return `issue/${number}`;
}

export function openPrForIssue(issue: Issue, openPrs: PullRequest[]): PullRequest | null {
  const branch = issueBranch(issue.number);
  for (const pr of openPrs) {
    if (pr.merged) continue;
    if (pr.number === issue.linkedPrNumber || pr.branch === branch) return pr;
  }
  return null;
}

interface IssuePickupEligibility {
  eligible: boolean;
  reasons: string[];
}

export function isIssuePickupEligible(issue: Issue, policy: IssuePickupPolicy): IssuePickupEligibility {
  const reasons: string[] = [];
  const container = containerPickupReason(issue, policy.containerTypes);
  if (container) reasons.push(container);
  const pickupStates = effectivePickupStates(policy);
  if (pickupStates && pickupStates.length > 0 && issue.workItemState !== undefined) {
    if (!pickupStates.includes(issue.workItemState)) {
      if (policy.inReviewState && issue.workItemState === policy.inReviewState) reasons.push('in review');
      else reasons.push(`state "${issue.workItemState}" not in pickup states`);
    }
  }
  const unwatched = issueWatchReason(issue, policy);
  if (unwatched) reasons.push(unwatched);
  if (isGoalPaused(issue, policy)) reasons.push(PAUSED_REASON);
  return { eligible: reasons.length === 0, reasons };
}

type WatchGatePolicy = Pick<IssuePickupPolicy, 'watchLabel' | 'requireOwnLabel'>;

function issueWatchReason(issue: Issue, policy: WatchGatePolicy): string | null {
  if (!policy.watchLabel) return null;
  if (pickupLabels(issue, policy.requireOwnLabel).includes(policy.watchLabel)) return null;
  if (policy.requireOwnLabel && issue.labels.includes(policy.watchLabel)) {
    return `watch label "${policy.watchLabel}" not added by you`;
  }
  return `no watch label "${policy.watchLabel}"`;
}

export function issueWatchGateReason(issue: Issue, policy: WatchGatePolicy): string | null {
  return issueWatchReason(issue, policy);
}

type IssuePickupStatusKind =
  | 'done'
  | 'retained'
  | 'abandoned'
  | 'has_pr'
  | 'active'
  | 'container'
  | 'unwatched'
  | 'paused'
  | 'planning'
  | 'delivered'
  | 'appraisal'
  | 'investigation'
  | 'sitting'
  | 'obstacle'
  | 'cooldown'
  | 'escalated'
  | 'blocked'
  | 'eligible';

export interface IssuePickupStatus {
  eligible: boolean;
  status: IssuePickupStatusKind;
  reasons: string[];
}

export interface IssuePickupContext {
  policy: IssuePickupPolicy;
  cooldown: CooldownPolicy;
  now: string;
  tasks: TaskSummary[];
  recentDecisions: Decision[];
  openPrs: PullRequest[];
  plans?: Plan[];
  planParts?: PlanPart[];
  deliveries?: IssueDelivery[];
  deliverySignals?: WorldEvent[];
  appraisals?: IssueAppraisal[];
  investigations?: InvestigationStandings;
  closedSittings?: ClosedSittings;
  obstacleBlocks?: ObstacleBlock[];
  obstacles?: ObstacleStanding[];
  runs?: IssueRun[];
  headroom: number;
  paused: boolean;
}

type HeldStatus = IssuePickupStatus | null;

function closedStatus(run: IssueRun | null): IssuePickupStatus {
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

function endedStatus(issue: Issue, ctx: IssuePickupContext): HeldStatus {
  const run = ctx.runs?.find((r) => r.issueNumber === issue.number) ?? null;
  if (issue.state !== 'open') return closedStatus(run);
  if (run?.dismissedAt == null) return null;
  return { eligible: false, status: 'abandoned', reasons: ['abandoned; nothing is scheduled for it again'] };
}

function planGateStatus(planVerdict: PlanRouteVerdict, plan: Plan | null, parts: PlanPart[]): HeldStatus {
  if (!plan) return null;
  if (planVerdict.route === 'awaiting_approval') {
    const total = liveParts(parts).length;
    return {
      eligible: false,
      status: 'planning',
      reasons: [
        total === 0
          ? 'awaiting your approval of the single-PR plan'
          : `awaiting your approval of the ${total}-part plan`,
      ],
    };
  }
  if (planVerdict.route !== 'parts') return null;
  const { settled, total } = planProgress(parts);
  const reason =
    total === 0
      ? 'plan split this into parts'
      : plan.status === 'complete'
        ? `plan complete — all ${total} part${total === 1 ? '' : 's'} finished; close the issue or replan`
        : `${settled}/${total} parts done`;
  return { eligible: false, status: 'planning', reasons: [reason] };
}

function activeStatus(origin: string, ctx: IssuePickupContext): HeldStatus {
  const active = ctx.tasks.find((t) => t.originRef === origin && isActiveTask(t));
  if (!active) return null;
  const reason =
    active.status === 'running'
      ? 'agent running'
      : active.status === 'queued'
        ? 'agent queued'
        : 'agent waiting on you';
  return { eligible: false, status: 'active', reasons: [reason] };
}

function standingHoldStatus(issue: Issue, origin: string, ctx: IssuePickupContext): HeldStatus {
  const held = deliveryHold(ctx.deliveries?.find((d) => d.originRef === origin) ?? null, issue, {
    pickupStates: ctx.policy.pickupStates,
    signals: ctx.deliverySignals,
  });
  if (held) return { eligible: false, status: 'delivered', reasons: [held] };

  const block = blockedGoals(ctx.obstacleBlocks ?? [], ctx.obstacles ?? []).get(origin);
  if (block) {
    return {
      eligible: false,
      status: 'obstacle',
      reasons: [`blocked behind ${block.obstacleId}: ${block.note}`],
    };
  }

  if (isGoalPaused(issue, ctx.policy)) {
    return { eligible: false, status: 'paused', reasons: [PAUSED_REASON] };
  }

  const intrinsic = isIssuePickupEligible(issue, ctx.policy);
  if (!intrinsic.eligible) {
    const status = isContainerIssue(issue, ctx.policy.containerTypes) ? 'container' : 'unwatched';
    return { eligible: false, status, reasons: intrinsic.reasons };
  }

  const appraisal = appraisalFor(issue, ctx);
  if (appraisal) return { eligible: false, status: 'appraisal', reasons: [appraisal] };
  return null;
}

function planningRouteStatus(
  issue: Issue,
  ctx: IssuePickupContext,
  route: PlanRouteVerdict,
  plan: Plan | null,
): IssuePickupStatus {
  if (route.route === 'parts') {
    return { eligible: false, status: 'planning', reasons: ['plan split this into parts'] };
  }
  if (route.route === 'escalated') {
    const attempts = countAttempts(planOrigin(issue.number), ctx.recentDecisions);
    return {
      eligible: false,
      status: 'escalated',
      reasons: [`${attempts} planner attempt${attempts === 1 ? '' : 's'} wrote no plan — escalated to a human`],
    };
  }
  if (route.route === 'awaiting_approval') {
    return { eligible: false, status: 'planning', reasons: ['awaiting your approval of the plan'] };
  }
  const planner = ctx.tasks.find((t) => t.originRef === planOrigin(issue.number) && isActiveTask(t));
  if (!planner && sittingHolds(ctx.closedSittings, issue.number, plan)) {
    const aligning = ctx.tasks.some(
      (t) => t.originRef === issueOriginRef('criteriaAlignment', issue.number) && isActiveTask(t),
    );
    return { eligible: false, status: 'sitting', reasons: [aligning ? ALIGNING_REASON : SITTING_REASON] };
  }
  if (!planner && route.planner === 'dispatch') {
    if (ctx.paused) return { eligible: false, status: 'blocked', reasons: ['dispatch paused'] };
    if (ctx.headroom <= 0) return { eligible: false, status: 'blocked', reasons: ['no agent capacity'] };
  }
  const reason = planner
    ? `planning agent ${planner.status === 'waiting' ? 'waiting on you' : planner.status}`
    : route.planner === 'cooldown'
      ? 'planning on cooldown'
      : 'awaiting a planning agent';
  return { eligible: false, status: 'planning', reasons: [reason] };
}

function investigationStatus(issue: Issue, ctx: IssuePickupContext, standing: InvestigationStanding): HeldStatus {
  if (!standing.labelled) return null;
  const reason =
    standing.hold ??
    preplanAgentReason(issue, ctx, {
      origin: investigateOrigin(issue.number),
      settled: standing.inForce !== null,
      waiting: 'investigation agent waiting on you',
      running: 'being investigated before it is planned',
      cooldown: 'investigation on cooldown',
      awaiting: 'awaiting an investigation before it is planned',
    });
  return reason === null ? null : { eligible: false, status: 'investigation', reasons: [reason] };
}

export function issuePickupStatus(issue: Issue, ctx: IssuePickupContext): IssuePickupStatus {
  const ended = endedStatus(issue, ctx);
  if (ended) return ended;

  const plan = ctx.plans?.find((p) => p.originRef === issueOrigin(issue.number)) ?? null;
  const investigation = investigationStanding(ctx.investigations, issue.number);
  const parts = plan ? (ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [];
  const planVerdict = resolvePlanRoute({
    plan,
    verdict: plannerVerdict(issue.number, plan, ctx.now, ctx.recentDecisions, ctx.cooldown),
    existingParts: liveParts(parts).length,
  });
  const gated = planGateStatus(planVerdict, plan, parts);
  if (gated) return gated;

  const openPr = openPrForIssue(issue, ctx.openPrs);
  if (openPr) return { eligible: false, status: 'has_pr', reasons: [`has open PR #${openPr.number}`] };

  const origin = issueOriginRef('root', issue.number);
  const held =
    activeStatus(origin, ctx) ??
    standingHoldStatus(issue, origin, ctx) ??
    investigationStatus(issue, ctx, investigation);
  return held ?? planningRouteStatus(issue, ctx, planVerdict, plan);
}

function appraisalFor(issue: Issue, ctx: IssuePickupContext): string | null {
  const origin = issueOriginRef('root', issue.number);
  const stored = ctx.appraisals?.find((a) => a.originRef === origin) ?? null;
  return (
    appraisalHold(stored, issue) ??
    preplanAgentReason(issue, ctx, {
      origin: appraisalOrigin(issue.number),
      settled: isAppraised(stored, issue),
      waiting: 'goal appraisal waiting on you',
      running: 'a goal appraisal is running',
      cooldown: 'goal appraisal on cooldown',
      awaiting: 'awaiting a goal appraisal',
    })
  );
}

interface PreplanAgent {
  origin: string;
  /** Its record already stands for the issue's current text. */
  settled: boolean;
  waiting: string;
  running: string;
  cooldown: string;
  awaiting: string;
}

/** Why a read-only agent that runs before the planner holds the issue, or null once it no longer can. */
function preplanAgentReason(issue: Issue, ctx: IssuePickupContext, agent: PreplanAgent): string | null {
  if (agent.settled || hasWorkStarted(issue.number, ctx.tasks)) return null;
  if (ctx.plans?.some((p) => p.originRef === issueOrigin(issue.number))) return null;
  const running = ctx.tasks.find((t) => t.originRef === agent.origin && isActiveTask(t));
  if (running) return running.status === 'waiting' ? agent.waiting : agent.running;
  const verdict = dispatchVerdict(agent.origin, ctx.now, ctx.recentDecisions, ctx.cooldown);
  if (verdict.kind === 'escalate' || verdict.kind === 'hold') return null;
  return verdict.kind === 'cooldown' ? agent.cooldown : agent.awaiting;
}

function countAttempts(origin: string, decisions: Decision[]): number {
  let n = 0;
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if ((a.type === 'dispatch_code_agent' || a.type === 'dispatch_desk_agent') && a.originRef === origin) n += 1;
  }
  return n;
}

export function issuePriority(labels: string[], policy: IssuePickupPolicy): number {
  let best: number | null = null;
  for (const label of labels) {
    const weight = policy.priorityLabels[label];
    if (weight !== undefined && (best === null || weight > best)) best = weight;
  }
  return best ?? policy.defaultPriority;
}
