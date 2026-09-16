import { existsSync } from 'node:fs';
import { issueOriginRef } from '../issueOrigins.js';
import type { System } from '../system.js';
import type { Config } from '../config/config.js';
import { revealGateOn } from '../config/config.js';
import { planIsWithheld, WITHHELD_PLAN } from './planReveal.js';
import { sheetFoldLine } from '../remoteValidation/sheet.js';
import { resolveTenant } from '../remoteValidation/tenants.js';
import type {
  EnvironmentHealthReading,
  GoalArrival,
  GoalWatch,
  Issue,
  IssueAppraisal,
  IssueDelivery,
  IssueInstruction,
  IssueShortfall,
  LocalRun,
  LocalValidation,
  LocalRunReadings,
  LocalRunTurn,
  Plan,
  PlanPart,
  Retrospective,
  ScratchPadSummary,
  TaskSummary,
  WatchReading,
  WorkNode,
  WorldSnapshot,
} from '../types.js';
import type { StateSection } from '../wire.js';
import type { Store } from '../store/store.js';
import type {
  CockpitState,
  EjectionView,
  GoalReachView,
  GoalWatchView,
  LocalRunRefFacts,
  LocalRunTargetView,
  LocalRunView,
  LocalValidationAgentView,
  LocalValidationPhase,
  LocalValidationView,
  OpenPullRequest,
  PlanPartView,
  PlanView,
  PullRequest,
  RemoteReadingView,
  RemoteSheetView,
  ValidationCheckView,
  ValidationResourceView,
} from '../wire.js';
import { buildRefUrls, decisionSubjectRef, issueCommentRef } from './refUrls.js';
import { fleetHistory } from './fleetHistory.js';
import { placementAsks, truncateAreaPaths, type AreaPathTree, type PlacementTypePolicy } from '../intake/placement.js';
import { buildStacks } from '../stacks/stack.js';
import { landedCount, landingFor, landingReadiness } from '../stacks/landing.js';
import { prHealth, prState } from '../pr/prHealth.js';
import { applyThreadReopens } from '../pr/prThreads.js';
import { expiresAt } from '../ejection/policy.js';
import { prAttentionStatus, type PrAttentionContext } from '../pr/prAttention.js';
import { reviewReading } from '../review/prReview.js';
import { prReviewState } from '../review/prReviewState.js';
import { packStandingOf } from '../reviewPacks/standing.js';
import {
  effectivePickupStates,
  issuePickupStatus,
  openPrForIssue,
  type IssuePickupContext,
} from '../dispatcher/issuePickup.js';
import { pausedIssueNumbers } from '../goalPause.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { rollUpIssueSpend } from '../insights/issueSpend.js';
import { tallyRunOutcomes } from '../insights/reliabilityInsights.js';
import { retainedRunIssues } from '../floor/runs.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import { readRunway } from '../supply/runway.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';
import { trackerCoordinates } from '../mcp/findings.js';
import { featureBoardOn } from '../features/featureBoard.js';
import { rejectionSignalQuery } from '../proposals/proposals.js';
import { detectFileOverlaps, OVERLAP_AGENT_WINDOW } from '../fileOverlap.js';
import { acceptanceCriteria, bySlug, partDepth, partOrigin, planIssueNumber } from '../plans/parts.js';
import { planScopeDrift } from '../plans/scopeDrift.js';
import { deliveryHold, deliverySignalQuery } from '../delivery/delivery.js';
import { classifyCiFailures } from '../ci/ciPolicy.js';
import { validationVerdict } from '../validation/verdict.js';
import { localRunIsLive } from '../store/localRuns.js';
import { localRunChoices } from '../localRun/ref.js';
import { isActiveTask } from '../tasks.js';
import { validationResourcePath } from '../validation/resources.js';
import { withLiveClaim } from '../validation/desktop.js';
import { watchLabelFor } from '../watchLabels.js';
import { candidateParents } from '../issueRelations.js';
import { allGoalReach } from '../environments/reach.js';
import { environmentGateHold } from '../environments/arrival.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { resolveModelTag } from '../modelLabels.js';
import { orderedProfiles } from '../agents/modelPolicy.js';

// → docs/spec/16-http-api.md

export const STATE_SECTIONS: readonly StateSection[] = [
  'harness',
  'control',
  'goals',
  'plans',
  'fleet',
  'queue',
  'inbox',
  'activity',
];

const ALL_SECTIONS: ReadonlySet<StateSection> = new Set(STATE_SECTIONS);

function once<T>(read: () => T): () => T {
  let held: { value: T } | null = null;
  return () => {
    held ??= { value: read() };
    return held.value;
  };
}

interface SnapshotOpts {
  artifactSigner?: (flagId: string) => string;
  attachmentSigner?: (attachmentId: string) => string;
  localValidationFileSigner?: (id: string, name: string) => string;
  validationCaptureSigner?: (originRef: string, checkId: string) => string;
}

export function buildStateSnapshot(system: System, opts?: SnapshotOpts): CockpitState {
  return buildStateSections(system, ALL_SECTIONS, opts) as CockpitState;
}

const EJECTION_ROWS = 40;

export function buildStateSections(
  system: System,
  want: ReadonlySet<StateSection>,
  opts?: SnapshotOpts,
): Partial<CockpitState> {
  const { store, connector, config, runtimeControl, harness, recovery, updates, readying, agents: fleet } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);
  const stored = store.world.getWorldBaseline();
  const baseline = stored === null ? null : applyThreadReopens(stored, store.threadReopens.prThreadReopens());
  const world: WorldSnapshot = baseline ?? {
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
  };
  const archivedPullRequests = store.prArchive.listArchivedPrs();
  const tasks = store.tasks.listTasks();
  const agents = once(() => store.agents.listAgents());
  const history = once(() => fleetHistory(agents(), tasks));
  const control = runtimeControl.snapshot();
  const flags = once(() => store.agents.listAllFlags());
  const attachments = once(() => store.jobs.listAllAttachments());
  const humanTasks = store.humanTasks.listHumanTasks();
  const ejectionViews = (): EjectionView[] =>
    store.ejections.listEjections(EJECTION_ROWS).map((row) => ({
      ...row,
      expiresAt: expiresAt(row.ejectedAt, config.ejection),
      neverContacted:
        row.lastSeenAt === null &&
        Date.now() - Date.parse(row.ejectedAt) >= config.ejection.contactGraceMinutes * 60_000,
    }));
  const allHumanTasks = once(() => store.humanTasks.listAllHumanTasks());
  const proposals = store.escalations.listProposals();
  const bugFilings = store.bugFilings.listBugFilings();
  const overlaps = once(() => {
    const overlapAgents = agents().slice(0, OVERLAP_AGENT_WINDOW);
    return detectFileOverlaps({
      files: store.agents.listFilesForAgents(overlapAgents.map((a) => a.id)),
      agents: overlapAgents,
      tasks,
    });
  });
  const plans = store.plans.listPlans();
  const planParts = once(() => store.plans.listAllPlanParts());
  const partsByPlan = once(() => {
    const byPlan = new Map<string, PlanPart[]>();
    for (const part of planParts()) {
      const held = byPlan.get(part.planId);
      if (held) held.push(part);
      else byPlan.set(part.planId, [part]);
    }
    return byPlan;
  });
  const partsOfPlan = (planId: string): PlanPart[] => partsByPlan().get(planId) ?? [];
  const planByOrigin = once(() => {
    const byOrigin = new Map<string, Plan>();
    for (const plan of plans) if (!byOrigin.has(plan.originRef)) byOrigin.set(plan.originRef, plan);
    return byOrigin;
  });
  const planPartsOf = (origin: string): PlanPart[] => {
    const plan = planByOrigin().get(origin);
    return plan ? partsOfPlan(plan.id) : [];
  };
  const stacks = once(() => buildStacks(world.pullRequests, plans, planParts(), config.defaultBranch));
  const openPrNumbers = new Set(world.pullRequests.filter((p) => !p.merged).map((p) => p.number));
  const mergedPrs = once(() => store.graph.mergedPrs());
  const landings = once(() =>
    store.landings.listStackLandings().filter((l) => l.status === 'standing' || l.status === 'stopped'),
  );
  const reveals = once(() => {
    const byPlan = new Map<string, { revealed: boolean; revealedAt: string | null }>();
    for (const plan of plans) {
      byPlan.set(plan.id, {
        revealed: !planIsWithheld(system, plan),
        revealedAt: revealGateOn(config) ? (system.predictions.getReveal(plan.originRef)?.revealedAt ?? null) : null,
      });
    }
    return byPlan;
  });
  const withheld = (planId: unknown): boolean =>
    typeof planId === 'string' && reveals().get(planId)?.revealed === false;
  const wirePlans: PlanView[] = plans.map((p) => {
    const stamp = reveals().get(p.id) ?? { revealed: true, revealedAt: null };
    const view = { ...p, statusCommentRef: issueCommentRef(p.originRef, p.statusCommentRef), ...stamp };
    if (stamp.revealed) return view;
    return {
      ...view,
      diagnosis: null,
      approach: null,
      reason: null,
      risks: null,
      outOfScope: null,
      alternatives: null,
      openQuestions: null,
      verification: null,
      document: null,
      evidence: [],
    };
  });
  const drift = once(() => {
    const partOrigins = new Set(
      plans.flatMap((plan) => {
        const issueNumber = planIssueNumber(plan.originRef);
        if (issueNumber === null) return [];
        return partsOfPlan(plan.id).map((p) => partOrigin(issueNumber, p.slug));
      }),
    );
    const driftFiles = store.agents.listFilesForAgents([
      ...new Set(
        tasks.flatMap((t) =>
          t.originRef !== null && partOrigins.has(t.originRef) && t.agentId !== null ? [t.agentId] : [],
        ),
      ),
    ]);
    const drifted = new Map<string, string[]>();
    for (const plan of plans) {
      const issueNumber = planIssueNumber(plan.originRef);
      if (issueNumber === null) continue;
      for (const d of planScopeDrift(issueNumber, partsOfPlan(plan.id), tasks, driftFiles)) {
        drifted.set(d.partId, d.paths);
      }
    }
    return drifted;
  });
  const wirePlanParts = once((): PlanPartView[] => {
    const partIndexes = new Map(plans.map((plan) => [plan.id, bySlug(partsOfPlan(plan.id))]));
    const drifted = drift();
    return planParts()
      .filter((part) => !withheld(part.planId))
      .map((part) => ({
        ...part,
        depth: partDepth(part, partIndexes.get(part.planId) ?? bySlug([part])),
        acceptanceCriteria: acceptanceCriteria(part),
        outsideScope: drifted.get(part.id) ?? [],
      }));
  });
  const claimNow = new Date().toISOString();
  const validationChecks = once((): ValidationCheckView[] =>
    store.validation
      .listAllValidationChecks()
      .map((check) => withLiveClaim(check, claimNow, config.validation.desktopClaimMinutes))
      .map((check) => ({ ...check, captureUrl: captureUrl(check, opts?.validationCaptureSigner) })),
  );
  const checksByGoal = once(() => {
    const byGoal = new Map<string, ValidationCheckView[]>();
    for (const check of validationChecks()) {
      const list = byGoal.get(check.originRef);
      if (list) list.push(check);
      else byGoal.set(check.originRef, [check]);
    }
    return byGoal;
  });
  const wireValidationResources = once((): ValidationResourceView[] =>
    store.validation.listAllValidationResources().map((resource) => {
      const path = validationResourcePath(config.validationRoot, resource.originRef, resource.name);
      return { ...resource, path, present: existsSync(path) };
    }),
  );
  const goalWatches = once(() => store.watches.listGoalWatches());
  const conclusions = once(() => new Map(store.verdicts.listIssueConclusions().map((c) => [c.originRef, c])));
  const deliveries = once(() => store.verdicts.listDeliveries());
  const deliveriesByOrigin = once(() => new Map(deliveries().map((d) => [d.originRef, d])));
  const deliverySignals = once(() => {
    const query = deliverySignalQuery(deliveries());
    return query ? store.world.listWorldEventsSince(query.since, query.refs) : [];
  });
  const issueRuns = store.floor.listIssueRuns();
  const runByOrigin = new Map(issueRuns.map((r) => [r.originRef, r]));
  const shortfallsByOrigin = once(() => new Map(store.verdicts.listShortfalls().map((s) => [s.originRef, s])));
  const padsByOrigin = once(() => new Map(store.scratch.listScratchPadSummaries().map((p) => [p.padRef, p])));
  const instructionsByOrigin = once(() => {
    const byOrigin = new Map<string, IssueInstruction[]>();
    for (const instruction of store.instructions.listAllStandingInstructions()) {
      const held = byOrigin.get(instruction.originRef);
      if (held) held.push(instruction);
      else byOrigin.set(instruction.originRef, [instruction]);
    }
    return byOrigin;
  });
  const appraisals = store.verdicts.listAppraisals();
  const appraisalsByOrigin = once(() => new Map(appraisals.map((a) => [a.originRef, a])));
  const recentDecisions = once(() => store.decisions.listDecisions(200));
  const pickupCtx = once(
    (): IssuePickupContext => ({
      policy: {
        ...system.issuePickup,
        pausedIssues: pausedIssueNumbers(
          store.pauses.listGoalPauses(),
          world.issues,
          system.issuePickup.containerTypes,
        ),
      },
      cooldown: DEFAULT_COOLDOWN,
      now: world.takenAt,
      tasks,
      recentDecisions: recentDecisions(),
      openPrs: world.pullRequests,
      plans,
      planParts: planParts(),
      deliveries: deliveries(),
      deliverySignals: deliverySignals(),
      appraisals,
      obstacleBlocks: store.obstacles.listObstacleBlocks(),
      obstacles: store.obstacles.obstacleBoard(),
      runs: issueRuns,
      headroom: control.paused ? 0 : Math.max(0, control.cap - store.agents.countLiveAgents()),
      paused: control.paused,
    }),
  );
  const reviewRows = once(() => ({
    prReviews: new Map(store.prReviews.listPrReviews().map((review) => [review.prNumber, review])),
    prReviewRoutes: new Map(store.prReviewRoutes.listPrReviewRoutes().map((route) => [route.prNumber, route])),
    prReviewedElsewhere: store.prReviewExternals.prsReviewedElsewhere(),
  }));
  const attentionCtx = once((): PrAttentionContext => {
    const signals = rejectionSignalQuery(proposals);
    return {
      openPrs: world.pullRequests,
      defaultBranch: config.defaultBranch,
      watchLabel,
      tasks,
      proposals,
      rejectionSignals: signals ? store.world.listWorldEventsSince(signals.since, signals.refs) : [],
      recentDecisions: recentDecisions(),
      cooldown: DEFAULT_COOLDOWN,
      ci: config.ci,
      now: world.takenAt,
      reviewWaits: store.reviewWaits.reviewWaits(),
      review: config.review,
      ...reviewRows(),
    };
  });
  const worldEvents = store.world.listWorldEvents(100);
  const shiftLog = recentDecisions()
    .slice(0, 100)
    .map((d) => ({ ...d, subjectRef: decisionSubjectRef(d.action) }));
  const refUrls = buildRefUrls({
    pullRequests: [...world.pullRequests, ...(world.closedPullRequests ?? []), ...archivedPullRequests],
    issues: world.issues,
    taskBranches: tasks.map((t) => t.branch),
    refs: [
      ...bugFilings.map((b) => b.originRef),
      ...bugFilings.map((b) => b.ticketRef),
      ...humanTasks.map((t) => t.originRef),
      ...proposals.map((p) => p.ref),
      ...wirePlans.map((p) => p.statusCommentRef),
      ...appraisals.map((a) => issueCommentRef(a.originRef, a.commentRef)),
      ...worldEvents.map((e) => e.ref),
      ...tasks.map((t) => t.originRef),
      ...world.issues.map((i) => issueOriginRef('root', i.number)),
      ...issueRuns.map((r) => r.originRef),
      ...shiftLog.map((d) => d.subjectRef),
    ],
    resolve: (ref) => connector.resolveRefUrl(ref),
  });
  const workNodes = once(() => store.graph.listWorkNodes());
  const spend = once(() =>
    rollUpIssueSpend({
      agents: agents(),
      tasks,
      nodes: workNodes(),
      localRuns: store.localRuns.listLocalRuns(),
    }),
  );
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
  const placementCtx: PlacementContext = {
    areaTree: system.areaPaths.current(),
    canPlace: connector.canPlaceWorkItem(),
    types: { containerTypes: config.issueContainerTypes, parentedTypes: config.issueParentedTypes },
  };
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

  const enrichIssue = (issue: Issue) => {
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
  const reviewStateOf = (pr: PullRequest): PullRequest['review'] =>
    prReviewState(pr.number, reviewReading(reviewRows(), pr.number), config.review, pr.reviewThreads) ?? undefined;
  const withReview = <T extends PullRequest>(pr: T): T => ({ ...pr, review: reviewStateOf(pr) });
  const packHeads = once(() => new Map(store.reviewPacks.listReviewPackHeads().map((head) => [head.prNumber, head])));
  const packStandingFor = (pr: PullRequest): PullRequest['pack'] =>
    packStandingOf(packHeads().get(pr.number), pr.headSha, system.reviewPacks.writing(pr.number));

  const splitVerdicts = once(() => new Map(store.prSplits.listPrSplitVerdicts().map((v) => [v.prNumber, v])));
  const openPullRequests = once((): OpenPullRequest[] =>
    world.pullRequests.map((pr) => ({
      ...pr,
      health: prHealth(pr, world.pullRequests),
      attention: prAttentionStatus(pr, attentionCtx()),
      ciVerdict: classifyCiFailures(pr.ciChecks, config.ci, pr.ciChecksWithheld),
      review: reviewStateOf(pr),
      pack: packStandingFor(pr),
      split: splitVerdicts().get(pr.number),
    })),
  );
  const prByBranch = once(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of [...(world.closedPullRequests ?? []), ...openPullRequests()]) map.set(pr.branch, pr);
    return map;
  });
  const harnessSection = (): Pick<
    CockpitState,
    'config' | 'recovery' | 'build' | 'pets' | 'localRun' | 'localRunTargets' | 'planning' | 'dispatchRules'
  > => ({
    config: {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxConcurrentAgents: config.maxConcurrentAgents,
      watchLabel,
      profiles: orderedProfiles(config.agentModels),
      defaultProfile: config.agentModels?.default ?? null,
      desktopFolder: config.repoRoot,
      ejectionEnabled: config.ejection.enabled,
      localRunConfigured: config.localRun.instruction.trim() !== '',
      localValidationBrowserConfigured: config.localValidation.browser !== null,
      localRunStopConfigured: config.localRun.stopInstruction.trim() !== '',
      localRunRefreshConfigured: config.localRun.refreshInstruction.trim() !== '',
      containerTypes: [...config.issueContainerTypes],
      canFileTickets: trackerCoordinates(config) !== null,
      stateColours: { ...config.issueStateColours },
      boardStates: [...config.issueBoardStates],
      canSetWorkItemState: connector.canSetWorkItemState(),
      canCloseIssue: connector.canCloseIssue(),
      canClosePr: connector.canClosePr(),
      canPlaceWorkItem: connector.canPlaceWorkItem(),
      featureBoard: featureBoardOn(config, connector),
      areaPaths: placementCtx.areaTree === null ? [] : truncateAreaPaths(placementCtx.areaTree).paths,
      stateRules: workItemStateRules(config),
    },
    recovery: recovery.pending(),
    build: updates.reading(),
    pets: system.pets.state(),
    localRun: localRunView(system.localRun.current(), system.localRun, system.localRunWatch.reading(), (ref, origin) =>
      localRunRefFacts(ref, planPartsOf(origin), {
        prByBranch: prByBranch(),
        tasks,
        defaultBranch: config.defaultBranch,
      }),
    ),
    localRunTargets: localRunTargetViews({
      issues: world.issues,
      partsOf: planPartsOf,
      prByBranch: prByBranch(),
      openPrs: openPullRequests(),
      tasks,
      defaultBranch: config.defaultBranch,
    }),
    planning: config.planning,
    dispatchRules: DISPATCH_RULES,
  });

  const controlSection = (): Pick<CockpitState, 'control'> => ({
    control,
  });

  // Read once and folded twice: the sheet card draws these rows, and the Environments card's own row
  // carries their fold. Two readers would be two opinions drawn beside each other.
  const remoteSheets = once(() => buildRemoteSheets(store, config.environments, tasks));

  const goalsSection = (): Pick<
    CockpitState,
    | 'worldObservedAt'
    | 'world'
    | 'archivedPullRequests'
    | 'retainedRuns'
    | 'stacks'
    | 'environmentReach'
    | 'featureSequences'
    | 'environmentHealth'
    | 'goalWatchWindows'
    | 'environmentArrivals'
    | 'remoteSheets'
    | 'stackLandings'
  > => {
    const environments = config.environments;
    const arrivals = environments.length === 0 ? [] : store.environments.listGoalArrivals();
    const prByNumber = new Map<number, PullRequest>();
    for (const pr of world.pullRequests) if (!prByNumber.has(pr.number)) prByNumber.set(pr.number, pr);
    const stackRungPrs = new Set(stacks().flatMap((s) => s.rungs.map((r) => r.prNumber)));
    return {
      worldObservedAt: baseline?.takenAt ?? null,
      world: {
        ...world,
        pullRequests: openPullRequests(),
        closedPullRequests: world.closedPullRequests?.map(withReview),
        issues: world.issues.map(enrichIssue),
        parentCandidates: candidateParents(world.issues, config.issueContainerTypes),
      },
      retainedRuns: retainedRuns(),
      archivedPullRequests: archivedPullRequests.map(withReview),
      stacks: stacks(),
      environmentReach:
        environments.length === 0
          ? []
          : buildEnvironmentReach({
              store,
              environments,
              sheets: remoteSheets(),
              plans,
              parts: planParts(),
              arrivals,
              nodes: workNodes(),
              delivered: deliveries(),
              shortfalled: shortfallsByOrigin(),
            }),
      featureSequences: store.sequences.listFeatureSequences(),
      environmentHealth: buildEnvironmentHealth(store, environments),
      goalWatchWindows: buildGoalWatchWindows(store, environments, goalWatches),
      environmentArrivals: arrivals.slice(0, 50),
      remoteSheets: remoteSheets(),
      stackLandings: [
        ...stacks().map((stack) => {
          const rungPrs = stack.rungs.flatMap((rung) => {
            const pr = prByNumber.get(rung.prNumber);
            return pr ? [pr] : [];
          });
          const landing = landingFor(
            stack.rungs.map((r) => r.prNumber),
            landings(),
            openPrNumbers,
          );
          return {
            ref: stack.ref,
            ...landingReadiness(rungPrs),
            landing,
            landed: landing ? landedCount(landing, { ...world, merged: mergedPrs() }) : 0,
          };
        }),
        ...landings()
          .filter((l) => l.status === 'standing' && !l.rungs.some((n) => stackRungPrs.has(n)))
          .map((landing) => ({
            ref: landing.ref,
            offer: false,
            blockedBy: null,
            landing,
            landed: landedCount(landing, { ...world, merged: mergedPrs() }),
          })),
      ],
    };
  };

  const plansSection = (): Pick<
    CockpitState,
    | 'plans'
    | 'planParts'
    | 'planAtoms'
    | 'planCaveatAnswers'
    | 'validationChecks'
    | 'validationPlans'
    | 'validationResources'
    | 'goalWatches'
    | 'stateQueries'
  > => ({
    plans: wirePlans,
    planParts: wirePlanParts(),
    planAtoms: store.plans.listAllPlanAtoms().filter((atom) => !withheld(atom.planId)),
    planCaveatAnswers: store.plans.listAllPlanCaveatAnswers(),
    validationChecks: validationChecks(),
    validationPlans: store.validation.listValidationPlanRecords(),
    validationResources: wireValidationResources(),
    goalWatches: [...goalWatches(), ...store.watches.listProposedGoalWatches()],
    stateQueries: store.remoteValidation.listStateQueries(),
  });

  const fleetSection = (): Pick<
    CockpitState,
    | 'tasks'
    | 'agents'
    | 'endedAgents'
    | 'ejections'
    | 'readying'
    | 'parkedOnLimit'
    | 'stallParks'
    | 'flags'
    | 'artifactUrls'
    | 'attachments'
    | 'attachmentUrls'
    | 'overlaps'
    | 'usage'
    | 'runOutcomes'
  > => ({
    tasks: history().tasks,
    agents: history().agents,
    endedAgents: history().ended,
    ejections: ejectionViews(),
    readying: readying.list(),
    parkedOnLimit: fleet.limitedAgentIds(),
    stallParks: fleet.stallDeadlines(),
    flags: flags(),
    artifactUrls: artifactUrls(flags(), opts?.artifactSigner),
    attachments: attachments(),
    attachmentUrls: attachmentUrls(attachments(), opts?.attachmentSigner),
    overlaps: overlaps(),
    usage: buildUsage(system, spend().unattributedCostUsd),
    runOutcomes: tallyRunOutcomes(agents()),
  });

  const queueSection = (): Pick<CockpitState, 'jobs' | 'schedules' | 'upcoming' | 'runway'> => ({
    jobs: store.jobs.listJobs(),
    schedules: store.schedules.listJobSchedules(),
    upcoming: harness.upcoming,
    runway: readRunway({
      policy: config.runway,
      issues: world.issues,
      pickup: pickupCtx(),
      runs: issueRuns,
      humanTasks: allHumanTasks(),
      escalations: store.escalations.listEscalationSpans(),
      cap: control.cap,
      standing: allHumanTasks().some((t) => t.kind === 'supply' && t.status === 'open'),
    }),
  });

  const inboxSection = (): Pick<CockpitState, 'bugFilings' | 'humanTasks' | 'escalations' | 'proposals'> => ({
    bugFilings,
    humanTasks,
    escalations: store.escalations.listOpenEscalations().map((e) => {
      if (!withheld(e.context.planId)) return e;
      return {
        ...e,
        prompt: WITHHELD_PLAN,
        context: { ...e.context, detail: WITHHELD_PLAN, detailFrom: 'Withheld until the plan is revealed' },
      };
    }),
    proposals: proposals.map((p) => {
      if (!withheld(p.action.planId)) return p;
      return { ...p, action: { ...p.action, prompt: WITHHELD_PLAN, detail: WITHHELD_PLAN, caveats: [] } };
    }),
  });

  const activitySection = (): Pick<CockpitState, 'decisions' | 'worldEvents' | 'errors'> => ({
    decisions: shiftLog,
    worldEvents,
    errors: store.errors.listErrors(100),
  });

  const out: Partial<CockpitState> = {
    refUrls,
  };
  if (want.has('harness')) Object.assign(out, harnessSection());
  if (want.has('control')) Object.assign(out, controlSection());
  if (want.has('goals')) Object.assign(out, goalsSection());
  if (want.has('plans')) Object.assign(out, plansSection());
  if (want.has('fleet')) Object.assign(out, fleetSection());
  if (want.has('queue')) Object.assign(out, queueSection());
  if (want.has('inbox')) Object.assign(out, inboxSection());
  if (want.has('activity')) Object.assign(out, activitySection());
  return out;
}

function artifactUrls(
  flags: { id: string; ref: string }[],
  signer?: (flagId: string) => string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const flag of flags) {
    if (/^https?:\/\//i.test(flag.ref)) continue;
    const base = `/artifacts/${encodeURIComponent(flag.id)}`;
    map[flag.id] = signer ? `${base}?tk=${encodeURIComponent(signer(flag.id))}` : base;
  }
  return map;
}

function attachmentUrls(attachments: { id: string }[], signer?: (id: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attachment of attachments) {
    const base = `/attachments/${encodeURIComponent(attachment.id)}`;
    map[attachment.id] = signer ? `${base}?tk=${encodeURIComponent(signer(attachment.id))}` : base;
  }
  return map;
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

function buildUsage(system: System, unattributedCostUsd: number) {
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return {
    windows: {
      fiveHourCostUsd: system.store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
      sevenDayCostUsd: system.store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
    },
    rateLimits: system.store.rateLimits.readRateLimits(),
    unattributedCostUsd,
  };
}

function buildEnvironmentHealth(store: System['store'], environments: EnvironmentConfig[]): EnvironmentHealthReading[] {
  const byEnvironment = groupBy(store.environments.listEnvironmentHealth(), (r) => r.environment);
  return environments.filter((env) => env.health !== undefined).flatMap((env) => byEnvironment.get(env.name) ?? []);
}

function buildEnvironmentReach(input: {
  store: System['store'];
  environments: EnvironmentConfig[];
  sheets: readonly RemoteSheetView[];
  plans: Plan[];
  parts: PlanPart[];
  arrivals: GoalArrival[];
  nodes: WorkNode[];
  delivered: readonly IssueDelivery[];
  shortfalled: ReadonlyMap<string, IssueShortfall>;
}): GoalReachView[] {
  const { store, environments, sheets, plans, parts, arrivals, nodes } = input;
  const releases = store.environments.listEnvironmentGateReleases();
  const released = new Map(releases.map((r) => [r.goalRef, r]));
  const holds = new Map<string, string>();
  const gated = new Set<string>();
  for (const { originRef: goalRef } of input.delivered) {
    if (input.shortfalled.has(goalRef)) continue;
    const hold = environmentGateHold({ goalRef, environments, arrivals, releases });
    if (hold !== null) holds.set(goalRef, hold);
    if (hold !== null || released.has(goalRef)) gated.add(goalRef);
  }
  const sheetByGoalEnvironment = new Map<string, RemoteSheetView>();
  for (const sheet of sheets) {
    const key = `${sheet.goalRef} ${sheet.environment}`;
    if (!sheetByGoalEnvironment.has(key)) sheetByGoalEnvironment.set(key, sheet);
  }
  return allGoalReach({
    held: gated,
    landings: store.environments.listGoalLandings(),
    readings: store.environments.listEnvironmentReach(),
    nodes,
    landed: store.environments.landedPrs(),
    plans,
    parts,
    environments,
  }).map((goal) => ({
    ...goal,
    // Folded here rather than in the cockpit, off the same rows the sheet card draws.
    // → 36-remote-validation.md#the-cockpit
    environments: goal.environments.map((env) => ({
      ...env,
      sheet: sheetFold(sheetByGoalEnvironment.get(`${goal.goalRef} ${env.environment}`)),
    })),
    gateHold: holds.get(goal.goalRef) ?? null,
    released: released.get(goal.goalRef) ?? null,
  }));
}

function sheetFold(sheet: RemoteSheetView | undefined): string | null {
  if (sheet === undefined) return null;
  return sheetFoldLine(
    sheet.rows.map((row) => ({ blockedReason: row.blockedReason, outcome: row.reading?.outcome ?? null })),
  );
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const held = grouped.get(key(row));
    if (held) held.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

function buildGoalWatchWindows(
  store: System['store'],
  environments: EnvironmentConfig[],
  readGoalWatches: () => GoalWatch[],
): GoalWatchView[] {
  if (!environments.some((e) => e.watch !== undefined)) return [];
  const windows = store.watches.listWatchWindows();
  if (windows.length === 0) return [];
  const newest = new Map<string, WatchReading>();
  for (const r of store.watches.listWatchReadings()) newest.set(`${r.goalRef} ${r.environment} ${r.checkId}`, r);
  const checksByGoal = groupBy(readGoalWatches(), (c) => c.originRef);
  return windows.map((window) => ({
    ...window,
    checks: (checksByGoal.get(window.goalRef) ?? []).map((c) => ({
      checkId: c.id,
      title: c.title,
      kind: c.kind,
      tolerate: c.tolerate,
      expectUnder: c.expectUnder,
      expectOver: c.expectOver,
      expectBaseline: c.expectBaseline,
      unit: c.unit,
      baselineValue: c.baselineValue,
      reading: newest.get(`${window.goalRef} ${window.environment} ${c.id}`) ?? null,
    })),
  }));
}

/**
 * The sheets an arrival assembled, with the latest reading on every row folded in here rather than
 * in the cockpit — a cockpit that worked an outcome out for itself would be a second opinion drawn
 * beside the reading it describes. Absent entirely where no environment declares a `validate` block:
 * a card of question marks on a deployment that configured nothing reads as broken.
 */
function buildRemoteSheets(
  store: System['store'],
  environments: EnvironmentConfig[],
  tasks: readonly TaskSummary[],
): RemoteSheetView[] {
  if (!environments.some((e) => e.validate !== undefined)) return [];
  const sheets = store.remoteValidation.listRemoteSheets();
  if (sheets.length === 0) return [];
  const runs = store.remoteValidation.listRemoteRuns();
  // The way from a reading to the transcript of the agent that produced it, walked here: a reading
  // carries the run it came through, a run carries the task it was dispatched as, and a task carries
  // the agent. The tasks are the caller's own list rather than a lookup per reading — one statement a
  // snapshot already ran. → docs/spec/36-remote-validation.md#the-reading-an-agent-produced
  const taskOfRun = new Map(runs.map((run) => [run.id, run.taskId]));
  const agentOfTask = new Map(tasks.map((task) => [task.id, task.agentId]));
  const newest = new Map<string, RemoteReadingView>();
  for (const r of store.remoteValidation.listRemoteReadings()) {
    const taskId = r.runId === null ? null : (taskOfRun.get(r.runId) ?? null);
    newest.set(`${r.goalRef} ${r.environment} ${r.rowId}`, {
      ...r,
      taskId,
      agentId: taskId === null ? null : (agentOfTask.get(taskId) ?? null),
    });
  }
  const rowsByGoalEnvironment = groupBy(
    store.remoteValidation.listRemoteSheetRows(),
    (row) => `${row.goalRef} ${row.environment}`,
  );
  const runsByGoalEnvironment = groupBy(runs, (run) => `${run.goalRef} ${run.environment}`);
  const tenants = store.remoteValidation.listRemoteTenants();
  const now = Date.now();
  return sheets.map((sheet) => {
    const key = `${sheet.goalRef} ${sheet.environment}`;
    const environment = environments.find((e) => e.name === sheet.environment);
    const validate = environment?.validate;
    // The `tenantEnv` value is never folded in: the standing carries the *variable's* name, and the
    // value it holds reaches the spawn env and nowhere else. → 36-remote-validation.md#tenants
    const standing =
      environment === undefined
        ? { tenant: null, reseededAt: null, ageMs: null, freshnessMs: null, stale: false, blockedReason: null }
        : resolveTenant({ environment, stamped: tenants, now }).standing;
    return {
      ...sheet,
      rows: (rowsByGoalEnvironment.get(key) ?? []).map((row) => ({
        ...row,
        reading: newest.get(`${row.goalRef} ${row.environment} ${row.rowId}`) ?? null,
      })),
      run: runsByGoalEnvironment.get(key)?.at(-1) ?? null,
      tenant: {
        ...standing,
        reseedable: validate?.reseed !== undefined || validate?.ensureTenant !== undefined,
      },
    };
  });
}

function localRunView(
  run: LocalRun | null,
  runner: { phase(): string | null; turn(): LocalRunTurn | null; holdsSession(): boolean },
  readings: LocalRunReadings,
  facts: (ref: string, origin: string) => LocalRunRefFacts,
): LocalRunView | null {
  if (run === null) return null;
  const live = localRunIsLive(run);
  return {
    ...run,
    live,
    phase: runner.phase(),
    turn: runner.turn(),
    holdsSession: runner.holdsSession(),
    ports: live ? readings.ports : null,
    freshness: live ? readings.freshness : null,
    refFacts: facts(run.ref, run.originRef),
  };
}

function localRunRefFacts(
  ref: string,
  parts: readonly PlanPart[],
  ctx: { prByBranch: Map<string, PullRequest>; tasks: readonly TaskSummary[]; defaultBranch: string },
): LocalRunRefFacts {
  const part = parts.find((p) => p.branch === ref) ?? null;
  const pr = ctx.prByBranch.get(ref) ?? null;
  const onBranch = ctx.tasks.filter((t) => t.branch === ref);
  return {
    ref,
    isDefaultBranch: ref === ctx.defaultBranch,
    part:
      part === null
        ? null
        : { slug: part.slug, title: part.title, seq: part.seq, total: parts.length, status: part.status },
    pr:
      pr === null
        ? null
        : {
            number: pr.number,
            state: prState(pr),
            ciStatus: pr.ciStatus,
            failing: [...(pr.ciVerdict?.dispatch ?? []), ...(pr.ciVerdict?.escalate ?? [])].map((c) => c.name),
            approved: pr.approved === true,
            unresolved: pr.unresolvedComments.length,
          },
    mergedParts: parts.filter((p) => p.status === 'merged').length,
    agentOnIt: onBranch.some((t) => isActiveTask(t)),
    lastActivityAt: onBranch.reduce<string | null>(
      (newest, t) => (newest === null || t.updatedAt > newest ? t.updatedAt : newest),
      null,
    ),
  };
}

function localRunTargetViews(ctx: {
  issues: readonly Issue[];
  partsOf: (origin: string) => PlanPart[];
  prByBranch: Map<string, PullRequest>;
  openPrs: PullRequest[];
  tasks: readonly TaskSummary[];
  defaultBranch: string;
}): LocalRunTargetView[] {
  return ctx.issues.map((issue) => {
    const origin = issueConclusionOrigin(issue.number);
    const parts = ctx.partsOf(origin);
    const choices = localRunChoices(parts, openPrForIssue(issue, ctx.openPrs)?.branch ?? null);
    const facts = (ref: string): LocalRunRefFacts => localRunRefFacts(ref, parts, ctx);
    return {
      originRef: origin,
      issueNumber: issue.number,
      target: facts(choices.target ?? ctx.defaultBranch),
      options: choices.options.map((option) => ({ option, facts: facts(option.ref) })),
      runnable: choices.target !== null,
    };
  });
}

function workItemStateRules(config: Config): CockpitState['config']['stateRules'] {
  const pickup = effectivePickupStates({
    pickupStates: config.issuePickupStates,
    inProgressState: config.issueInProgressState,
  });
  if (pickup === undefined || pickup.length === 0) return null;
  return {
    pickup,
    inProgress: config.issueInProgressState ?? null,
    inReview: config.issueInReviewState ?? null,
    returnsTo: config.issuePickupStates?.[0] ?? null,
  };
}

function localValidationView(
  row: LocalValidation | undefined,
  live: LocalRun | null,
  store: Store,
  signer?: (id: string, name: string) => string,
): LocalValidationView | null {
  if (row === undefined) return null;
  const agentOf = (taskId: string | null): LocalValidationAgentView | null => {
    if (taskId === null) return null;
    const task = store.tasks.getTask(taskId);
    if (!task?.agentId) return null;
    const agent = store.agents.getAgent(task.agentId);
    return agent ? { id: agent.id, status: agent.status } : null;
  };
  return {
    ...row,
    phase: localValidationPhase(row, live),
    files: row.screenshots.map((name: string) => {
      const base = `/local-validations/${encodeURIComponent(row.id)}/files/${encodeURIComponent(name)}`;
      return { name, url: signer ? `${base}?tk=${encodeURIComponent(signer(row.id, name))}` : base };
    }),
    agent: agentOf(row.taskId),
    fixAgent: agentOf(row.fixTaskId),
  };
}

/**
 * Where a capture can be looked at. Null is a check with none — and a check that has one on a
 * deployment with no artifact key gets the bare path, exactly as a local run's screenshot does.
 */
function captureUrl(
  check: { originRef: string; id: string; capture: string | null },
  signer?: (originRef: string, checkId: string) => string,
): string | null {
  if (check.capture === null) return null;
  const base = `/validation-captures/${encodeURIComponent(check.originRef)}/${encodeURIComponent(check.id)}`;
  return signer ? `${base}?tk=${encodeURIComponent(signer(check.originRef, check.id))}` : base;
}

function localValidationPhase(row: LocalValidation, live: LocalRun | null): LocalValidationPhase | null {
  if (row.status === 'pending') return 'queued';
  if (row.status !== 'dispatched') return null;
  if (row.plan === null) return 'planning';
  return live?.status === 'running' ? 'driving' : 'environment';
}
