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
import { appraisalSignalQuery } from '../intake/appraisal.js';
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
 * The section names, as a value. Here and **not** in `src/wire.ts`, which carries
 * no runtime — anything surviving erasure there becomes server code in the SPA
 * bundle (`test/wireContract.test.ts`). A section missing from this list is caught
 * by `test/stateSections.test.ts`.
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

/**
 * A read deferred until something asks for it, and taken once when it is — so two
 * parts of the UI cannot disagree, and a section nobody asked for pays nothing.
 */
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
 * The world the cockpit draws: the baseline the last pulse persisted, **never
 * a fresh provider fetch** — the pulse stays the only provider reader. The
 * baseline is written *before* the dispatch world is filtered, so it is the
 * **unfiltered** world and an `-ignore`d PR stays visible with its health. A
 * missing baseline (before the first cycle) ships an **empty** world and
 * never falls back to a live fetch.
 */
export function buildStateSnapshot(system: System, opts?: SnapshotOpts): CockpitState {
  // Every section, so the result is the whole `CockpitState`: the cast is sound
  // because `ALL_SECTIONS` is the partition the structural test holds.
  return buildStateSections(system, ALL_SECTIONS, opts) as CockpitState;
}

/**
 * The same build, narrowed to the sections a caller asked for. The socket
 * names the sections a signal touched and the browser merges the patch over
 * the snapshot it holds — so the cockpit's state stays one complete object.
 * → `docs/spec/16-http-api.md#sections`
 */
export function buildStateSections(
  system: System,
  want: ReadonlySet<StateSection>,
  opts?: SnapshotOpts,
): Partial<CockpitState> {
  const { store, connector, config, runtimeControl, harness, recovery, updates, readying, agents: fleet } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);
  // The stored reading with the operator's reopened review threads folded over it —
  // the same fold the harness decides against. Not persisted into the baseline, so
  // the provider's record stays intact, and applied on *every* build so a reopen
  // shows on the next poll rather than the next pulse.
  // → `docs/spec/07-pull-requests.md#reopening-a-thread`
  const stored = store.getWorldBaseline();
  const baseline = stored === null ? null : applyThreadReopens(stored, store.prThreadReopens());
  const world: WorldSnapshot = baseline ?? {
    takenAt: new Date().toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
  };
  // Every pull request the world has ever reported closed, kept past the world
  // list's window (`pr_archive`). Shared by the goal page's closed rows and the ref map.
  const archivedPullRequests = store.listArchivedPrs();
  const tasks = store.listTasks();
  // Read once and shared three ways — fleet list, overlap join, per-goal spend
  // roll-up — so a card's total cannot disagree with the agents printed beside it.
  const agents = store.listAgents();
  // The slice of those two lists the snapshot ships, as a thunk. Taken from the
  // shared reads: a bound applied at the read would quietly turn the Yield gauge and
  // every goal's spend into readings about the last two hundred runs.
  const history = once(() => fleetHistory(agents, tasks));
  const control = runtimeControl.snapshot();
  // Hoisted (not inlined into the returned object) because the artifact-URL map
  // below is derived from the same list.
  const flags = store.listAllFlags();
  // Hoisted for the same reason: the URL map below is derived from the same rows.
  const attachments = store.listAllAttachments();
  // Work only a person can do. Read here so each row's `originRef` feeds the ref map.
  const humanTasks = store.listHumanTasks();
  // Every row, capless: the runway band's questions — debt count, standing `supply`
  // notice — are asked of the whole bench.
  const allHumanTasks = store.listAllHumanTasks();
  // Acts put to a human. A proposal's ref (`pr:42:merge`) feeds the link map below.
  const proposals = store.listProposals();
  // Bugs raised from a story row: once filed, each ref is an item the world lists
  // do not hold yet, so it must be keyed here.
  const bugFilings = store.listBugFilings();
  // The files the newest agents wrote, for the overlap detector below. **A window,
  // not the table**: only concurrent agents can contribute to an overlap, and the
  // per-agent list is `GET /api/agents/:id/files` rather than this payload.
  const overlapAgents = agents.slice(0, OVERLAP_AGENT_WINDOW);
  const overlaps = once(() =>
    detectFileOverlaps({
      files: store.listFilesForAgents(overlapAgents.map((a) => a.id)),
      agents: overlapAgents,
      tasks,
    }),
  );
  // The plan graph, shared by the pickup verdict and the snapshot, so the chip and
  // the panel cannot disagree.
  const plans = store.listPlans();
  const planParts = store.listAllPlanParts();
  const stacks = buildStacks(world.pullRequests, plans, planParts, config.defaultBranch);
  // Open, not merely present: `landingFor` rejects an intent covering an outside rung
  // only while it is still open, or a chain shrunk by merging loses its landing.
  const openPrNumbers = new Set(world.pullRequests.filter((p) => !p.merged).map((p) => p.number));
  // One read of the durable merge record per snapshot rather than one per chain.
  const mergedPrs = store.mergedPrs();
  // Standing *and* stopped: a stopped intent is the one the rack most has to show.
  const landings = store.listStackLandings().filter((l) => l.status === 'standing' || l.status === 'stopped');
  // A plan's parts are its **shape**: "one pull request" is no live parts, not a status.
  const planPartsOf = (origin: string): PlanPart[] => {
    const plan = plans.find((p) => p.originRef === origin);
    return plan ? planParts.filter((p) => p.planId === plan.id) : [];
  };
  // The same rows, translated for the wire (#171). A bare provider comment id
  // resolves to nothing and reads as an *issue number* to `githubRefUrl`, so
  // `issueCommentRef` pairs it with its issue — and the same function feeds the ref
  // map below, so key and lookup cannot disagree.
  const wirePlans = plans.map((p) => ({ ...p, statusCommentRef: issueCommentRef(p.originRef, p.statusCommentRef) }));
  // The two readings a part row cannot carry: the acceptance checklist, and the
  // scope drift, a join across `agent_files` and `tasks` the cockpit does not hold.
  // Drift reads its own file rows and **never the overlap window above** — a plan is
  // judged against the agents that worked its parts, which on a fortnight-old goal
  // are nowhere near the newest rows, so the check would pass for the reason it
  // should have fired.
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
  // Indexed per plan: depth walks *siblings*, and one index across every plan would
  // let two plans sharing a slug resolve each other's dependencies.
  const partIndexes = new Map(plans.map((plan) => [plan.id, bySlug(planParts.filter((p) => p.planId === plan.id))]));
  const wirePlanParts: PlanPartView[] = planParts.map((part) => ({
    ...part,
    depth: partDepth(part, partIndexes.get(part.planId) ?? bySlug([part])),
    acceptanceCriteria: acceptanceCriteria(part),
    outsideScope: drift.get(part.id) ?? [],
  }));
  // The validation plan, grouped by goal so the sheet, chip and flag read one map.
  // Read through `withLiveClaim`, never off the row: the cockpit must stop drawing a
  // claim at the instant it stops blocking `validate-check`.
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
  // Resolved here: the path joins `validationRoot` (config the cockpit lacks), and
  // "is it there" is a filesystem question only this side can answer.
  const wireValidationResources: ValidationResourceView[] = store.listAllValidationResources().map((resource) => {
    const path = validationResourcePath(config.validationRoot, resource.originRef, resource.name);
    return { ...resource, path, present: existsSync(path) };
  });
  // Standing "is this issue finished" verdicts, keyed on the issue origin — the same
  // rows rule `work-item-back-to-pickup` reads.
  const conclusions = new Map(store.listIssueConclusions().map((c) => [c.originRef, c]));
  const deliveries = store.listDeliveries();
  const deliveriesByOrigin = new Map(deliveries.map((d) => [d.originRef, d]));
  const deliveryWindow = deliverySignalQuery(deliveries);
  // The harness's runs at each goal (issues #203, #234). Minted at pickup and living
  // until dismissed, so a goal is drawn and acted on after the tracker forgets it.
  const issueRuns = store.listIssueRuns();
  const runByOrigin = new Map(issueRuns.map((r) => [r.originRef, r]));
  // The negative mirror, keyed the same way — the rows rule `issue-shortfall` reads.
  const shortfalls = store.listShortfalls();
  const shortfallsByOrigin = new Map(shortfalls.map((s) => [s.originRef, s]));
  // What the agents on each goal wrote each other, as a count and an age — one
  // grouped read for the whole world, keyed on the issue origin.
  const padsByOrigin = new Map(store.listScratchPadSummaries().map((p) => [p.padRef, p]));
  // What the operator has asked for on each goal and no agent has concluded yet.
  // One read, grouped here; shipped in full rather than as a count because these are
  // short, few, and the operator's own words.
  const instructionsByOrigin = new Map<string, IssueInstruction[]>();
  for (const instruction of store.listAllStandingInstructions()) {
    const held = instructionsByOrigin.get(instruction.originRef);
    if (held) held.push(instruction);
    else instructionsByOrigin.set(instruction.originRef, [instruction]);
  }
  const appraisals = store.listAppraisals();
  const appraisalWindow = appraisalSignalQuery(appraisals);
  // Keyed like the conclusion and shortfall maps, so the verdict reads one lookup.
  const appraisalsByOrigin = new Map(appraisals.map((a) => [a.originRef, a]));
  // The same inputs rule `issue-pickup` consults, so the verdict below predicts what
  // happens next cycle. The decision window (200) and headroom mirror `Harness.runCycle`.
  const pickupCtx: IssuePickupContext = {
    policy: system.issuePickup,
    cooldown: DEFAULT_COOLDOWN,
    now: world.takenAt,
    tasks,
    recentDecisions: store.listDecisions(200),
    // Unfiltered on purpose: an `-ignore` PR is hidden from dispatch but still parks
    // its issue (see `openPrForIssue`).
    openPrs: world.pullRequests,
    // Same plan inputs rules `issue-plan`/`issue-pickup` read, so the chip explains a
    // funnel park rather than claiming a pickup that will not fire.
    plans,
    planParts,
    // The harness's own park, read as `Harness.runCycle` reads it — the event query is
    // null until an issue has been assessed.
    deliveries,
    deliverySignals: deliveryWindow ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs) : [],
    // The content gate in front of the funnel, read as `Harness.runCycle` reads it, so
    // the chip reports an issue *awaiting* appraisal rather than eligible.
    appraisals,
    appraisalSignals: appraisalWindow ? store.listWorldEventsSince(appraisalWindow.since, appraisalWindow.refs) : [],
    // The third park: a goal concluded `blocked` behind an obstacle that still reaches
    // agents. Read as `Harness.runCycle` reads it.
    obstacleBlocks: store.listObstacleBlocks(),
    obstacles: store.obstacleBoard(),
    // So a closed ticket whose run still lives reads `retained` rather than `done` —
    // the rows the retained list below is built from (issue #234).
    runs: issueRuns,
    headroom: control.paused ? 0 : Math.max(0, control.cap - store.countLiveAgents()),
    paused: control.paused,
  };
  // The PR-side sibling: whose turn each PR is on, off the same predicates the rules
  // ask. The fleet-review rows are gathered once — the attention lens asks whether a
  // review is coming and `reviewStateOf` asks what it said, and two reads could
  // answer differently across a pulse landing between them.
  const reviewRows = {
    prReviews: new Map(store.listPrReviews().map((review) => [review.prNumber, review])),
    prReviewRoutes: new Map(store.listPrReviewRoutes().map((route) => [route.prNumber, route])),
    prReviewedElsewhere: store.prsReviewedElsewhere(),
  };
  const signals = rejectionSignalQuery(proposals);
  const attentionCtx: PrAttentionContext = {
    // Unfiltered, as `inheritedCiFailure`/`basePrOf` need it: an unwatched base still
    // attributes.
    openPrs: world.pullRequests,
    defaultBranch: config.defaultBranch,
    watchLabel,
    tasks,
    proposals,
    rejectionSignals: signals ? store.listWorldEventsSince(signals.since, signals.refs) : [],
    recentDecisions: pickupCtx.recentDecisions,
    cooldown: DEFAULT_COOLDOWN,
    // The same policy the dispatcher holds, so `attention` names the court rule
    // `pr-ci-failing` will act in.
    ci: config.ci,
    now: world.takenAt,
    // Read, **never written**, here: a write from the read path would restart every
    // clock on whatever schedule the cockpit happened to poll on.
    reviewWaits: store.reviewWaits(),
    // The same two halves the dispatcher reads, so a row saying a review is coming and
    // a rule dispatching one are one reading.
    review: config.review,
    ...reviewRows,
  };
  // The world's change history the Activity/Signals panels draw. Read here because
  // its structured refs (`pr:42`, `issue:13`) must feed the ref map, and an event can
  // name a PR that merged out of the open list.
  const worldEvents = store.listWorldEvents(100);
  // The audit rows the shift log draws. Derived here so the ref keying `refUrls` and
  // the ref the column looks up are the same string — see `decisionSubjectRef`.
  const shiftLog = store.listDecisions(100).map((d) => ({ ...d, subjectRef: decisionSubjectRef(d.action) }));
  // The provider builds every URL (see CompositeConnector.resolveRefUrl); the
  // cockpit only looks refs up in this map, so it stays provider-agnostic.
  const refUrls = buildRefUrls({
    // Closed PRs need URLs too, and the archive outlives the world's window: a goal
    // page's kept rows would otherwise become plain numbers exactly when the
    // provider's page is the only place left to read them.
    pullRequests: [...world.pullRequests, ...(world.closedPullRequests ?? []), ...archivedPullRequests],
    issues: world.issues,
    taskBranches: tasks.map((t) => t.branch),
    // A filed ticket is usually *not* in the world lists the `#n` keys come from, so
    // it is resolved by canonical ref or its chip links nowhere.
    refs: [
      // Both halves of a raised bug: the story, and the bug itself once filed.
      ...bugFilings.map((b) => b.originRef),
      ...bugFilings.map((b) => b.ticketRef),
      ...humanTasks.map((t) => t.originRef),
      ...proposals.map((p) => p.ref),
      // The comments the harness maintains unasked — the plan's status comment and the
      // appraisal's refusal (#171). Keyed off the values actually shipped, so a ref the
      // cockpit holds is always one this map was keyed by.
      ...wirePlans.map((p) => p.statusCommentRef),
      ...appraisals.map((a) => issueCommentRef(a.originRef, a.commentRef)),
      // Each Activity/Signals entry's structured ref (`pr:42`, `issue:13`), keyed only here.
      ...worldEvents.map((e) => e.ref),
      // Every tracked task's origin ref (`pr:142:ci`, `issue:13:part:x`): the colon form
      // is not the `#n` the item lists key. A `job:<id>` resolves to nothing and is omitted.
      ...tasks.map((t) => t.originRef),
      // Every goal's own canonical ref: a goal's plan and queue speak the colon form,
      // and keying it only when something happens to name it links on a busy world and
      // renders plain on a quiet one.
      ...world.issues.map((i) => `issue:${i.number}`),
      // The goals whose run outlives the ticket (issues #203, #234): retained runs are
      // absent from `world.issues` by definition.
      ...issueRuns.map((r) => r.originRef),
      // What each audited decision is about, off the same derivation the row ships.
      ...shiftLog.map((d) => d.subjectRef),
    ],
    resolve: (ref) => connector.resolveRefUrl(ref),
  });
  // What every goal has cost, from the same `agents` rows the fleet list ships, plus
  // its local runs. The work graph is read rather than the world because it never
  // forgets a merged PR — a goal's total must not fall as PRs age out of `closedPrs`.
  const spend = once(() =>
    rollUpIssueSpend({
      agents,
      tasks,
      nodes: store.listWorkNodes(),
      localRuns: store.listLocalRuns(),
    }),
  );
  // The per-issue enrichment is hoisted so a live world issue and a retained
  // completion go through one path — two would drift exactly on a finished goal.
  // The flagged goals, keyed on the same `issue:<n>` origin the flag is written against.
  const goalPriorities = new Map(store.listGoalPriorities().map((g) => [g.originRef, { since: g.since }]));
  // One read for every goal ever validated locally, and one for the run they are
  // compared against — both `once`, since the enrichment below runs per issue.
  const localValidations = once(() => new Map(store.listLatestLocalValidations().map((v) => [v.originRef, v])));
  const liveLocalRun = once(() => store.liveLocalRun());
  const validationChecksFor = (origin: string): ReturnType<typeof validationVerdict> | null => {
    const checks = checksByGoal.get(origin) ?? [];
    return checks.length === 0 ? null : validationVerdict(checks);
  };
  // Where a goal *belongs*: the area tree as last read, and whether anything can
  // write a placement. Both are deployment facts, resolved once rather than per issue.
  const placementCtx: PlacementContext = {
    areaTree: system.areaPaths.current(),
    canPlace: connector.canPlaceWorkItem(),
    types: { containerTypes: config.issueContainerTypes, parentedTypes: config.issueParentedTypes },
  };
  /** The retained runs, each marked `stale` — the one field a live issue never carries. A goal whose ticket left the open set stays in the cockpit; what is stale is the tracker's copy. */
  const retainedRuns = () => {
    const retained = retainedRunIssues(issueRuns, world.issues);
    const mirrored = new Map(store.readTrackerItems(retained.map((i) => i.number)).map((t) => [t.number, t]));
    return retained.flatMap((issue) => {
      // Every stub was rebuilt from a run row, so this cannot miss: a type guard, not a case.
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
      // `conclusion` sits beside `pickup` and never feeds it: pickup answers "would an
      // agent start next cycle", conclusion "has anyone said this is finished".
      conclusion: resolveIssueConclusion(
        conclusions.get(origin) ?? null,
        plans.find((p) => p.originRef === origin) ?? null,
        planPartsOf(origin),
        shortfallsByOrigin.get(origin) ?? null,
      ),
      // Beside the conclusion and pickup verdicts, never inside either.
      shortfall: shortfallsByOrigin.get(origin) ?? null,
      // The positive mirror, present only while it stands (`standingDelivery`).
      delivery: standingDelivery(deliveriesByOrigin.get(origin), issue, pickupCtx),
      // The intake verdict, beside the other two and inside `pickup` for none.
      appraisal: appraisalVerdictOf(appraisalsByOrigin.get(origin), issue, placementCtx),
      // What this goal's work is pinned to, through the same function the dispatcher
      // resolves the pin with.
      modelPin: (({ profile, ignored }) => ({ profile, ignoredTags: ignored }))(
        resolveModelTag(issue.labels, config.labelPrefix, config.agentModels),
      ),
      // Whether the goal is at the front of the queue, from the rows the dispatcher
      // ranks by, so the chip cannot claim a priority the ranking is not honouring.
      priority: goalPriorities.get(origin) ?? null,
      // The run's own write-up (rule `issue-retro`) — the reading, never the writing.
      retrospective: retroReading(store.getRetrospective(origin)),
      // The shared pad — the reading only; the trail is fetched when a reader opens it.
      scratchpad: padReading(padsByOrigin.get(origin)),
      // What the operator asked for and nobody has concluded — in full, unlike the pad:
      // it is their own words and what the next agent will act on.
      instructions: instructionsByOrigin.get(origin) ?? [],
      // The harness's run at this goal (issues #203, #234). **Absent** when there has
      // never been work under it, so the floor reads four states — untouched, running,
      // finished, dismissed — off one optional field.
      run: run
        ? {
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            outcome: run.outcome,
            dismissed: run.dismissedAt !== null,
          }
        : undefined,
      // What this goal has cost, every agent under it included. **Null is "no runtime
      // reported usage"** — the normal case in PTY mode — not zero, so the cockpit
      // draws nothing rather than "$0.00".
      spend: spend().byIssue.get(origin) ?? null,
      // Whether this goal's validation plan is settled. **Null is "no checks"**, a
      // third reading and not a synonym for clear.
      validation: validationChecksFor(origin),
      // The fleet's last run against the machine's own dev environment — the **latest**
      // row, not a list.
      localValidation: localValidationView(
        localValidations().get(origin),
        liveLocalRun(),
        system.store,
        opts?.localValidationFileSigner,
      ),
    };
  };
  /** Where a pull request stands with the fleet's reviewer, off the same rows the attention lens reads. Undefined where the review is off, which draws no mark. */
  const reviewStateOf = (pr: PullRequest): PullRequest['review'] =>
    prReviewState(pr.number, reviewReading(reviewRows, pr.number), config.review, pr.reviewThreads) ?? undefined;
  /** The one enrichment a *dead* pull request gets: the record of what was already read, asked precisely after the merge. */
  const withReview = <T extends PullRequest>(pr: T): T => ({ ...pr, review: reviewStateOf(pr) });
  /** The review packs, read once as heads rather than per row — `listCurrentReviewPacks` parses every document to answer the same question about twenty pull requests. */
  const packHeads = once(() => new Map(store.listReviewPackHeads().map((head) => [head.prNumber, head])));
  /** Whether a pull request has a pack, and whether it is about the head. Undefined — no pack, nobody writing one — draws no mark. */
  const packStandingFor = (pr: PullRequest): PullRequest['pack'] =>
    packStandingOf(packHeads().get(pr.number), pr.headSha, system.reviewPacks.writing(pr.number));

  // The open pull requests with their verdicts folded, hoisted because the local
  // run's rows read the same rows: `ciVerdict` in particular must not be classified twice.
  const openPullRequests = once((): OpenPullRequest[] =>
    world.pullRequests.map((pr) => ({
      ...pr,
      // Two verdicts, because "can this merge" and "whose turn is it" have different
      // right answers for one PR (see `src/prAttention.ts`).
      health: prHealth(pr, world.pullRequests),
      attention: prAttentionStatus(pr, attentionCtx),
      // The third verdict, computed here rather than in the browser: re-matching
      // `config.ci` client-side means a second glob matcher and ordering, and the drift
      // fails silently — the cockpit saying *repair* while the harness held.
      ciVerdict: classifyCiFailures(pr.ciChecks, config.ci, pr.ciChecksWithheld),
      review: reviewStateOf(pr),
      // The fourth reading, and the only one about a *document*: whether there is a pack.
      pack: packStandingFor(pr),
    })),
  );
  // Branch → the pull request on it; open rows overwrite closed ones, so a reopened
  // branch reads as open. The lookup is by **branch** precisely so a goal's other pull requests can
  // never be presented as facts about the ref being run.
  const prByBranch = once(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of [...(world.closedPullRequests ?? []), ...openPullRequests()]) map.set(pr.branch, pr);
    return map;
  });
  /** What this deployment *is*, rather than what the fleet is doing. Almost all of it is fixed for the life of the process, so nothing routine invalidates it. */
  const harnessSection = (): Pick<
    CockpitState,
    'config' | 'recovery' | 'build' | 'pets' | 'localRun' | 'localRunTargets' | 'planning' | 'dispatchRules'
  > => ({
    config: {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxConcurrentAgents: config.maxConcurrentAgents,
      // The watch tag the toggle writes. One tag: an item without it is unwatched, and
      // there is no third reading.
      watchLabel,
      // The profiles a goal or part may be pinned to, cheapest first. Empty with no
      // `agentModels`, which is what turns the control off.
      profiles: orderedProfiles(config.agentModels),
      // Which profile an unpinned dispatch falls back to. Null when nothing is configured.
      defaultProfile: config.agentModels?.default ?? null,
      // The checkout a desktop deep link opens on: `repoRoot` is otherwise only
      // reachable through the running-config route.
      desktopFolder: config.repoRoot,
      // The fact rather than the text: the cockpit's question is only whether it can
      // offer a start.
      localRunConfigured: config.localRun.instruction.trim() !== '',
      // Whether a validating agent would have a browser. Not a gate on the control —
      // it words the empty state, so nothing-was-clicked has an explanation.
      localValidationBrowserConfigured: config.localValidation.browser !== null,
      localRunStopConfigured: config.localRun.stopInstruction.trim() !== '',
      localRunRefreshConfigured: config.localRun.refreshInstruction.trim() !== '',
      // The container policy itself: the backlog draws a container as a heading over its
      // children, a question about type no per-item verdict answers.
      containerTypes: [...config.issueContainerTypes],
      // Whether a finding can be filed as a ticket at all. A flag rather than an
      // inference from the provider name, so one place decides.
      canFileTickets: trackerCoordinates(config) !== null,
      stateColours: { ...config.issueStateColours },
      boardStates: [...config.issueBoardStates],
      // Asked of the connector, never inferred from the provider name.
      // `setWorkItemState` throws when nothing implements it.
      canSetWorkItemState: connector.canSetWorkItemState(),
      // The same question one act on: whether this tracker can be closed from here.
      canCloseIssue: connector.canCloseIssue(),
      // The same about a pull request — a different provider operation on both.
      canClosePr: connector.canClosePr(),
      // What the missing-parent warning is gated on — the same probe the placement
      // routes ask, so warning, row and write agree.
      canPlaceWorkItem: connector.canPlaceWorkItem(),
      // The flag and the provider's hierarchy, folded by the one predicate the route
      // refuses on.
      featureBoard: featureBoardOn(config, connector),
      // The nodes an item can be filed under, capped by the rule the appraiser's offer
      // is capped by, so operator and agent choose between the same things.
      areaPaths: placementCtx.areaTree === null ? [] : truncateAreaPaths(placementCtx.areaTree).paths,
      stateRules: workItemStateRules(config),
    },
    // Agents the previous run left orphaned, awaiting restore / requeue / remove. A
    // non-empty list means the harness is running **no cycles**, which is why the
    // cockpit draws it as a blocking banner.
    recovery: recovery.pending(),
    // Where the harness's own build stands. Served from the desk's last reading: a git
    // round trip on this path would put the network in front of the whole UI.
    build: updates.reading(),
    // Null when the feature is off, so the cockpit draws nothing rather than an empty
    // enclosure.
    pets: system.pets.state(),
    // The live run, or the last one that ended. `live` is derived here so which
    // statuses count is decided once, by the thing that sets them.
    localRun: localRunView(system.localRun.current(), system.localRun, system.localRunWatch.reading(), (ref, origin) =>
      localRunRefFacts(ref, planPartsOf(origin), {
        prByBranch: prByBranch(),
        tasks,
        defaultBranch: config.defaultBranch,
      }),
    ),
    // Where it could be pointed instead. Drawn whether anything is up or not, hence a
    // key of its own rather than one hanging off the run above.
    localRunTargets: localRunTargetViews({
      issues: world.issues,
      partsOf: planPartsOf,
      prByBranch: prByBranch(),
      openPrs: openPullRequests(),
      tasks,
      defaultBranch: config.defaultBranch,
    }),
    // The funnel's policy as the harness is running it: approving a decomposition
    // agrees to a rate as well as a shape.
    planning: config.planning,
    // The rule book as data: decision rows carry a rule id the cockpit expands here.
    dispatchRules: DISPATCH_RULES,
  });

  /**
   * The live dispatch controls, and nothing else. Its own section because
   * `control:changed` carries `cap` and `paused` whole, so the frame *is* the
   * delivery; this exists for the first load and for a client that missed a frame.
   */
  const controlSection = (): Pick<CockpitState, 'control'> => ({
    // Live, mutable dispatch controls — read for cap and pause, not the config block.
    control,
  });

  /**
   * The world as the cockpit draws it — every goal with its five verdicts folded,
   * the chains, and where landed work has reached.
   *
   * **The expensive one**: around 75 ms of a ~125 ms build on a 150-goal board, and
   * the section a fleet event never touches — which is why sections exist.
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
    // When the world below was observed — **null before the first cycle**, when there
    // is no baseline and the lists are empty.
    worldObservedAt: baseline?.takenAt ?? null,
    // Each PR's signals folded into a health verdict and each issue's gates into a
    // pickup verdict, so the cockpit can show *why* an item is stuck.
    world: {
      ...world,
      // The full open-PR list is stack context, so an inherited CI failure names the PR
      // underneath. `attention` sits beside `health`, never inside it.
      pullRequests: openPullRequests(),
      // The fleet review rides the closed rows too (`withReview`); nothing else is enriched.
      closedPullRequests: world.closedPullRequests?.map(withReview),
      // `conclusion` sits beside `pickup` and never feeds it: folding it in would let a
      // `done` verdict silently veto an item the operator moved back to a pickup state.
      issues: world.issues.map(enrichIssue),
      // The containers a parentless goal could hang off — the *same* `candidateParents`
      // an agent's orphan note is written from. Derived here because filtering `issues`
      // by container type finds nothing on a board narrowed by tag and assignee.
      parentCandidates: candidateParents(world.issues, config.issueContainerTypes),
    },
    // Runs whose issue the tracker no longer returns (issues #203, #234). Rebuilt by
    // the *same* `retainedRunIssues` the dispatcher unions in, and enriched through the
    // same path as a live issue. Dismissed and still-present runs are not here.
    retainedRuns: retainedRuns(),
    // The closed PRs kept past the world's window. Separate from `world`, because
    // `closedPullRequests` means "recently" and readers keep meaning that. Nothing is
    // enriched but the fleet review's record, which no rule or gate reads.
    archivedPullRequests: archivedPullRequests.map(withReview),
    // Chains of stacked PRs, derived from the world rather than stored, so a chain a
    // human opened by hand is drawn on a plan's terms. The unfiltered open list — an
    // `-ignore`d rung would hole the chain.
    stacks,
    // Where each goal's landed work has got to. From the store, not the world: a goal
    // whose ticket closed weeks ago is still travelling. Empty with no environment
    // configured, drawn as no row rather than a row of unknowns.
    environmentReach: buildEnvironmentReach(store, config.environments),
    // Two small tables, read whole: the Goal page draws its story beside its
    // neighbours from this snapshot rather than a fetch.
    featureSequences: store.listFeatureSequences(),
    // Whether each environment is well. Filtered by today's configuration, so one
    // whose `health` command was removed stops being drawn.
    environmentHealth: buildEnvironmentHealth(store, config.environments),
    goalWatchWindows: buildGoalWatchWindows(store, config.environments),
    // Off the same table the comments are posted from, capped like every other feed.
    // Empty with nothing configured.
    environmentArrivals: config.environments.length === 0 ? [] : store.listGoalArrivals().slice(0, 50),
    // The "land the stack" control, one entry per chain: whether the click may be
    // offered, and the standing intent over it. Joined by rung membership, never by
    // ref — see `landingFor`, which needs the open set to tell a fork from its sibling.
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
          // Against the durable record as well as the window, or "landing 1 of 3" counts
          // back down to 0 of 3 as merged rungs age out.
          landed: landing ? landedCount(landing, { ...world, merged: mergedPrs }) : 0,
        };
      }),
      // And the intents no chain accounts for: a chain of one is not a stack, so a
      // two-rung intent whose bottom rung merged would take the "stop" control with it
      // at exactly the moment an operator wants it. `offer` is false — nothing left to land.
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

  /**
   * The plan graph and the validation plan hanging off it.
   */
  const plansSection = (): Pick<
    CockpitState,
    'plans' | 'planParts' | 'validationChecks' | 'validationResources' | 'goalWatches'
  > => ({
    // The plan graph. The cockpit joins parts to `upcoming` by origin to draw the
    // dispatch cut.
    plans: wirePlans,
    planParts: wirePlanParts,
    // The validation plan beside the plan graph — checks whole, superseded ones
    // included, because the sheet has to be able to say a check was withdrawn.
    validationChecks,
    validationResources: wireValidationResources,
    // The post-deploy watch, read whole. A goal that declared nothing ships an empty
    // list rather than a fabricated clean one — null is not clean. Live checks **and**
    // the ones nobody has ruled on, since the plan sheet is where they are accepted;
    // every reader that queries an environment goes through live-only `listGoalWatches`.
    goalWatches: [...store.listGoalWatches(), ...store.listProposedGoalWatches()],
  });

  /**
   * The agents, what they were dispatched to do, and what that has cost — the section
   * almost every live signal invalidates. `tasks` and `agents` are bounded rather than
   * all-time reads: see {@link fleetHistory} and
   * [16](../../docs/spec/16-http-api.md#bulk-collections).
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
    // Every live agent, the tail of ended ones, and their tasks. `ended` is the whole
    // count, so "N shifts ended" is not the size of the tail.
    tasks: history().tasks,
    agents: history().agents,
    endedAgents: history().ended,
    // What the executor is working on that is not a row yet. Read off the board rather
    // than the wire: the record exists only in this process, for one await.
    readying: readying.list(),
    // Which rows are parked on a spent account limit rather than a question. Asked of
    // the fleet, never derived: both parks are `waiting` with a reason, and telling
    // them apart by the sentence is one wording change from the wrong control.
    parkedOnLimit: fleet.limitedAgentIds(),
    // And which are parked on an unannounced stop. Asked of the fleet for
    // `parkedOnLimit`'s reason — three parks wear one status.
    stallParks: fleet.stallDeadlines(),
    // Artifacts agents surfaced mid-run, grouped by agentId onto the fleet card.
    flags,
    // The URL to open each local artifact, carrying its per-flag capability (auth on)
    // or a bare path (auth off). An http(s) flag is absent here and linked directly.
    artifactUrls: artifactUrls(flags, opts?.artifactSigner),
    // The images an operator attached to a brief (issue #249), every ref in one list.
    // The cockpit filters by `targetRef`, which re-keys from `job:<id>` to `issue:<n>`
    // so a screenshot moves onto the goal rather than disappearing at the fork.
    attachments,
    // The URL to fetch each attachment's bytes from, with its capability: an `<img src>`
    // the browser loads on its own carries no bearer token.
    attachmentUrls: attachmentUrls(attachments, opts?.attachmentSigner),
    // Paths two agents wrote while both were running (issue #113) — the blind spot the
    // dispatch gates cannot see, read off rows we already have rather than an advisory
    // claim an agent must remember to make.
    overlaps: overlaps(),
    usage: buildUsage(system, spend().unattributedCostUsd),
    // The Yield gauge's reading, from the same rows and fold `/api/reliability` uses.
    runOutcomes: tallyRunOutcomes(agents),
  });

  /**
   * What is waiting to be dispatched, and the recurrences behind some of it.
   */
  const queueSection = (): Pick<CockpitState, 'jobs' | 'schedules' | 'upcoming' | 'runway'> => ({
    // Operator-launched jobs, newest first: the queue and its recent history.
    jobs: store.listJobs(),
    // The recurrences behind some of them, whole rather than "due soon": a standing
    // intention written weeks ago — including a disabled one — is invisible elsewhere.
    schedules: store.listJobSchedules(),
    // The "Up next" queue: last cycle's ordered pickup plan with the headroom cut
    // (issue #69). Null until a cycle has run, or where no plan is materialised.
    upcoming: harness.upcoming,
    // The band under Fleet, taken here rather than cached off the pulse: a reading a
    // pulse old would show a just-topped-up queue as empty. The same function the desk
    // calls, so band and bench row cannot disagree about the gate.
    //
    // `standing` is read off the **unbounded** bench, never the panel's capped feed: a
    // hundred rows filed behind a standing `supply` row push it out of the window, and
    // the band silently applies `warnHours` where the desk applies `clearHours`.
    runway: readRunway({
      policy: config.runway,
      issues: world.issues,
      pickup: pickupCtx,
      runs: issueRuns,
      // Every row, not the capped feed: the debt clause is a count, and settled rows
      // are the human holds the median lead time subtracts.
      humanTasks: allHumanTasks,
      // The projection, never `listEscalations`: that read is all-time and carries every
      // settled item's transcript tail.
      escalations: store.listEscalationSpans(),
      cap: control.cap,
      standing: allHumanTasks.some((t) => t.kind === 'supply' && t.status === 'open'),
    }),
  });

  /**
   * Everything still waiting on a person.
   */
  const inboxSection = (): Pick<CockpitState, 'bugFilings' | 'humanTasks' | 'escalations' | 'proposals'> => ({
    // Bugs raised from a story row: `filing` while the desk agent writes one, `filed`
    // with a ref once it exists. Several per story is normal.
    bugFilings,
    // Open ones and a settled tail alike: a row that vanished on being settled would
    // take the operator's own note with it.
    humanTasks,
    // **Open ones only.** Every cockpit surface filters to `status === 'open'`, and
    // each row carries a transcript tail in `context.recentOutput`.
    escalations: store.listOpenEscalations(),
    // Acts a human was asked to authorize (issue #109), joined to their escalation so a
    // decision-bearing item gets accept/reject rather than a text box.
    proposals,
  });

  /**
   * What has happened: the world's own changes, the harness's decisions, and its
   * recorded failures. Three capped feeds.
   */
  const activitySection = (): Pick<CockpitState, 'decisions' | 'worldEvents' | 'errors'> => ({
    decisions: shiftLog,
    worldEvents,
    // Recorded failures for the cockpit's Errors panel.
    errors: store.listErrors(100),
  });

  // Assembled section by section, so a caller that asked for one pays for one.
  // `test/stateSections.test.ts` holds the partition against `CockpitState`, so a key
  // added to the wire and to no section is caught rather than silently dropped.
  const out: Partial<CockpitState> = {
    // **Always shipped, whatever was asked for**: a patch carrying rows with no way to
    // reach them is the dead end `<Ref/>` exists to prevent. Merged rather than
    // replaced on the client, since a ref's URL is stable.
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
    // A signer is present exactly when auth is on. Off, the route needs no
    // capability, so the bare path is the whole URL.
    map[flag.id] = signer ? `${base}?tk=${encodeURIComponent(signer(flag.id))}` : base;
  }
  return map;
}

/**
 * Build the `attachment id → URL` map the cockpit points its thumbnails at. Unlike
 * `artifactUrls` nothing is skipped — every attachment is a local file this harness wrote.
 */
function attachmentUrls(attachments: { id: string }[], signer?: (id: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attachment of attachments) {
    const base = `/attachments/${encodeURIComponent(attachment.id)}`;
    // A signer is present exactly when auth is on. Off, the route verifies
    // nothing, so the bare path is the whole URL.
    map[attachment.id] = signer ? `${base}?tk=${encodeURIComponent(signer(attachment.id))}` : base;
  }
  return map;
}

/**
 * A delivery verdict, shipped **only while it still stands**. `deliveryHold`
 * is what rule `issue-pickup` gates on and answers null for a verdict the
 * world has overtaken, so a released verdict goes null rather than promising
 * a park that has ended. The hold *reason* is not shipped — `pickup.reasons`
 * already carries it.
 */
function standingDelivery(delivery: IssueDelivery | undefined, issue: Issue, ctx: IssuePickupContext) {
  if (!delivery) return null;
  const held = deliveryHold(delivery, issue, { pickupStates: ctx.policy.pickupStates, signals: ctx.deliverySignals });
  if (!held) return null;
  const { summary, by, decidedAt } = delivery;
  return { summary, by, decidedAt };
}

/**
 * What the Goal Floor's Manifest station needs: whether a goal was written up, the
 * one line to show, and when. Deliberately not the document.
 */
function retroReading(retro: Retrospective | null) {
  return retro ? { summary: retro.summary, hasDocument: retro.document.length > 0, updatedAt: retro.updatedAt } : null;
}

/** The same shape for the shared pad: the count and the age, never the trail. A pad nobody has written to is **null rather than a zero** — the control it draws is keyed on the pad existing. */
function padReading(pad: ScratchPadSummary | undefined) {
  return pad && pad.entries > 0 ? { entries: pad.entries, updatedAt: pad.updatedAt } : null;
}

/**
 * The reviewable half of a stored appraisal, or null when nobody has judged
 * the goal. **Null, `workable` and `unclear` are three readings**: an
 * unappraised goal draws no drill, a refused one draws a stopped drill that
 * says why. `goalRef` is not shipped — it is a fingerprint the hold is
 * measured against, not a reading.
 */
function appraisalVerdictOf(appraisal: IssueAppraisal | undefined, issue: Issue, placement: PlacementContext) {
  if (!appraisal) return null;
  const { verdict, summary, by, decidedAt, proposedProfile } = appraisal;
  return {
    verdict,
    summary,
    by,
    decidedAt,
    commentRef: issueCommentRef(appraisal.originRef, appraisal.commentRef),
    proposedProfile,
    // Both fields, because the gate is their conjunction: a proposal settled on arrival
    // is still worth showing and is holding nothing.
    awaitingProfileAnswer: proposedProfile !== null && appraisal.profileAnsweredAt === null,
    // The placement questions still open, derived every time against the **live** work
    // item — nothing is stored but the operator's "does not apply", which is why
    // setting the field by hand in the tracker ends the question with no write.
    // Gated on the sink being able to make the write at all: a proposal nobody can act
    // on is three buttons that all 400.
    placement: placement.canPlace
      ? placementAsks(appraisal, issue, placement.areaTree, appraisal.goalRef, placement.types)
      : [],
    // Carried whole and deliberately **not** gated on `canPlace`: this is a stamp of
    // something the operator did, and losing the ability to write has not un-answered it.
    parentSettledAt: appraisal.parentSettledAt,
  };
}

/**
 * What the placement questions are judged against: the project's area tree, and
 * whether anything can write a placement. Resolved once per snapshot rather than per
 * issue — asking the connector per issue would loop a capability probe over the board.
 */
interface PlacementContext {
  areaTree: AreaPathTree | null;
  canPlace: boolean;
  /** The operator's `issueContainerTypes` / `issueParentedTypes`, carried whole: half a policy silently falls back to the built-in defaults in `isOrphanIssue`. */
  types: PlacementTypePolicy;
}

/**
 * Account-level Claude usage: the rolling cost windows summed from stream-mode
 * turn reports, plus subscriber 5h/weekly limits where a reading has been
 * seen (Pro/Max only — null otherwise). Nothing in the cockpit draws either
 * yet ([18](../../docs/spec/18-observability.md)). `unattributedCostUsd` is
 * spend that reached no goal, making per-issue totals a partition rather than
 * a subset.
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
 * Every goal anything is known about, and where each has got to. The goal set comes
 * from the **landings and the work graph**, never the world: a goal matters most to
 * this panel once its ticket has closed, which is when the world stops listing it.
 * Empty when nothing is configured.
 */
/**
 * What each environment's own health check last said, in the operator's order.
 * **The configuration decides the set, and the store only fills it in** — nothing
 * deletes a stored reading, so a removed `health` would otherwise be drawn with its
 * last answer for ever. An environment not yet asked is absent, never `unknown`.
 */
function buildEnvironmentHealth(store: System['store'], environments: EnvironmentConfig[]): EnvironmentHealthReading[] {
  const readings = store.listEnvironmentHealth();
  return environments
    .filter((env) => env.health !== undefined)
    .flatMap((env) => readings.filter((r) => r.environment === env.name));
}

function buildEnvironmentReach(store: System['store'], environments: EnvironmentConfig[]): GoalReachView[] {
  if (environments.length === 0) return [];
  const arrivals = store.listGoalArrivals();
  const releases = store.listEnvironmentGateReleases();
  const released = new Map(releases.map((r) => [r.goalRef, r]));
  // A hold is only a hold on a *delivered* goal: everything else is work in progress.
  const delivered = new Set(store.listDeliveries().map((d) => d.originRef));
  const shortfalls = new Set(store.listShortfalls().map((sf) => sf.originRef));
  // Resolved before the fold, because it also widens the fold's goal set: a goal
  // delivered with nothing merged ships no row otherwise, and the hold sentence and
  // release control live inside the card an empty list stops drawing. A released goal
  // is kept for the same reason — the row is where its note is drawn.
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
    // The denominator is the goal's *work*: unmerged parts count alongside landings, so
    // the first of four parts arriving is not the goal arriving.
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
 * Every post-deploy watch, one entry per `(goal, environment)` an arrival
 * opened. Empty when no environment declares a `watch` — null is a third
 * fact, not a synonym for clean. Every declared check is carried whether or
 * not anything is wrong, and **nothing is rolled up to a word**.
 * → `docs/spec/29-post-deploy-watch.md#the-verdict`
 */
function buildGoalWatchWindows(store: System['store'], environments: EnvironmentConfig[]): GoalWatchView[] {
  if (!environments.some((e) => e.watch !== undefined)) return [];
  const windows = store.listWatchWindows();
  if (windows.length === 0) return [];
  // The newest reading per `(window, check)`: readings are oldest-first, so the last
  // to land on a key is the one the card draws.
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
        // The **before**, beside the reading rather than folded in: the card draws
        // expected / before / now.
        baselineValue: c.baselineValue,
        reading: newest.get(`${window.goalRef} ${window.environment} ${c.id}`) ?? null,
      })),
  }));
}

/**
 * The run as the cockpit reads it, or null when nothing has ever been
 * started. `live` and `phase` are added here so which statuses count as
 * running is decided once beside the writer that sets them. The phase, turn
 * and session-held facts come from the runner since none is durable. The
 * readings come from the watch and are shipped **only while the run is
 * live**, or a stale port is drawn beside a stopped run for the width of one tick.
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

/** What has happened on **one branch**: the part it belongs to, and the pull request on it. Lookup is by branch, never by goal — "show the goal's PR" is how a panel reports a passing build for a branch nothing has built. */
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
            // The CI policy's classification, off the verdict this snapshot already
            // folded. A closed row carries none, which is no detail rather than a clean
            // bill — the aggregate `ciStatus` still speaks.
            failing: [...(pr.ciVerdict?.dispatch ?? []), ...(pr.ciVerdict?.escalate ?? [])].map((c) => c.name),
            approved: pr.approved === true,
            unresolved: pr.unresolvedComments.length,
          },
    mergedParts: parts.filter((p) => p.status === 'merged').length,
    // The same rule the dispatcher, executor and branch reap read — not a fourth opinion.
    agentOnIt: onBranch.some((t) => isActiveTask(t)),
    lastActivityAt: onBranch.reduce<string | null>(
      (newest, t) => (newest === null || t.updatedAt > newest ? t.updatedAt : newest),
      null,
    ),
  };
}

/** Where the local run could be pointed, one entry per goal. The ref comes from `localRunChoices` — the same function the runner starts from and guards an override with. */
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
    // The goal's own branch as well as its parts', through the same `openPrForIssue`
    // the pickup verdict uses and the same call the runner makes.
    const choices = localRunChoices(parts, openPrForIssue(issue, ctx.openPrs)?.branch ?? null);
    const facts = (ref: string): LocalRunRefFacts => localRunRefFacts(ref, parts, ctx);
    return {
      originRef: origin,
      issueNumber: issue.number,
      target: facts(choices.target ?? ctx.defaultBranch),
      options: choices.options.map((option) => ({ option, facts: facts(option.ref) })),
      // A goal with no branch of its own resolves to the integration branch, like every
      // other such goal — not a *choice*, so the panel's default filter leaves it out.
      runnable: choices.target !== null,
    };
  });
}

/**
 * The state words the work-item rules act on, or null where all are off.
 * `pickup` is the **effective** set the dispatcher gates on, folding
 * `issueInProgressState` in. `returnsTo` is the first *configured* pickup
 * state, never the first effective one — that is how `workItemBackToPickup`
 * reads it.
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

/** A goal's latest local validation, as the cockpit draws it — or null. Everything is derived here: the phase folds three facts, screenshot URLs carry a capability only the server can mint. */
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
      // A signer is present exactly when auth is on; off, the bare path is the whole URL.
      return { name, url: signer ? `${base}?tk=${encodeURIComponent(signer(row.id, name))}` : base };
    }),
    agent: agentOf(row.taskId),
    fixAgent: agentOf(row.fixTaskId),
  };
}

/** How far a validation has got, in one answer. `driving` is claimed only once the run is actually `running`. **Null once the row is settled**, since there is a status to draw then. */
function localValidationPhase(row: LocalValidation, live: LocalRun | null): LocalValidationPhase | null {
  if (row.status === 'pending') return 'queued';
  if (row.status !== 'dispatched') return null;
  if (row.plan === null) return 'planning';
  return live?.status === 'running' ? 'driving' : 'environment';
}
