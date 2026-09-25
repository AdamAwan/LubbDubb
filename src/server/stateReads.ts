import { existsSync } from 'node:fs';
import { issueOriginRef } from '../issueOrigins.js';
import type { System } from '../system/system.js';
import type { Config } from '../config/config.js';
import { revealGateOn } from '../config/config.js';
import { planIsWithheld, withheldAction, WITHHELD_PLAN } from './planReveal.js';
import type { Decision, IssueInstruction, Plan, PlanPart, WorldSnapshot } from '../types.js';
import type { Store } from '../store/store.js';
import type { EjectionView, PlanPartView, PlanView, ValidationCheckView, ValidationResourceView } from '../wire.js';
import { buildRefUrls, decisionSubjectRef, issueCommentRef } from './refUrls.js';
import { fleetHistory } from './fleetHistory.js';
import { applyThreadReopens } from '../pr/prThreads.js';
import { expiresAt } from '../ejection/policy.js';
import type { IssuePickupContext } from '../dispatcher/issuePickup.js';
import { pausedIssueNumbers } from '../goalPause.js';
import { DEFAULT_COOLDOWN } from '../dispatcher/dispatchCooldown.js';
import { detectFileOverlaps, OVERLAP_AGENT_WINDOW } from '../fileOverlap.js';
import { acceptanceCriteria, bySlug, partDepth, partOrigin, planIssueNumber } from '../plans/parts.js';
import { planScopeDrift } from '../plans/scopeDrift.js';
import { deliverySignalQuery } from '../delivery/delivery.js';
import { validationResourcePath } from '../validation/resources.js';
import { withLiveClaim } from '../validation/desktop.js';
import { watchLabelFor } from '../watchLabels.js';

// → docs/spec/16-http-api.md

export function once<T>(read: () => T): () => T {
  let held: { value: T } | null = null;
  return () => {
    held ??= { value: read() };
    return held.value;
  };
}

export interface SnapshotOpts {
  artifactSigner?: (flagId: string) => string;
  attachmentSigner?: (attachmentId: string) => string;
  localValidationFileSigner?: (id: string, name: string) => string;
  validationCaptureSigner?: (originRef: string, checkId: string) => string;
  remoteCaptureSigner?: (runId: string, rowId: string) => string;
}

const EJECTION_ROWS = 40;

type BaseReads = ReturnType<typeof baseReads>;
type PlanReadsOn = BaseReads & ReturnType<typeof planReads>;
type VerdictReadsOn = PlanReadsOn & ReturnType<typeof verdictReads>;
export type ContextReadsOn = VerdictReadsOn & ReturnType<typeof contextReads>;

export function baseReads(system: System, opts: SnapshotOpts | undefined) {
  const { store, connector, config, runtimeControl } = system;
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
  return {
    system,
    opts,
    store,
    connector,
    config,
    watchLabel,
    baseline,
    world,
    archivedPullRequests,
    tasks,
    agents,
    history,
    control,
    flags,
    attachments,
    humanTasks,
    ejectionViews,
    allHumanTasks,
    proposals,
    bugFilings,
    overlaps,
  };
}

export function planReads({ system, store, config, world, tasks }: BaseReads) {
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
  const openPrNumbers = new Set(world.pullRequests.filter((p) => !p.merged).map((p) => p.number));
  const mergedPrs = once(() => store.graph.mergedPrs());
  const landings = once(() =>
    store.landings.listStackLandings().filter((l) => l.status === 'standing' || l.status === 'stopped'),
  );
  const { withheld, wirePlans } = planReveals(system, config, plans);
  const wirePlanParts = planPartViews(store, tasks, plans, planParts, partsOfPlan, withheld);
  return {
    plans,
    planParts,
    planByOrigin,
    planPartsOf,
    openPrNumbers,
    mergedPrs,
    landings,
    withheld,
    wirePlans,
    wirePlanParts,
  };
}

function planReveals(system: System, config: Config, plans: Plan[]) {
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
  return { withheld, wirePlans };
}

function planPartViews(
  store: Store,
  tasks: BaseReads['tasks'],
  plans: Plan[],
  planParts: () => PlanPart[],
  partsOfPlan: (planId: string) => PlanPart[],
  withheld: (planId: unknown) => boolean,
) {
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
  return wirePlanParts;
}

export function verdictReads({ store, config, opts }: PlanReadsOn) {
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
  return {
    validationChecks,
    checksByGoal,
    wireValidationResources,
    goalWatches,
    conclusions,
    deliveries,
    deliveriesByOrigin,
    deliverySignals,
    issueRuns,
    runByOrigin,
    shortfallsByOrigin,
    padsByOrigin,
    instructionsByOrigin,
    appraisals,
    appraisalsByOrigin,
  };
}

export function contextReads(r: VerdictReadsOn) {
  const { system, store, config, world, tasks, control, plans, planParts } = r;
  const { deliveries, deliverySignals, appraisals, issueRuns } = r;
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
      closedSittings: revealGateOn(config) ? new Set(system.predictions.listReveals().map((r) => r.originRef)) : null,
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
  return { recentDecisions, pickupCtx, reviewRows, ...activityReads(r, recentDecisions) };
}

function activityReads(r: VerdictReadsOn, recentDecisions: () => Decision[]) {
  const { store, connector, world, tasks, proposals, appraisals, issueRuns, withheld, bugFilings, humanTasks } = r;
  const { wirePlans } = r;
  const worldEvents = store.world.listWorldEvents(100);
  // The Decision log persists the whole action, and a `propose_plan` action carries
  // the plan's narrative in its prompt and its diagnosis and approach in its detail.
  // The inbox redacts the escalation and the proposal built from that same action, so
  // an unredacted shift log would be the body arriving by the one door left open.
  const shiftLog = recentDecisions()
    .slice(0, 100)
    .map((d) => {
      const row = { ...d, subjectRef: decisionSubjectRef(d.action) };
      if (!withheld((d.action as { planId?: unknown }).planId)) return row;
      return { ...row, detail: WITHHELD_PLAN, action: withheldAction(d.action) };
    });
  const refUrls = buildRefUrls({
    pullRequests: [...world.pullRequests, ...(world.closedPullRequests ?? []), ...r.archivedPullRequests],
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
  return { worldEvents, shiftLog, refUrls };
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
