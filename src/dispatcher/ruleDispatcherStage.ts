import type { DispatchContext } from './dispatcher.js';
import type { Decision, Issue, Plan, PullRequest, ValidationCheck } from '../types.js';
import {
  effectivePickupStates,
  isIssuePickupEligible,
  issueWatchGateReason,
  issuePriority,
  openPrForIssue,
  type IssuePickupPolicy,
} from './issuePickup.js';
import { dispatchVerdict, type CooldownPolicy } from './dispatchCooldown.js';
import { blockedGoals } from '../obstacles/blocked.js';
import { deliveryHold } from '../delivery/delivery.js';
import { appraisalHold } from '../intake/appraisal.js';
import { resolveModelTag } from '../modelLabels.js';
import { pinnedProfileFor } from '../profilePin.js';
import { issueOrigin, plannerVerdict, resolvePlanRoute, type PlanRouteVerdict } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import { linkEdges, sequenceReadiness } from '../sequence/readiness.js';
import { sequenceableFeatures as sequenceable, DEFAULT_SEQUENCE_MAX_CHILDREN } from '../sequence/sequence.js';
import { isActive, type Candidate, type ConsiderOptions, type StageContext } from './rules/context.js';

// → docs/spec/05-dispatcher.md

export function activeOriginsOf(ctx: DispatchContext): Set<string> {
  const activeOrigins = new Set(ctx.tasks.filter((t) => isActive(t) && t.originRef).map((t) => t.originRef as string));
  for (const job of ctx.standingJobs ?? []) if (job.originRef) activeOrigins.add(job.originRef);
  for (const held of ctx.ejections ?? []) activeOrigins.add(held.originRef);
  return activeOrigins;
}

export function issueGates(
  ctx: DispatchContext,
  pickup: IssuePickupPolicy,
  openPrs: PullRequest[],
): Pick<StageContext, 'deliveryParked' | 'appraisals' | 'appraisalParked' | 'retained' | 'eligibleIssues'> {
  const deliveries = new Map((ctx.deliveries ?? []).map((d) => [d.originRef, d]));
  const deliveryParked = (issue: Issue): boolean =>
    deliveryHold(deliveries.get(issueOrigin(issue.number)) ?? null, issue, {
      pickupStates: pickup.pickupStates,
      signals: ctx.deliverySignals,
    }) !== null;

  const appraisals = new Map((ctx.appraisals ?? []).map((a) => [a.originRef, a]));
  const appraisalParked = (issue: Issue): boolean =>
    appraisalHold(appraisals.get(issueOrigin(issue.number)) ?? null, issue) !== null;

  const blocked = blockedGoals(ctx.obstacleBlocks ?? [], ctx.obstacles ?? []);

  const retained = new Set(ctx.retainedIssues ?? []);

  const eligibleIssues = ctx.world.issues
    .filter(
      (i) =>
        !retained.has(i.number) &&
        i.state === 'open' &&
        openPrForIssue(i, openPrs) === null &&
        !deliveryParked(i) &&
        !appraisalParked(i) &&
        !blocked.has(issueOrigin(i.number)) &&
        isIssuePickupEligible(i, pickup).eligible,
    )
    .map((issue) => ({ issue, weight: issuePriority(issue.labels, pickup) }))
    .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);

  return { deliveryParked, appraisals, appraisalParked, retained, eligibleIssues };
}

export function planRoutes(
  ctx: DispatchContext,
  eligibleIssues: StageContext['eligibleIssues'],
  plansByOrigin: ReadonlyMap<string, Plan>,
  cooldown: CooldownPolicy,
): Map<number, PlanRouteVerdict> {
  const routes = new Map<number, PlanRouteVerdict>();
  for (const { issue } of eligibleIssues) {
    const plan = plansByOrigin.get(issueOrigin(issue.number)) ?? null;
    routes.set(
      issue.number,
      resolvePlanRoute({
        plan,
        verdict: plannerVerdict(issue.number, plan, ctx.world.takenAt, ctx.recentDecisions, cooldown),
        existingParts: plan ? liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id)).length : 0,
      }),
    );
  }
  return routes;
}

export function sequencingView(
  ctx: DispatchContext,
  pickup: IssuePickupPolicy,
): Pick<StageContext, 'sequences' | 'sequenceWaits' | 'sequenceableFeatures'> {
  const sequencing = pickup.sequencing ?? 'off';
  const sequences = new Map((ctx.featureSequences ?? []).map((s) => [s.originRef, s]));
  const edges =
    sequencing === 'off'
      ? []
      : [
          ...linkEdges(ctx.world.issues),
          ...[...sequences.values()]
            .filter((s) => s.status === 'accepted')
            .flatMap((s) => s.edges.map((e) => ({ issue: e.issue, dependsOn: e.dependsOn }))),
        ];
  const sequenceWaits = sequenceReadiness(edges, {
    issues: ctx.world.issues,
    watched: (issue) => issueWatchGateReason(issue, pickup) === null,
  });
  const sequenceableFeatures =
    sequencing === 'full'
      ? sequenceable(
          ctx.world.issues,
          pickup.containerTypes,
          (issue) => issueWatchGateReason(issue, pickup) === null,
          pickup.sequenceMaxChildren ?? DEFAULT_SEQUENCE_MAX_CHILDREN,
        )
      : [];
  return { sequences, sequenceWaits, sequenceableFeatures };
}

export function checksByOrigin(checks: ValidationCheck[]): Map<string, ValidationCheck[]> {
  const validationChecks = new Map<string, ValidationCheck[]>();
  for (const check of checks) {
    const group = validationChecks.get(check.originRef);
    if (group) group.push(check);
    else validationChecks.set(check.originRef, [check]);
  }
  return validationChecks;
}

export function considerWith(
  ctx: DispatchContext,
  cooldown: CooldownPolicy,
  raw: unknown[],
  candidates: Candidate[],
): StageContext['consider'] {
  return (candidate: Candidate, opts?: ConsiderOptions): boolean => {
    const verdict = dispatchVerdict(
      candidate.origin,
      ctx.world.takenAt,
      opts?.decisions ?? ctx.recentDecisions,
      cooldown,
    );
    if (verdict.kind === 'escalate') {
      if (opts?.escalate) raw.push(opts.escalate(verdict.attempts));
      return false;
    }
    if (verdict.kind === 'cooldown') {
      candidates.push({ ...candidate, held: 'cooldown' });
      return true;
    }
    if (verdict.kind === 'dispatch') {
      candidates.push(candidate);
      return true;
    }
    return false;
  };
}

export function pinResolver(
  ctx: DispatchContext,
  plansByOrigin: ReadonlyMap<string, Plan>,
  profileOverrides: ReadonlyMap<string, string>,
): StageContext['pinFor'] {
  return (originRef: string | null) =>
    (originRef === null ? undefined : profileOverrides.get(originRef)) ??
    pinnedProfileFor(originRef, {
      goal: (issueNumber) =>
        resolveModelTag(
          ctx.world.issues.find((i) => i.number === issueNumber)?.labels,
          ctx.modelPins?.labelPrefix ?? '',
          ctx.modelPins?.models,
        ).profile,
      part: (issueNumber, slug) => {
        const plan = plansByOrigin.get(issueOrigin(issueNumber));
        if (!plan) return null;
        return (ctx.planParts ?? []).find((p) => p.planId === plan.id && p.slug === slug)?.profile ?? null;
      },
    });
}

export function cycleLookups(
  ctx: DispatchContext,
): Pick<
  StageContext,
  | 'notified'
  | 'dispatchedSignals'
  | 'conclusions'
  | 'shortfallsByOrigin'
  | 'validationPlans'
  | 'obstacles'
  | 'prReviewRoutes'
  | 'prSplits'
  | 'descriptionDrafts'
  | 'uncheckedDescriptions'
  | 'prReviews'
  | 'prReviewedElsewhere'
  | 'liveLocalRun'
  | 'remoteRuns'
  | 'localValidations'
> {
  return {
    notified: notifiedOriginsByAgent(ctx.recentDecisions),
    dispatchedSignals: dispatchedSignalsByBranch(ctx.recentDecisions),
    conclusions: new Map((ctx.conclusions ?? []).map((c) => [c.originRef, c])),
    shortfallsByOrigin: new Map((ctx.shortfalls ?? []).map((sf) => [sf.originRef, sf])),
    validationPlans: new Map((ctx.validationPlans ?? []).map((r) => [r.originRef, r])),
    obstacles: ctx.obstacles ?? [],
    prReviewRoutes: new Map((ctx.prReviewRoutes ?? []).map((route) => [route.prNumber, route])),
    prSplits: new Map((ctx.prSplits ?? []).map((v) => [v.prNumber, v])),
    descriptionDrafts: ctx.descriptionDrafts ?? [],
    uncheckedDescriptions: ctx.uncheckedDescriptions ?? [],
    prReviews: new Map((ctx.prReviews ?? []).map((review) => [review.prNumber, review])),
    prReviewedElsewhere: ctx.prReviewedElsewhere ?? new Set<number>(),
    liveLocalRun: ctx.localRun ?? null,
    remoteRuns: ctx.remoteRuns ?? [],
    localValidations: ctx.localValidations ?? [],
  };
}

export function workItemGates(pickup: IssuePickupPolicy): Pick<StageContext, 'workItemStates' | 'workItemInProgress'> {
  const pickupStates = effectivePickupStates(pickup);
  return {
    workItemStates:
      pickup.inReviewState && pickupStates?.length ? { inReviewState: pickup.inReviewState, pickupStates } : null,
    workItemInProgress:
      pickup.inProgressState && pickupStates?.length ? { inProgressState: pickup.inProgressState, pickupStates } : null,
  };
}

function notifiedOriginsByAgent(decisions: Decision[]): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if (a.type !== 'respond_to_agent') continue;
    const agentId = a.agentId;
    const origins = a.originRefs;
    if (typeof agentId !== 'string' || !Array.isArray(origins)) continue;
    for (const o of origins) if (typeof o === 'string') set.add(`${agentId}::${o}`);
  }
  return set;
}

function dispatchedSignalsByBranch(decisions: Decision[]): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if (a.type !== 'dispatch_code_agent') continue;
    const branch = a.branch;
    const refs = a.signalRefs;
    if (typeof branch !== 'string' || !Array.isArray(refs)) continue;
    for (const r of refs) if (typeof r === 'string') set.add(`${branch}::${r}`);
  }
  return set;
}
