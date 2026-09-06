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

// → docs/spec/05-dispatcher.md

export interface IssuePickupPolicy {
  watchLabel?: string;
  requireOwnLabel?: boolean;
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

function issueWatchReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  if (!policy.watchLabel) return null;
  const labels = policy.requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
  if (labels.includes(policy.watchLabel)) return null;
  if (policy.requireOwnLabel && issue.labels.includes(policy.watchLabel)) {
    return `watch label "${policy.watchLabel}" not added by you`;
  }
  return `no watch label "${policy.watchLabel}"`;
}

export function issueWatchGateReason(issue: Issue, policy: IssuePickupPolicy): string | null {
  return issueWatchReason(issue, policy);
}

type IssuePickupStatusKind =
  | 'done'
  | 'retained'
  | 'has_pr'
  | 'active'
  | 'container'
  | 'unwatched'
  | 'paused'
  | 'planning'
  | 'delivered'
  | 'appraisal'
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
  obstacleBlocks?: ObstacleBlock[];
  obstacles?: ObstacleStanding[];
  runs?: IssueRun[];
  headroom: number;
  paused: boolean;
}

export function issuePickupStatus(issue: Issue, ctx: IssuePickupContext): IssuePickupStatus {
  if (issue.state !== 'open') {
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
      reasons: [
        total === 0
          ? 'awaiting your approval of the single-PR plan'
          : `awaiting your approval of the ${total}-part plan`,
      ],
    };
  }

  if (planVerdict.route === 'parts' && plan) {
    const { settled, total } = planProgress(parts);
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
  if (verdict.kind === 'escalate' || verdict.kind === 'hold') return null;
  return verdict.kind === 'cooldown' ? 'goal appraisal on cooldown' : 'awaiting a goal appraisal';
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
