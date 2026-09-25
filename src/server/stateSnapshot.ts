import type { System } from '../system/system.js';
import type { Config } from '../config/config.js';
import { withheldAction, WITHHELD_PLAN } from './planReveal.js';
import type { StateSection } from '../wire.js';
import type { Store } from '../store/store.js';
import type { CockpitState, UndescribedPart, DescriptionFeedback, OpenPullRequest, PullRequest } from '../wire.js';
import { truncateAreaPaths } from '../intake/placement.js';
import { buildStacks } from '../stacks/stack.js';
import { landedCount, landingFor, landingReadiness } from '../stacks/landing.js';
import { prHealth } from '../pr/prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../pr/prAttention.js';
import { reviewReading } from '../review/prReview.js';
import { prReviewState } from '../review/prReviewState.js';
import { assignAskDue } from '../pr/prAssignAsk.js';
import { classifyCiFailures } from '../ci/ciPolicy.js';
import { rejectionSignalQuery } from '../proposals/proposals.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import { effectivePickupStates } from '../dispatcher/issuePickup.js';
import { tallyRunOutcomes } from '../insights/reliabilityInsights.js';
import { readRunway } from '../supply/runway.js';
import { DISPATCH_RULES } from '../dispatcher/rules.js';
import { trackerCoordinates } from '../mcp/findings.js';
import { featureBoardOn, featureSummariesOn } from '../features/featureBoard.js';
import { candidateParents } from '../issueRelations.js';
import { environmentGroups } from '../environments/groups.js';
import { orderedProfiles } from '../agents/modelPolicy.js';
import { once, type SnapshotOpts, baseReads, planReads, verdictReads, contextReads } from './stateReads.js';
import { type IssueReadsOn, issueReads } from './stateIssueReads.js';
import {
  buildEnvironmentHealth,
  buildEnvironmentReach,
  buildGoalWatchWindows,
  buildRemoteSheets,
  tenantCommandViews,
} from './stateEnvironmentViews.js';
import { localRunView, localRunRefFacts, localRunTargetViews } from './stateLocalRunViews.js';

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

export function buildStateSnapshot(system: System, opts?: SnapshotOpts): CockpitState {
  return buildStateSections(system, ALL_SECTIONS, opts) as CockpitState;
}

export function buildStateSections(
  system: System,
  want: ReadonlySet<StateSection>,
  opts?: SnapshotOpts,
): Partial<CockpitState> {
  const r = snapshotReads(system, opts);
  const out: Partial<CockpitState> = {
    refUrls: r.refUrls,
  };
  if (want.has('harness')) Object.assign(out, harnessSection(r));
  if (want.has('control')) Object.assign(out, controlSection(r));
  if (want.has('goals')) Object.assign(out, goalsSection(r));
  if (want.has('plans')) Object.assign(out, plansSection(r));
  if (want.has('fleet')) Object.assign(out, fleetSection(r));
  if (want.has('queue')) Object.assign(out, queueSection(r));
  if (want.has('inbox')) Object.assign(out, inboxSection(r));
  if (want.has('activity')) Object.assign(out, activitySection(r));
  return out;
}

type Reads = IssueReadsOn & ReturnType<typeof prReads> & { stacks: () => ReturnType<typeof buildStacks> };

function snapshotReads(system: System, opts: SnapshotOpts | undefined): Reads {
  const base = baseReads(system, opts);
  const planned = { ...base, ...planReads(base) };
  const verdicts = { ...planned, ...verdictReads(planned) };
  const contexts = { ...verdicts, ...contextReads(verdicts) };
  const issues = { ...contexts, ...issueReads(contexts) };
  const { world, plans, planParts, config } = issues;
  const stacks = once(() => buildStacks(world.pullRequests, plans, planParts(), config.defaultBranch));
  return { ...issues, ...prReads(issues), stacks };
}

function prReads(r: IssueReadsOn) {
  const { store, config, world, reviewRows, system } = r;
  const attentionCtx = prAttentionContext(r);
  const assignAsks = once(() => {
    const desk = system.prAssign;
    return desk.canAssign() ? { desk, answered: desk.answered(), shortlist: desk.shortlist(world.pullRequests) } : null;
  });
  const assignAskOf = (pr: PullRequest, attention: OpenPullRequest['attention']): OpenPullRequest['assignAsk'] => {
    const asks = assignAsks();
    if (asks === null || asks.shortlist.length === 0) return undefined;
    const due = assignAskDue({
      pr,
      ours: asks.desk.ours(pr),
      answered: asks.answered.has(pr.number),
      review: reviewStateOf(pr),
      fleetOnIt: attention.status === 'harness',
      operator: config.userId,
    });
    return due ? asks.shortlist : undefined;
  };
  const reviewStateOf = (pr: PullRequest): PullRequest['review'] =>
    prReviewState(pr.number, reviewReading(reviewRows(), pr.number), config.review, pr.reviewThreads) ?? undefined;
  const withReview = <T extends PullRequest>(pr: T): T => ({ ...pr, review: reviewStateOf(pr) });

  const splitVerdicts = once(() => new Map(store.prSplits.listPrSplitVerdicts().map((v) => [v.prNumber, v])));
  const openPullRequests = once((): OpenPullRequest[] =>
    world.pullRequests.map((pr) => {
      const attention = prAttentionStatus(pr, attentionCtx());
      const assignAsk = assignAskOf(pr, attention);
      return {
        ...pr,
        health: prHealth(pr, world.pullRequests),
        attention,
        ciVerdict: classifyCiFailures(pr.ciChecks, config.ci, pr.ciChecksWithheld),
        review: reviewStateOf(pr),
        split: splitVerdicts().get(pr.number),
        ...(assignAsk === undefined ? {} : { assignAsk }),
      };
    }),
  );
  const prByBranch = once(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of [...(world.closedPullRequests ?? []), ...openPullRequests()]) map.set(pr.branch, pr);
    return map;
  });
  return { withReview, openPullRequests, prByBranch };
}

function prAttentionContext(r: IssueReadsOn): () => PrAttentionContext {
  const { store, config, world, tasks, proposals, watchLabel, recentDecisions, reviewRows } = r;
  return once((): PrAttentionContext => {
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
}

function harnessSection(
  r: Reads,
): Pick<
  CockpitState,
  | 'config'
  | 'recovery'
  | 'build'
  | 'pets'
  | 'localRun'
  | 'localRunTargets'
  | 'tenantCommands'
  | 'planning'
  | 'dispatchRules'
> {
  const { system, store, connector, config, watchLabel, world, tasks, placementCtx, planPartsOf, prByBranch } = r;
  return {
    config: {
      /* The declaration, in promotion order, and never a goal's reading of it: the goal page's
         obligation tabs are the deployment's shape, so a goal that has reached nothing draws the
         same row as one that has arrived everywhere.
         → docs/spec/17-cockpit.md#the-panes */
      environments: config.environments.map((env) => ({
        name: env.name,
        opens: [...(env.arrival?.opens ?? [])],
        watched: env.watch !== undefined,
      })),
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
      featureBoard: featureBoardOn(connector),
      featureSummaries: featureSummariesOn(config, connector),
      areaPaths: placementCtx.areaTree === null ? [] : truncateAreaPaths(placementCtx.areaTree).paths,
      stateRules: workItemStateRules(config),
    },
    recovery: system.recovery.pending(),
    build: system.updates.reading(),
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
      openPrs: r.openPullRequests(),
      tasks,
      defaultBranch: config.defaultBranch,
    }),
    tenantCommands: tenantCommandViews(config.environments, store.remoteValidation.listTenantPrepares()),
    planning: config.planning,
    dispatchRules: DISPATCH_RULES,
  };
}

function controlSection({ control }: Reads): Pick<CockpitState, 'control'> {
  return { control };
}

function goalsSection(
  r: Reads,
): Pick<
  CockpitState,
  | 'worldObservedAt'
  | 'world'
  | 'archivedPullRequests'
  | 'retainedRuns'
  | 'stacks'
  | 'environmentReach'
  | 'featureSequences'
  | 'environmentHealth'
  | 'environmentGroups'
  | 'goalWatchWindows'
  | 'environmentArrivals'
  | 'criteriaDrift'
  | 'remoteSheets'
  | 'stackLandings'
> {
  const { store, config, opts, baseline, world, tasks, stacks, withReview } = r;
  // Read once and folded twice: the sheet card draws these rows, and the Environments card's own row
  // carries their fold. Two readers would be two opinions drawn beside each other.
  const remoteSheets = once(() => buildRemoteSheets(store, config.environments, tasks, opts?.remoteCaptureSigner));
  const environments = config.environments;
  const arrivals = environments.length === 0 ? [] : store.environments.listGoalArrivals();
  const prByNumber = new Map<number, PullRequest>();
  for (const pr of world.pullRequests) if (!prByNumber.has(pr.number)) prByNumber.set(pr.number, pr);
  const stackRungPrs = new Set(stacks().flatMap((s) => s.rungs.map((r) => r.prNumber)));
  return {
    worldObservedAt: baseline?.takenAt ?? null,
    world: {
      ...world,
      pullRequests: r.openPullRequests(),
      closedPullRequests: world.closedPullRequests?.map(withReview),
      issues: world.issues.map(r.enrichIssue),
      parentCandidates: candidateParents(world.issues, config.issueContainerTypes),
    },
    retainedRuns: r.retainedRuns(),
    archivedPullRequests: r.archivedPullRequests.map(withReview),
    stacks: stacks(),
    environmentReach:
      environments.length === 0
        ? []
        : buildEnvironmentReach({
            store,
            environments,
            sheets: remoteSheets(),
            plans: r.plans,
            parts: r.planParts(),
            arrivals,
            nodes: r.workNodes(),
            delivered: r.deliveries(),
            shortfalled: r.shortfallsByOrigin(),
          }),
    featureSequences: store.sequences.listFeatureSequences(),
    environmentHealth: buildEnvironmentHealth(store, environments),
    environmentGroups: environmentGroups(environments)
      .filter((band) => band.declared)
      .map(({ name, environments: members }) => ({ name, environments: members })),
    goalWatchWindows: buildGoalWatchWindows(store, environments, r.goalWatches),
    environmentArrivals: arrivals.slice(0, 50),
    ...(config.goalCriteria.enabled ? { criteriaDrift: store.goalCriteria.listCriteriaDrift().slice(0, 50) } : {}),
    remoteSheets: remoteSheets(),
    stackLandings: stackLandingViews(r, prByNumber, stackRungPrs),
  };
}

function stackLandingViews(
  r: Reads,
  prByNumber: Map<number, PullRequest>,
  stackRungPrs: Set<number>,
): CockpitState['stackLandings'] {
  const { world, stacks, landings, mergedPrs, openPrNumbers } = r;
  return [
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
  ];
}

/**
 * Parts with a pull request open and no description written, which is the rail's
 * ask. Read here rather than derived in the cockpit: the described set is not on
 * the wire.
 *
 * Open is the cut the store cannot make, so it is made here against the world's
 * own list: a pull request that merged or was closed is not one anybody is going
 * to describe, and an ask that outlived its review is an ask nobody can answer.
 * → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
 */
function undescribedParts(store: Store, open: Set<number>): UndescribedPart[] {
  return store.prDescriptions.undescribedOpenParts().filter((part) => open.has(part.prNumber));
}

/**
 * Checked descriptions that found something, on pull requests still open. The rail
 * raises each one: a contradiction as an ask, gaps alone as a low-priority note.
 * → docs/spec/07-pull-requests.md#what-the-check-raises
 */
function descriptionFeedback(store: Store, open: Set<number>): DescriptionFeedback[] {
  return store.prDescriptions.descriptionFeedback().filter((f) => open.has(f.prNumber));
}

function plansSection(
  r: Reads,
): Pick<
  CockpitState,
  | 'plans'
  | 'planParts'
  | 'undescribedParts'
  | 'descriptionFeedback'
  | 'planAtoms'
  | 'planCaveatAnswers'
  | 'validationChecks'
  | 'validationPlans'
  | 'validationResources'
  | 'goalWatches'
  | 'stateQueries'
> {
  const { store, withheld, openPrNumbers } = r;
  return {
    plans: r.wirePlans,
    planParts: r.wirePlanParts(),
    undescribedParts: undescribedParts(store, openPrNumbers),
    descriptionFeedback: descriptionFeedback(store, openPrNumbers),
    planAtoms: store.plans.listAllPlanAtoms().filter((atom) => !withheld(atom.planId)),
    planCaveatAnswers: store.plans.listAllPlanCaveatAnswers(),
    validationChecks: r.validationChecks(),
    validationPlans: store.validation.listValidationPlanRecords(),
    validationResources: r.wireValidationResources(),
    goalWatches: [...r.goalWatches(), ...store.watches.listProposedGoalWatches()],
    stateQueries: store.remoteValidation.listStateQueries(),
  };
}

function fleetSection(
  r: Reads,
): Pick<
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
> {
  const { system, opts, history, flags, attachments } = r;
  return {
    tasks: history().tasks,
    agents: history().agents,
    endedAgents: history().ended,
    ejections: r.ejectionViews(),
    readying: system.readying.list(),
    parkedOnLimit: system.agents.limitedAgentIds(),
    stallParks: system.agents.stallDeadlines(),
    flags: flags(),
    artifactUrls: artifactUrls(flags(), opts?.artifactSigner),
    attachments: attachments(),
    attachmentUrls: attachmentUrls(attachments(), opts?.attachmentSigner),
    overlaps: r.overlaps(),
    usage: buildUsage(system, r.spend().unattributedCostUsd),
    runOutcomes: tallyRunOutcomes(r.agents()),
  };
}

function queueSection(r: Reads): Pick<CockpitState, 'jobs' | 'schedules' | 'upcoming' | 'runway'> {
  const { system, store, config, world, control, allHumanTasks } = r;
  return {
    jobs: store.jobs.listJobs(),
    schedules: store.schedules.listJobSchedules(),
    upcoming: system.harness.upcoming,
    runway: readRunway({
      policy: config.runway,
      issues: world.issues,
      pickup: r.pickupCtx(),
      runs: r.issueRuns,
      humanTasks: allHumanTasks(),
      escalations: store.escalations.listEscalationSpans(),
      cap: control.cap,
      standing: allHumanTasks().some((t) => t.kind === 'supply' && t.status === 'open'),
    }),
  };
}

function inboxSection(r: Reads): Pick<CockpitState, 'bugFilings' | 'humanTasks' | 'escalations' | 'proposals'> {
  const { store, withheld } = r;
  return {
    bugFilings: r.bugFilings,
    humanTasks: r.humanTasks,
    escalations: store.escalations.listOpenEscalations().map((e) => {
      if (!withheld(e.context.planId)) return e;
      return {
        ...e,
        prompt: WITHHELD_PLAN,
        context: { ...e.context, detail: WITHHELD_PLAN, detailFrom: 'Withheld until the plan is revealed' },
      };
    }),
    proposals: r.proposals.map((p) => {
      if (!withheld(p.action.planId)) return p;
      return { ...p, action: withheldAction(p.action) };
    }),
  };
}

function activitySection(r: Reads): Pick<CockpitState, 'decisions' | 'worldEvents' | 'errors'> {
  return {
    decisions: r.shiftLog,
    worldEvents: r.worldEvents,
    errors: r.store.errors.listErrors(100),
  };
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
