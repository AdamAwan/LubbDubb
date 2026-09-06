import { existsSync } from 'node:fs';
import type { System } from '../system.js';
import type { Config } from '../config.js';
import type {
  EnvironmentHealthReading,
  Issue,
  IssueAppraisal,
  IssueDelivery,
  IssueInstruction,
  LocalRun,
  LocalValidation,
  LocalRunReadings,
  LocalRunTurn,
  PlanPart,
  Retrospective,
  ScratchPadSummary,
  TaskSummary,
  WatchReading,
  WorldSnapshot,
} from '../types.js';
import type { StateSection } from '../wire.js';
import type { Store } from '../store/store.js';
import type {
  CockpitState,
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
  PullRequest,
  ValidationResourceView,
} from '../wire.js';
import { buildRefUrls, decisionSubjectRef, issueCommentRef } from './refUrls.js';
import { fleetHistory } from './fleetHistory.js';
import { placementAsks, truncateAreaPaths, type AreaPathTree, type PlacementTypePolicy } from '../intake/placement.js';
import { buildStacks } from '../stacks/stack.js';
import { landedCount, landingFor, landingReadiness } from '../stacks/landing.js';
import { prHealth, prState } from '../prHealth.js';
import { applyThreadReopens } from '../prThreads.js';
import { prAttentionStatus, type PrAttentionContext } from '../prAttention.js';
import { reviewReading } from '../review/prReview.js';
import { prReviewState } from '../review/prReviewState.js';
import { packStandingOf } from '../reviewPacks/standing.js';
import {
  effectivePickupStates,
  issuePickupStatus,
  openPrForIssue,
  type IssuePickupContext,
} from '../dispatcher/issuePickup.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { rollUpIssueSpend } from '../issueSpend.js';
import { tallyRunOutcomes } from '../reliabilityInsights.js';
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

/**
 * The section names, as a value. Kept here (not beside the type in `src/wire.ts`,
 * which carries no runtime) because the cockpit type-imports that file.
 */
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

/** A read deferred until asked for, and memoized once taken, so an unused section is free. */
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
  /** Mints the capability in each screenshot URL — see `localValidationFileSignerFor`. */
  localValidationFileSigner?: (id: string, name: string) => string;
}

/**
 * The world the cockpit draws: the baseline the last pulse persisted, never a
 * fresh provider fetch — reading the provider on every cockpit poll would make
 * the request rate a function of agent tool-call volume, so the pulse is the
 * only provider reader and this is its record. The baseline is written before
 * the dispatch world is filtered, so an `-ignore`d PR still shows here with its
 * health, and it is a pulse old (`worldObservedAt` says so). A missing baseline
 * (before the first cycle) ships an empty world rather than falling back to a
 * live fetch — that fallback fans out and retries forever on exactly the boot
 * that is already failing.
 */
export function buildStateSnapshot(system: System, opts?: SnapshotOpts): CockpitState {
  // The cast is sound because `ALL_SECTIONS` is the partition the structural test holds.
  return buildStateSections(system, ALL_SECTIONS, opts) as CockpitState;
}

/**
 * The same build, narrowed to the sections a caller asked for — most `dirty`
 * signals touch none of the expensive goal enrichment, so the socket names the
 * sections a signal touched and the browser merges the patch over what it holds.
 * → `docs/spec/16-http-api.md#sections`
 */
export function buildStateSections(
  system: System,
  want: ReadonlySet<StateSection>,
  opts?: SnapshotOpts,
): Partial<CockpitState> {
  const { store, connector, config, runtimeControl, harness, recovery, updates, readying, agents: fleet } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);
  // The stored reading with reopened review threads folded over it (not
  // persisted into the baseline, so the provider's own record stays intact),
  // applied on every build so a reopen shows before the next pulse.
  // → `docs/spec/07-pull-requests.md#reopening-a-thread`
  const stored = store.getWorldBaseline();
  const baseline = stored === null ? null : applyThreadReopens(stored, store.prThreadReopens());
  const world: WorldSnapshot = baseline ?? {
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
  };
  // Closed PRs kept past the world's own window, shared by the closed-rows list and the ref map.
  const archivedPullRequests = store.listArchivedPrs();
  const tasks = store.listTasks();
  // Read once, shared by the fleet list, the overlap join, and the spend roll-up.
  const agents = store.listAgents();
  const history = once(() => fleetHistory(agents, tasks));
  const control = runtimeControl.snapshot();
  const flags = store.listAllFlags();
  const attachments = store.listAllAttachments();
  const humanTasks = store.listHumanTasks();
  // Every row, capless — the runway band asks the debt count and whether a `supply` notice stands.
  const allHumanTasks = store.listAllHumanTasks();
  const proposals = store.listProposals();
  const bugFilings = store.listBugFilings();
  // Only the newest `OVERLAP_AGENT_WINDOW` agents' files — only concurrent agents can overlap.
  const overlapAgents = agents.slice(0, OVERLAP_AGENT_WINDOW);
  const overlaps = once(() =>
    detectFileOverlaps({
      files: store.listFilesForAgents(overlapAgents.map((a) => a.id)),
      agents: overlapAgents,
      tasks,
    }),
  );
  const plans = store.listPlans();
  const planParts = store.listAllPlanParts();
  const stacks = buildStacks(world.pullRequests, plans, planParts, config.defaultBranch);
  // Open, not merely present: a chain that has shrunk by merging would lose its own landing.
  const openPrNumbers = new Set(world.pullRequests.filter((p) => !p.merged).map((p) => p.number));
  const mergedPrs = store.mergedPrs();
  // Standing and stopped: a stopped intent is the state that most needs to keep showing.
  const landings = store.listStackLandings().filter((l) => l.status === 'standing' || l.status === 'stopped');
  const planPartsOf = (origin: string): PlanPart[] => {
    const plan = plans.find((p) => p.originRef === origin);
    return plan ? planParts.filter((p) => p.planId === plan.id) : [];
  };
  // The plan reconciler's status comment is stored as a provider comment id; `issueCommentRef`
  // pairs it with the issue it lives on so the cockpit gets a resolvable ref.
  const wirePlans = plans.map((p) => ({ ...p, statusCommentRef: issueCommentRef(p.originRef, p.statusCommentRef) }));
  // Acceptance checklist and scope drift, folded per part here rather than in the browser.
  // Drift reads its own file rows and never the overlap detector's window above: a plan is judged
  // against the agents that worked its own parts, which can be far outside that window.
  const partOrigins = new Set(
    plans.flatMap((plan) => {
      const issueNumber = planIssueNumber(plan.originRef);
      if (issueNumber === null) return [];
      return planParts.filter((p) => p.planId === plan.id).map((p) => partOrigin(issueNumber, p.slug));
    }),
  );
  const driftFiles = store.listFilesForAgents([
    ...new Set(
      tasks.flatMap((t) =>
        t.originRef !== null && partOrigins.has(t.originRef) && t.agentId !== null ? [t.agentId] : [],
      ),
    ),
  ]);
  const drift = new Map<string, string[]>();
  for (const plan of plans) {
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    for (const d of planScopeDrift(
      issueNumber,
      planParts.filter((p) => p.planId === plan.id),
      tasks,
      driftFiles,
    )) {
      drift.set(d.partId, d.paths);
    }
  }
  // Indexed per plan: one index across every plan would let same-named slugs collide.
  const partIndexes = new Map(plans.map((plan) => [plan.id, bySlug(planParts.filter((p) => p.planId === plan.id))]));
  const wirePlanParts: PlanPartView[] = planParts.map((part) => ({
    ...part,
    depth: partDepth(part, partIndexes.get(part.planId) ?? bySlug([part])),
    acceptanceCriteria: acceptanceCriteria(part),
    outsideScope: drift.get(part.id) ?? [],
  }));
  // Read through `withLiveClaim`, never off the row: a claim past its expiry holds nothing.
  const claimNow = new Date().toISOString();
  const validationChecks = store
    .listAllValidationChecks()
    .map((check) => withLiveClaim(check, claimNow, config.validation.desktopClaimMinutes));
  const checksByGoal = new Map<string, typeof validationChecks>();
  for (const check of validationChecks) {
    const list = checksByGoal.get(check.originRef);
    if (list) list.push(check);
    else checksByGoal.set(check.originRef, [check]);
  }
  const wireValidationResources: ValidationResourceView[] = store.listAllValidationResources().map((resource) => {
    const path = validationResourcePath(config.validationRoot, resource.originRef, resource.name);
    return { ...resource, path, present: existsSync(path) };
  });
  // Standing "is this issue finished" verdicts — the same rows rule `work-item-back-to-pickup` reads.
  const conclusions = new Map(store.listIssueConclusions().map((c) => [c.originRef, c]));
  const deliveries = store.listDeliveries();
  const deliveriesByOrigin = new Map(deliveries.map((d) => [d.originRef, d]));
  const deliveryWindow = deliverySignalQuery(deliveries);
  // The harness's runs at each goal — living until the operator dismisses them, so a goal can be
  // drawn (and acted on) after the tracker has forgotten the issue; see the retained list below.
  const issueRuns = store.listIssueRuns();
  const runByOrigin = new Map(issueRuns.map((r) => [r.originRef, r]));
  // The negative mirror — the rows rule `issue-shortfall` reads.
  const shortfalls = store.listShortfalls();
  const shortfallsByOrigin = new Map(shortfalls.map((s) => [s.originRef, s]));
  const padsByOrigin = new Map(store.listScratchPadSummaries().map((p) => [p.padRef, p]));
  const instructionsByOrigin = new Map<string, IssueInstruction[]>();
  for (const instruction of store.listAllStandingInstructions()) {
    const held = instructionsByOrigin.get(instruction.originRef);
    if (held) held.push(instruction);
    else instructionsByOrigin.set(instruction.originRef, [instruction]);
  }
  const appraisals = store.listAppraisals();
  const appraisalsByOrigin = new Map(appraisals.map((a) => [a.originRef, a]));
  // The same inputs rule `issue-pickup` consults, so the per-issue verdict below predicts what
  // actually happens next cycle.
  const pickupCtx: IssuePickupContext = {
    policy: system.issuePickup,
    cooldown: DEFAULT_COOLDOWN,
    now: world.takenAt,
    tasks,
    recentDecisions: store.listDecisions(200),
    // Unfiltered on purpose: an `-ignore` tagged PR is hidden from dispatch but still parks its issue.
    openPrs: world.pullRequests,
    plans,
    planParts,
    // Read the same way `Harness.runCycle` reads it — null (no read) until an issue has been assessed.
    deliveries,
    deliverySignals: deliveryWindow ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs) : [],
    appraisals,
    obstacleBlocks: store.listObstacleBlocks(),
    obstacles: store.obstacleBoard(),
    // So a closed ticket whose run still lives reads `retained` rather than `done`.
    runs: issueRuns,
    headroom: control.paused ? 0 : Math.max(0, control.cap - store.countLiveAgents()),
    paused: control.paused,
  };
  // Every reading of the fleet review, gathered once so the attention lens and `reviewStateOf`
  // cannot disagree across a pulse landing between two reads.
  const reviewRows = {
    prReviews: new Map(store.listPrReviews().map((review) => [review.prNumber, review])),
    prReviewRoutes: new Map(store.listPrReviewRoutes().map((route) => [route.prNumber, route])),
    prReviewedElsewhere: store.prsReviewedElsewhere(),
  };
  const signals = rejectionSignalQuery(proposals);
  const attentionCtx: PrAttentionContext = {
    // Unfiltered, as `inheritedCiFailure`/`basePrOf` need it: an unwatched base still attributes.
    openPrs: world.pullRequests,
    defaultBranch: config.defaultBranch,
    watchLabel,
    tasks,
    proposals,
    rejectionSignals: signals ? store.listWorldEventsSince(signals.since, signals.refs) : [],
    recentDecisions: pickupCtx.recentDecisions,
    cooldown: DEFAULT_COOLDOWN,
    ci: config.ci,
    now: world.takenAt,
    reviewWaits: store.reviewWaits(),
    review: config.review,
    ...reviewRows,
  };
  const worldEvents = store.listWorldEvents(100);
  const shiftLog = store.listDecisions(100).map((d) => ({ ...d, subjectRef: decisionSubjectRef(d.action) }));
  // The provider builds every URL (see CompositeConnector.resolveRefUrl); the cockpit only
  // looks refs up here, so it stays provider-agnostic.
  const refUrls = buildRefUrls({
    pullRequests: [...world.pullRequests, ...(world.closedPullRequests ?? []), ...archivedPullRequests],
    issues: world.issues,
    taskBranches: tasks.map((t) => t.branch),
    // A filed ticket is usually not in the world lists the `#n` keys are built from, so it needs
    // resolving by its canonical ref or the chip that just created it links nowhere.
    refs: [
      ...bugFilings.map((b) => b.originRef),
      ...bugFilings.map((b) => b.ticketRef),
      ...humanTasks.map((t) => t.originRef),
      ...proposals.map((p) => p.ref),
      ...wirePlans.map((p) => p.statusCommentRef),
      ...appraisals.map((a) => issueCommentRef(a.originRef, a.commentRef)),
      ...worldEvents.map((e) => e.ref),
      ...tasks.map((t) => t.originRef),
      ...world.issues.map((i) => `issue:${i.number}`),
      ...issueRuns.map((r) => r.originRef),
      ...shiftLog.map((d) => d.subjectRef),
    ],
    resolve: (ref) => connector.resolveRefUrl(ref),
  });
  // What every goal has cost, including local runs billed to the same account. Read off the
  // work graph rather than the world, so a goal's total never falls when a PR ages out.
  const spend = once(() =>
    rollUpIssueSpend({
      agents,
      tasks,
      nodes: store.listWorkNodes(),
      localRuns: store.listLocalRuns(),
    }),
  );
  const goalPriorities = new Map(store.listGoalPriorities().map((g) => [g.originRef, { since: g.since }]));
  const localValidations = once(() => new Map(store.listLatestLocalValidations().map((v) => [v.originRef, v])));
  const liveLocalRun = once(() => store.liveLocalRun());
  const validationChecksFor = (origin: string): ReturnType<typeof validationVerdict> | null => {
    const checks = checksByGoal.get(origin) ?? [];
    return checks.length === 0 ? null : validationVerdict(checks);
  };
  const placementCtx: PlacementContext = {
    areaTree: system.areaPaths.current(),
    canPlace: connector.canPlaceWorkItem(),
    types: { containerTypes: config.issueContainerTypes, parentedTypes: config.issueParentedTypes },
  };
  /**
   * The retained runs, each marked `stale` (`wire.Issue.stale`) — the field a live issue never
   * carries. A goal whose ticket left the open set is not removed from the cockpit; only the
   * tracker's copy is stale, and the mark says when the harness last saw the item live.
   */
  const retainedRuns = () => {
    const retained = retainedRunIssues(issueRuns, world.issues);
    const mirrored = new Map(store.readTrackerItems(retained.map((i) => i.number)).map((t) => [t.number, t]));
    return retained.flatMap((issue) => {
      // Every stub above was rebuilt from a run row, so this cannot miss; the guard is for the type.
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
      pickup: issuePickupStatus(issue, pickupCtx),
      // Sits beside `pickup`, does not feed it: pickup asks "would an agent start next cycle",
      // conclusion asks "has anyone said this is finished".
      conclusion: resolveIssueConclusion(
        conclusions.get(origin) ?? null,
        plans.find((p) => p.originRef === origin) ?? null,
        planPartsOf(origin),
        shortfallsByOrigin.get(origin) ?? null,
      ),
      shortfall: shortfallsByOrigin.get(origin) ?? null,
      // The positive mirror — present only while it still stands (`standingDelivery`).
      delivery: standingDelivery(deliveriesByOrigin.get(origin), issue, pickupCtx),
      appraisal: appraisalVerdictOf(appraisalsByOrigin.get(origin), issue, placementCtx),
      // Read off the same pure function the dispatcher resolves the pin with, so the chip and the
      // dispatch can never disagree about which profile is standing.
      modelPin: (({ profile, ignored }) => ({ profile, ignoredTags: ignored }))(
        resolveModelTag(issue.labels, config.labelPrefix, config.agentModels),
      ),
      priority: goalPriorities.get(origin) ?? null,
      retrospective: retroReading(store.getRetrospective(origin)),
      scratchpad: padReading(padsByOrigin.get(origin)),
      instructions: instructionsByOrigin.get(origin) ?? [],
      // Absent when the harness has never had work under the goal, so the floor reads four states
      // — untouched, running, finished, dismissed — off one optional field.
      run: run
        ? {
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            outcome: run.outcome,
            dismissed: run.dismissedAt !== null,
          }
        : undefined,
      // Null is "no runtime ever reported usage for this goal" (the normal case in PTY mode), not
      // zero — the cockpit draws nothing rather than "$0.00".
      spend: spend().byIssue.get(origin) ?? null,
      // Null is "no checks", a third reading distinct from clear.
      validation: validationChecksFor(origin),
      localValidation: localValidationView(
        localValidations().get(origin),
        liveLocalRun(),
        system.store,
        opts?.localValidationFileSigner,
      ),
    };
  };
  /**
   * Where a pull request stands with the fleet's reviewer, off the same four rows the attention
   * lens reads. Undefined where review is off, which draws no mark.
   */
  const reviewStateOf = (pr: PullRequest): PullRequest['review'] =>
    prReviewState(pr.number, reviewReading(reviewRows, pr.number), config.review, pr.reviewThreads) ?? undefined;
  /** The one enrichment a merged pull request still gets: what was already read on it. */
  const withReview = <T extends PullRequest>(pr: T): T => ({ ...pr, review: reviewStateOf(pr) });
  /** Review packs, read once as three columns rather than per row. */
  const packHeads = once(() => new Map(store.listReviewPackHeads().map((head) => [head.prNumber, head])));
  /** Whether a pull request has a pack, and whether it is about the head. Undefined draws no mark. */
  const packStandingFor = (pr: PullRequest): PullRequest['pack'] =>
    packStandingOf(packHeads().get(pr.number), pr.headSha, system.reviewPacks.writing(pr.number));

  // The open pull requests with their verdicts folded — hoisted because the local-run rows below
  // read the same rows, and `ciVerdict` in particular must not be classified twice.
  const openPullRequests = once((): OpenPullRequest[] =>
    world.pullRequests.map((pr) => ({
      ...pr,
      health: prHealth(pr, world.pullRequests),
      // Separate from `health`: "can this merge" and "whose turn is it" have different right
      // answers for the same PR (see `src/prAttention.ts`).
      attention: prAttentionStatus(pr, attentionCtx),
      ciVerdict: classifyCiFailures(pr.ciChecks, config.ci, pr.ciChecksWithheld),
      review: reviewStateOf(pr),
      pack: packStandingFor(pr),
    })),
  );
  // Branch → PR, open rows first so a reopened branch reads as open. The local-run rows look
  // themselves up here by branch, specifically so a goal's other PRs cannot be presented as
  // facts about the ref being run.
  const prByBranch = once(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of [...(world.closedPullRequests ?? []), ...openPullRequests()]) map.set(pr.branch, pr);
    return map;
  });
  /** What this deployment is, rather than what the fleet is doing. Fixed for the life of the process. */
  const harnessSection = (): Pick<
    CockpitState,
    'config' | 'recovery' | 'build' | 'pets' | 'localRun' | 'localRunTargets' | 'planning' | 'dispatchRules'
  > => ({
    config: {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxConcurrentAgents: config.maxConcurrentAgents,
      watchLabel,
      // Cheapest first — the order every dropdown draws. Empty turns the control off.
      profiles: orderedProfiles(config.agentModels),
      defaultProfile: config.agentModels?.default ?? null,
      desktopFolder: config.repoRoot,
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
    // A non-empty list means the harness is running no cycles — drawn as a blocking banner.
    recovery: recovery.pending(),
    // Served from the desk's last reading; a git round trip on every snapshot build would
    // put the network in front of the whole UI.
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

  /**
   * The live dispatch controls. Its own section because `control:changed` carries `cap` and
   * `paused` whole and the browser applies it without a request — this section exists only for
   * first load and a client that missed a frame.
   */
  const controlSection = (): Pick<CockpitState, 'control'> => ({
    control,
  });

  /**
   * The world as the cockpit draws it — every goal with its verdicts folded, the chains, and
   * where landed work has reached. The expensive section: per-goal and per-PR verdicts run here,
   * and it is the section a fleet event never touches.
   */
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
    | 'stackLandings'
  > => ({
    // Null before the first cycle; the reading is a pulse old (see this function's contract).
    worldObservedAt: baseline?.takenAt ?? null,
    world: {
      ...world,
      // Passed whole as stack context so an inherited CI failure names the PR underneath.
      pullRequests: openPullRequests(),
      closedPullRequests: world.closedPullRequests?.map(withReview),
      // See `enrichIssue`: conclusion answers "has anyone said this is finished", which the
      // operator toggles independently of the pickup verdict.
      issues: world.issues.map(enrichIssue),
      // The same `candidateParents` an agent's orphan note is written from, so the fleet's
      // suggestion and the operator's picker agree.
      parentCandidates: candidateParents(world.issues, config.issueContainerTypes),
    },
    // Runs whose issue the tracker no longer returns — rebuilt from the same
    // `retainedRunIssues` the dispatcher unions in, enriched through the same path as a live issue.
    retainedRuns: retainedRuns(),
    archivedPullRequests: archivedPullRequests.map(withReview),
    // Derived from the world rather than stored, so a chain opened by hand draws like one a plan produced.
    stacks,
    environmentReach: buildEnvironmentReach(store, config.environments),
    featureSequences: store.listFeatureSequences(),
    environmentHealth: buildEnvironmentHealth(store, config.environments),
    goalWatchWindows: buildGoalWatchWindows(store, config.environments),
    environmentArrivals: config.environments.length === 0 ? [] : store.listGoalArrivals().slice(0, 50),
    // The "land the stack" control, one entry per chain: joined by rung membership rather than
    // by ref, since the open set is needed to tell one path of a fork from its sibling.
    stackLandings: [
      ...stacks.map((stack) => {
        const rungPrs = stack.rungs.flatMap((rung) => {
          const pr = world.pullRequests.find((p) => p.number === rung.prNumber);
          return pr ? [pr] : [];
        });
        const landing = landingFor(
          stack.rungs.map((r) => r.prNumber),
          landings,
          openPrNumbers,
        );
        return {
          ref: stack.ref,
          ...landingReadiness(rungPrs),
          landing,
          landed: landing ? landedCount(landing, { ...world, merged: mergedPrs }) : 0,
        };
      }),
      // A standing intent whose stack has shrunk to one rung has no chain left to land, but its
      // row must still draw — mapped over `stacks` alone it would be invisible.
      // → `docs/spec/07-pull-requests.md#landing-a-stack`
      ...landings
        .filter(
          (l) => l.status === 'standing' && !stacks.some((s) => s.rungs.some((r) => l.rungs.includes(r.prNumber))),
        )
        .map((landing) => ({
          ref: landing.ref,
          offer: false,
          blockedBy: null,
          landing,
          landed: landedCount(landing, { ...world, merged: mergedPrs }),
        })),
    ],
  });

  /** The plan graph and the validation plan hanging off it. */
  const plansSection = (): Pick<
    CockpitState,
    'plans' | 'planParts' | 'validationChecks' | 'validationResources' | 'goalWatches'
  > => ({
    plans: wirePlans,
    planParts: wirePlanParts,
    validationChecks,
    validationResources: wireValidationResources,
    // Live checks and proposed ones nobody has ruled on — the plan sheet is where the operator
    // accepts or declines. Every other reader goes through `listGoalWatches`, which is live-only.
    goalWatches: [...store.listGoalWatches(), ...store.listProposedGoalWatches()],
  });

  /**
   * The agents, what they were dispatched to do, and what that has cost. The section almost
   * every live signal invalidates; `tasks`/`agents` are bounded (see {@link fleetHistory}) rather
   * than all-time reads. → [16](../../docs/spec/16-http-api.md#bulk-collections)
   */
  const fleetSection = (): Pick<
    CockpitState,
    | 'tasks'
    | 'agents'
    | 'endedAgents'
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
    // The whole count, not the tail, so "N shifts ended" reports the true total.
    endedAgents: history().ended,
    readying: readying.list(),
    parkedOnLimit: fleet.limitedAgentIds(),
    stallParks: fleet.stallDeadlines(),
    flags,
    artifactUrls: artifactUrls(flags, opts?.artifactSigner),
    attachments,
    attachmentUrls: attachmentUrls(attachments, opts?.attachmentSigner),
    // Paths two agents wrote while both were running — the one blind spot the world-driven
    // dispatch gates cannot see (issue #113).
    overlaps: overlaps(),
    usage: buildUsage(system, spend().unattributedCostUsd),
    runOutcomes: tallyRunOutcomes(agents),
  });

  /** What is waiting to be dispatched, and the recurrences behind some of it. */
  const queueSection = (): Pick<CockpitState, 'jobs' | 'schedules' | 'upcoming' | 'runway'> => ({
    jobs: store.listJobs(),
    schedules: store.listJobSchedules(),
    // The "Up next" queue: the last cycle's ordered pickup plan with the headroom cut (issue #69).
    upcoming: harness.upcoming,
    // Recomputed here (not cached off the pulse) because a snapshot is served far more often than
    // a cycle runs; over the same pickup context the desk uses, so band and bench agree.
    runway: readRunway({
      policy: config.runway,
      issues: world.issues,
      pickup: pickupCtx,
      runs: issueRuns,
      // The unbounded list, not the panel's capped feed — a hundred-row cap would misreport debt.
      humanTasks: allHumanTasks,
      escalations: store.listEscalationSpans(),
      cap: control.cap,
      standing: allHumanTasks.some((t) => t.kind === 'supply' && t.status === 'open'),
    }),
  });

  /** Everything still waiting on a person. */
  const inboxSection = (): Pick<CockpitState, 'bugFilings' | 'humanTasks' | 'escalations' | 'proposals'> => ({
    bugFilings,
    humanTasks,
    // Open only — every reader filters to `status === 'open'`; shipping all-time was half a
    // megabyte per refresh spent on rows filtered straight back out.
    escalations: store.listOpenEscalations(),
    proposals,
  });

  /** What has happened: the world's own changes, the harness's decisions, and its recorded failures. */
  const activitySection = (): Pick<CockpitState, 'decisions' | 'worldEvents' | 'errors'> => ({
    decisions: shiftLog,
    worldEvents,
    errors: store.listErrors(100),
  });

  // Assembled section by section, so a caller that asked for one pays for one.
  const out: Partial<CockpitState> = {
    // Always shipped: the map every other section resolves its refs in.
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

/** Build the `flag id → artifact URL` map the cockpit opens chips from. */
function artifactUrls(
  flags: { id: string; ref: string }[],
  signer?: (flagId: string) => string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const flag of flags) {
    // http(s) refs are linked directly by the cockpit and never served here.
    if (/^https?:\/\//i.test(flag.ref)) continue;
    const base = `/artifacts/${encodeURIComponent(flag.id)}`;
    map[flag.id] = signer ? `${base}?tk=${encodeURIComponent(signer(flag.id))}` : base;
  }
  return map;
}

/**
 * Build the `attachment id → URL` map. Unlike `artifactUrls` nothing is skipped: every
 * attachment is a local file this harness wrote.
 */
function attachmentUrls(attachments: { id: string }[], signer?: (id: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attachment of attachments) {
    const base = `/attachments/${encodeURIComponent(attachment.id)}`;
    map[attachment.id] = signer ? `${base}?tk=${encodeURIComponent(signer(attachment.id))}` : base;
  }
  return map;
}

/**
 * A delivery verdict, shipped only while it still stands. `deliveryHold` answers null for a
 * verdict the world has overtaken, so a released verdict going null means the issue is back in
 * play. The hold reason is deliberately not shipped — it duplicates `pickup.reasons`.
 */
function standingDelivery(delivery: IssueDelivery | undefined, issue: Issue, ctx: IssuePickupContext) {
  if (!delivery) return null;
  const held = deliveryHold(delivery, issue, { pickupStates: ctx.policy.pickupStates, signals: ctx.deliverySignals });
  if (!held) return null;
  const { summary, by, decidedAt } = delivery;
  return { summary, by, decidedAt };
}

/** What the Goal Floor's Manifest station needs: whether a goal was written up, its summary line, and when. */
function retroReading(retro: Retrospective | null) {
  return retro ? { summary: retro.summary, hasDocument: retro.document.length > 0, updatedAt: retro.updatedAt } : null;
}

/** The count and age of a shared pad, never the trail. Null (not zero) when nothing has been written. */
function padReading(pad: ScratchPadSummary | undefined) {
  return pad && pad.entries > 0 ? { entries: pad.entries, updatedAt: pad.updatedAt } : null;
}

/**
 * The reviewable half of a stored appraisal, or null when nobody has judged the goal. Null,
 * `workable`, and `unclear` are three distinct readings — collapsing them loses the refused
 * verdict back into prose buried in `pickup.reasons`. `commentRef` is the standing comment the
 * desk keeps on the ticket; `goalRef` is a fingerprint the hold is measured against, not a reading.
 */
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
    // Derived every time against the live work item; gated on the sink being able to write a
    // placement at all, so the operator is never shown a control that would 400.
    placement: placement.canPlace
      ? placementAsks(appraisal, issue, placement.areaTree, appraisal.goalRef, placement.types)
      : [],
    // Not gated on `canPlace`: this is a stamp of something already done, not a question being asked.
    parentSettledAt: appraisal.parentSettledAt,
  };
}

/**
 * What the placement questions are judged against: the project's area tree, and whether anything
 * can write a placement. Resolved once per snapshot rather than per issue.
 */
interface PlacementContext {
  areaTree: AreaPathTree | null;
  canPlace: boolean;
  /** The operator's `issueContainerTypes` / `issueParentedTypes`, carried whole for `isOrphanIssue`. */
  types: PlacementTypePolicy;
}

/**
 * Account-level Claude usage (issue #60): rolling cost windows summed from stream-mode turn
 * reports, plus real subscriber 5h/weekly limits when a reading has been seen. Nothing in the
 * cockpit draws either yet — shipped anyway because the reading is turn-bound and only exists
 * while agents run. `unattributedCostUsd` is the spend that reached no goal, shipped so the
 * per-issue totals read as a partition of the fleet's spend.
 */
function buildUsage(system: System, unattributedCostUsd: number) {
  const now = Date.now();
  const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return {
    windows: {
      fiveHourCostUsd: system.store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
      sevenDayCostUsd: system.store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
    },
    rateLimits: system.store.readRateLimits(),
    unattributedCostUsd,
  };
}

/**
 * What each environment's own health check last said, in the operator's order. The
 * configuration decides the set; the store only fills it in, so a removed/renamed `health`
 * check drops out rather than showing its last answer forever.
 */
function buildEnvironmentHealth(store: System['store'], environments: EnvironmentConfig[]): EnvironmentHealthReading[] {
  const readings = store.listEnvironmentHealth();
  return environments
    .filter((env) => env.health !== undefined)
    .flatMap((env) => readings.filter((r) => r.environment === env.name));
}

/**
 * Every goal anything is known about, and where each has got to — from the landings and the
 * work graph, never from the world, since a goal is most interesting to this panel once its
 * ticket has closed. Empty with nothing configured.
 */
function buildEnvironmentReach(store: System['store'], environments: EnvironmentConfig[]): GoalReachView[] {
  if (environments.length === 0) return [];
  const arrivals = store.listGoalArrivals();
  const releases = store.listEnvironmentGateReleases();
  const released = new Map(releases.map((r) => [r.goalRef, r]));
  // A hold only applies to a delivered goal — everything else is simply work in progress.
  const delivered = new Set(store.listDeliveries().map((d) => d.originRef));
  const shortfalls = new Set(store.listShortfalls().map((sf) => sf.originRef));
  // Resolved before the fold because it also widens the fold's goal set — a delivered goal with
  // nothing merged yet still needs a row for its hold sentence and release control.
  const holds = new Map<string, string>();
  const gated = new Set<string>();
  for (const goalRef of delivered) {
    if (shortfalls.has(goalRef)) continue;
    const hold = environmentGateHold({ goalRef, environments, arrivals, releases });
    if (hold !== null) holds.set(goalRef, hold);
    if (hold !== null || released.has(goalRef)) gated.add(goalRef);
  }
  return allGoalReach({
    held: gated,
    landings: store.listGoalLandings(),
    readings: store.listEnvironmentReach(),
    nodes: store.listWorkNodes(),
    landed: store.landedPrs(),
    // The denominator is the goal's whole work, so the first of four parts arriving is not the
    // goal arriving.
    plans: store.listPlans(),
    parts: store.listAllPlanParts(),
    environments,
  }).map((goal) => ({
    ...goal,
    gateHold: holds.get(goal.goalRef) ?? null,
    released: released.get(goal.goalRef) ?? null,
  }));
}

/**
 * Every post-deploy watch, one entry per `(goal, environment)` an arrival opened. Empty when no
 * environment declares a `watch`. Nothing is rolled up to a word — a goal whose one signal
 * passed and whose other regressed needs both shown. → `docs/spec/29-post-deploy-watch.md#the-verdict`
 */
function buildGoalWatchWindows(store: System['store'], environments: EnvironmentConfig[]): GoalWatchView[] {
  if (!environments.some((e) => e.watch !== undefined)) return [];
  const windows = store.listWatchWindows();
  if (windows.length === 0) return [];
  // The newest reading per `(window, check)`; readings are oldest-first.
  const newest = new Map<string, WatchReading>();
  for (const r of store.listWatchReadings()) newest.set(`${r.goalRef} ${r.environment} ${r.checkId}`, r);
  const checks = store.listGoalWatches();
  return windows.map((window) => ({
    ...window,
    checks: checks
      .filter((c) => c.originRef === window.goalRef)
      .map((c) => ({
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
 * The run as the cockpit reads it, or null when nothing has ever started. `live`/`phase` are
 * decided here, beside the writer that sets them. Phase, turn and `holdsSession` come from the
 * runner (not the row) because they describe work in flight; a restart correctly has none.
 * Readings ship only while the run is live.
 */
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

/**
 * What has happened on one branch: the part it belongs to, and the pull request on it. Looked
 * up by branch (never by goal) so a goal's other PRs are never presented as facts about the ref
 * about to be checked out.
 */
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
    // The same rule the dispatcher, the executor and the branch reap read, not a fourth opinion.
    agentOnIt: onBranch.some((t) => isActiveTask(t)),
    lastActivityAt: onBranch.reduce<string | null>(
      (newest, t) => (newest === null || t.updatedAt > newest ? t.updatedAt : newest),
      null,
    ),
  };
}

/**
 * Where the local run could be pointed, one entry per goal. The ref comes from
 * `localRunChoices` — the same function the runner starts from and guards an override with —
 * so what the panel offers and what a start accepts are one decision.
 */
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
      // A goal with no branch of its own resolves to the integration branch like every other such
      // goal, so it is not a choice — the panel's default filter leaves it out.
      runnable: choices.target !== null,
    };
  });
}

/**
 * The state words the work-item rules act on, or null where they are all off. `pickup` is the
 * effective set the dispatcher gates on (folds in `issueInProgressState`); `returnsTo` is the
 * first configured pickup state, matching how `workItemBackToPickup` reads it.
 */
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

/**
 * A goal's latest local validation, as the cockpit draws it, or null. Derived here rather than
 * in the browser because the phase folds three facts, the screenshot URLs need a
 * server-minted capability, and the agents behind it may no longer be in a bounded cockpit list.
 */
function localValidationView(
  row: LocalValidation | undefined,
  live: LocalRun | null,
  store: Store,
  signer?: (id: string, name: string) => string,
): LocalValidationView | null {
  if (row === undefined) return null;
  const agentOf = (taskId: string | null): LocalValidationAgentView | null => {
    if (taskId === null) return null;
    const task = store.getTask(taskId);
    if (!task?.agentId) return null;
    const agent = store.getAgent(task.agentId);
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
 * How far a validation has got, in one answer. Ordered by what it can prove: the plan landing
 * is a fact on the row, so `driving` is claimed only once the environment run is actually
 * `running`. Null once the row is settled.
 */
function localValidationPhase(row: LocalValidation, live: LocalRun | null): LocalValidationPhase | null {
  if (row.status === 'pending') return 'queued';
  if (row.status !== 'dispatched') return null;
  if (row.plan === null) return 'planning';
  return live?.status === 'running' ? 'driving' : 'environment';
}
