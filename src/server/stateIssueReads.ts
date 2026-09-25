import type { Issue, IssueAppraisal, IssueDelivery, Retrospective, ScratchPadSummary } from '../types.js';
import { issueCommentRef } from './refUrls.js';
import { placementAsks, type AreaPathTree, type PlacementTypePolicy } from '../intake/placement.js';
import { issuePickupStatus, type IssuePickupContext } from '../dispatcher/issuePickup.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { rollUpIssueSpend } from '../insights/issueSpend.js';
import { retainedRunIssues } from '../runs/runs.js';
import { deliveryHold } from '../delivery/delivery.js';
import { validationVerdict } from '../validation/verdict.js';
import { resolveModelTag } from '../modelLabels.js';
import { once, type ContextReadsOn } from './stateReads.js';
import { localValidationView } from './stateLocalRunViews.js';

// → docs/spec/16-http-api.md

export type IssueReadsOn = ContextReadsOn & ReturnType<typeof issueReads>;

export function issueReads(r: ContextReadsOn) {
  const { system, store, connector, config, world, tasks, agents, issueRuns, runByOrigin } = r;
  const workNodes = once(() => store.graph.listWorkNodes());
  const spend = once(() =>
    rollUpIssueSpend({
      agents: agents(),
      tasks,
      nodes: workNodes(),
      localRuns: store.localRuns.listLocalRuns(),
    }),
  );
  const placementCtx: PlacementContext = {
    areaTree: system.areaPaths.current(),
    canPlace: connector.canPlaceWorkItem(),
    types: { containerTypes: config.issueContainerTypes, parentedTypes: config.issueParentedTypes },
  };
  const enrichIssue = issueEnricher(r, spend, placementCtx);
  const retainedRuns = () => {
    const retained = retainedRunIssues(issueRuns, world.issues);
    const mirrored = new Map(store.tickets.readTrackerItems(retained.map((i) => i.number)).map((t) => [t.number, t]));
    return retained.flatMap((issue) => {
      const run = runByOrigin.get(issueConclusionOrigin(issue.number));
      if (run === undefined) return [];
      const ticket = mirrored.get(issue.number);
      return [
        {
          ...enrichIssue(issue),
          stale: {
            lastSeenAt: run.updatedAt,
            tracker: ticket
              ? { state: ticket.state, workItemState: ticket.workItemState, changedAt: ticket.changedAt }
              : null,
          },
        },
      ];
    });
  };
  return { workNodes, spend, placementCtx, retainedRuns, enrichIssue };
}

function issueEnricher(
  r: ContextReadsOn,
  spend: () => ReturnType<typeof rollUpIssueSpend>,
  placementCtx: PlacementContext,
) {
  const { system, store, config, opts, runByOrigin, pickupCtx, conclusions, planByOrigin, planPartsOf } = r;
  const { shortfallsByOrigin, deliveriesByOrigin, appraisalsByOrigin, padsByOrigin, instructionsByOrigin } = r;
  const { checksByGoal } = r;
  const goalPriorities = once(
    () => new Map(store.priority.listGoalPriorities().map((g) => [g.originRef, { since: g.since }])),
  );
  const localValidations = once(
    () => new Map(store.localValidations.listLatestLocalValidations().map((v) => [v.originRef, v])),
  );
  const liveLocalRun = once(() => store.localRuns.liveLocalRun());
  const validationChecksFor = (origin: string): ReturnType<typeof validationVerdict> | null => {
    const checks = checksByGoal().get(origin) ?? [];
    return checks.length === 0 ? null : validationVerdict(checks);
  };
  return (issue: Issue) => {
    const origin = issueConclusionOrigin(issue.number);
    const run = runByOrigin.get(origin);
    return {
      ...issue,
      pickup: issuePickupStatus(issue, pickupCtx()),
      conclusion: resolveIssueConclusion(
        conclusions().get(origin) ?? null,
        planByOrigin().get(origin) ?? null,
        planPartsOf(origin),
        shortfallsByOrigin().get(origin) ?? null,
      ),
      shortfall: shortfallsByOrigin().get(origin) ?? null,
      delivery: standingDelivery(deliveriesByOrigin().get(origin), issue, pickupCtx()),
      appraisal: appraisalVerdictOf(appraisalsByOrigin().get(origin), issue, placementCtx),
      modelPin: (({ profile, ignored }) => ({ profile, ignoredTags: ignored }))(
        resolveModelTag(issue.labels, config.labelPrefix, config.agentModels),
      ),
      priority: goalPriorities().get(origin) ?? null,
      retrospective: retroReading(store.scratch.getRetrospective(origin)),
      scratchpad: padReading(padsByOrigin().get(origin)),
      instructions: instructionsByOrigin().get(origin) ?? [],
      run: run
        ? {
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            outcome: run.outcome,
            dismissed: run.dismissedAt !== null,
          }
        : undefined,
      spend: spend().byIssue.get(origin) ?? null,
      validation: validationChecksFor(origin),
      localValidation: localValidationView(
        localValidations().get(origin),
        liveLocalRun(),
        system.store,
        opts?.localValidationFileSigner,
      ),
    };
  };
}

function standingDelivery(delivery: IssueDelivery | undefined, issue: Issue, ctx: IssuePickupContext) {
  if (!delivery) return null;
  const held = deliveryHold(delivery, issue, { pickupStates: ctx.policy.pickupStates, signals: ctx.deliverySignals });
  if (!held) return null;
  const { summary, by, decidedAt } = delivery;
  return { summary, by, decidedAt };
}

function retroReading(retro: Retrospective | null) {
  return retro ? { summary: retro.summary, hasDocument: retro.document.length > 0, updatedAt: retro.updatedAt } : null;
}

function padReading(pad: ScratchPadSummary | undefined) {
  return pad && pad.entries > 0 ? { entries: pad.entries, updatedAt: pad.updatedAt } : null;
}

function appraisalVerdictOf(appraisal: IssueAppraisal | undefined, issue: Issue, placement: PlacementContext) {
  if (!appraisal) return null;
  const { verdict, summary, missing, by, decidedAt, proposedProfile } = appraisal;
  return {
    verdict,
    summary,
    missing,
    by,
    decidedAt,
    commentRef: issueCommentRef(appraisal.originRef, appraisal.commentRef),
    proposedProfile,
    awaitingProfileAnswer: proposedProfile !== null && appraisal.profileAnsweredAt === null,
    placement: placement.canPlace
      ? placementAsks(appraisal, issue, placement.areaTree, appraisal.goalRef, placement.types)
      : [],
    parentSettledAt: appraisal.parentSettledAt,
  };
}

interface PlacementContext {
  areaTree: AreaPathTree | null;
  canPlace: boolean;
  types: PlacementTypePolicy;
}
