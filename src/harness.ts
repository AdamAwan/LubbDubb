import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { Heartbeat } from './heartbeat.js';
import type { Store } from './store/store.js';
import type { Connector } from './connector/connector.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import type { ActionExecutor, ExecutionSummary } from './executor/actionExecutor.js';
import type { ErrorRecorder } from './errorLog.js';
import type { RuntimeControl } from './runtimeControl.js';
import { diffWorlds } from './world/worldDiff.js';
import { buildReadPlan, type ReadLanes } from './world/readPlan.js';
import { awaitingReview, isPrWatched } from './prHealth.js';
import { isSomeoneElsesPr } from './prOwnership.js';

import { rejectionSignalQuery } from './proposals/proposals.js';
import { deliverySignalQuery } from './delivery/delivery.js';
import { retainedRunIssues, runsToRecord } from './floor/runs.js';
import type { AgentModels } from './agents/modelPolicy.js';
import type { LimitResumeFailure } from './agents/agentManager.js';
import type { PlanReconciler } from './plans/planReconciler.js';
import type { AppraisalDesk } from './intake/appraisalDesk.js';
import type { AreaPathDirectory } from './intake/areaPaths.js';
import type { PrNamingDesk } from './prNamingDesk.js';
import type { PrWatchDesk } from './prWatchDesk.js';
import type { PrWorkItemDesk } from './prWorkItemDesk.js';
import type { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import type { ValidationAskDesk } from './validation/askDesk.js';
import type { ValidationReadyDesk } from './validation/readyDesk.js';
import type { SpendBurnDesk } from './spendBurnDesk.js';
import type { RunwayDesk } from './supply/runwayDesk.js';
import type { IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from './dispatcher/dispatchCooldown.js';
import type { BranchReapDesk } from './branchReapDesk.js';
import type { EnvironmentDesk } from './environments/environmentDesk.js';
import type { ScheduleDesk } from './schedules/scheduleDesk.js';
import type { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import type { Action, PullRequest, WorldEvent, WorldSnapshot } from './types.js';
import { applyThreadReopens } from './prThreads.js';
import type { UpcomingPlan } from './wire.js';
import { isActiveTask } from './tasks.js';
import type { StackLandingDesk } from './stacks/landingDesk.js';
import type { PoolDesk } from './pool/poolDesk.js';
import type { PrReviewPolicy } from './review/policy.js';
import { needsFleetReview, reviewReading } from './review/prReview.js';
import type { ReviewProber } from './review/reviewedElsewhere.js';

// → docs/spec/04-harness-cycle.md

const PRIOR_REMEDY_ROWS = 40;

const READ_PLAN_EVENTS = 200;

interface HarnessDeps {
  store: Store;
  connector: Connector;
  dispatcher: Dispatcher;
  executor: ActionExecutor;
  heartbeatIntervalMs: number;
  idleHeartbeatIntervalMs: number;
  readLanes: ReadLanes;
  errors: ErrorRecorder;
  runtime: RuntimeControl;
  prWatchLabel: string;
  review: PrReviewPolicy;
  reviewProber?: ReviewProber;
  modelPins?: { labelPrefix: string; models: AgentModels };
  featureStandings?: () => { number: number; title: string; key: string }[];
  upNextOverrideTtlMs: number;
  plans?: PlanReconciler;
  appraisals?: AppraisalDesk;
  areaPaths?: AreaPathDirectory;
  naming?: PrNamingDesk;
  prWatch?: PrWatchDesk;
  prWorkItems?: PrWorkItemDesk;
  closeOuts?: DeliveryCloseOutDesk;
  validationAsks?: ValidationAskDesk;
  validationReady?: ValidationReadyDesk;
  burn?: SpendBurnDesk;
  runway?: RunwayDesk;
  issuePickup?: IssuePickupPolicy;
  branchReaps?: BranchReapDesk;
  environments?: EnvironmentDesk;
  schedules?: ScheduleDesk;
  landings?: StackLandingDesk;
  graph?: WorkGraphRecorder;
  tickets?: { run(): Promise<void> };
  localRun?: { noteAlive(): void };
  localValidations?: { sweep(): void };
  updates?: { run(): Promise<void> };
  recovery?: { pendingCount(): number };
  fleet?: { resumeExpiredParks(): LimitResumeFailure[]; completeExpiredStalls(): string[] };
  notices?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  graduations?: { run(): void };
  clusters?: { run(): void };
  obstacleNotices?: { run(): void };
  obstacleVoice?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  obstacleDesk?: { run(): Promise<void> };
  obstacleOwnership?: { run(world: WorldSnapshot): Promise<void> };
  obstacleEndings?: { run(world: WorldSnapshot): void };
  pool?: PoolDesk;
  ejections?: { sweepExpiries(): unknown[] };
  escalations?: { tidyDeadAgents(): unknown[]; tidySettledMerges(): unknown[] };
  freshReads?: { drain(): string[] };
}

type CycleSource = 'timer' | 'manual' | 'boot' | 'local' | 'ingress';

export interface CycleReport {
  cycleId: string;
  source: CycleSource;
  readWorld: boolean;
  nextIntervalMs: number;
  rationale: string;
  summary: ExecutionSummary;
  at: string;
}

export function cycleRan(report: CycleReport): boolean {
  return report.cycleId.startsWith('cyc_');
}

interface HarnessEvents {
  'cycle:start': [{ cycleId: string; source: string }];
  'cycle:end': [CycleReport];
  'world:events': [{ events: WorldEvent[] }];
}

export class Harness extends EventEmitter {
  private readonly heartbeat: Heartbeat;
  private cycleInFlight = false;
  private pendingManual = false;
  private stopped = false;
  private prevWorld: WorldSnapshot | null = null;
  private lastPlan: UpcomingPlan | null = null;

  get upcoming(): UpcomingPlan | null {
    return this.lastPlan;
  }

  constructor(private readonly deps: HarnessDeps) {
    super();
    this.heartbeat = new Heartbeat(
      () => this.intervalMs(),
      async (source) => {
        await this.runCycle(source);
      },
    );
  }

  private busy = true;

  private intervalMs(): number {
    const { heartbeatIntervalMs, idleHeartbeatIntervalMs } = this.deps;
    return this.busy ? heartbeatIntervalMs : Math.max(idleHeartbeatIntervalMs, heartbeatIntervalMs);
  }

  start(): void {
    this.heartbeat.start();
  }

  stop(): void {
    this.stopped = true;
    this.pendingManual = false;
    this.heartbeat.stop();
  }

  async runCycle(source: CycleSource = 'manual'): Promise<CycleReport> {
    this.deps.localRun?.noteAlive();
    const awaiting = this.deps.recovery?.pendingCount() ?? 0;
    if (awaiting > 0) {
      const rationale = `held: ${awaiting} agent(s) from the previous run await a recovery decision`;
      return {
        cycleId: 'held',
        source,
        readWorld: false,
        nextIntervalMs: this.intervalMs(),
        rationale,
        summary: { cycleId: 'held', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    if (this.cycleInFlight) {
      if (source === 'manual') this.pendingManual = true;
      return {
        cycleId: 'coalesced',
        source,
        readWorld: false,
        nextIntervalMs: this.intervalMs(),
        rationale: 'cycle already running',
        summary: { cycleId: 'coalesced', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    const cached = source === 'local' ? (this.prevWorld ?? this.deps.store.getWorldBaseline()) : null;
    if (source === 'local' && cached === null) {
      return {
        cycleId: 'unbaselined',
        source,
        readWorld: false,
        nextIntervalMs: this.intervalMs(),
        rationale:
          "no world baseline: a local cycle decides against the last real cycle's reading, and there is none yet",
        summary: { cycleId: 'unbaselined', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    const readWorld = cached === null;
    this.cycleInFlight = true;
    const cycleId = `cyc_${nanoid(8)}`;
    this.emit('cycle:start', { cycleId, source });
    try {
      const { store } = this.deps;
      const readPlan = readWorld
        ? buildReadPlan({
            previous: this.prevWorld ?? store.getWorldBaseline(),
            tasks: store.listTasks(),
            events: store.listWorldEvents(READ_PLAN_EVENTS),
            now: Date.now(),
            lanes: this.deps.readLanes,
            fresh: this.deps.freshReads?.drain(),
          })
        : undefined;
      const observed = cached ?? (await this.deps.connector.getState(readPlan));
      const previousWorld = readWorld ? (this.prevWorld ?? store.getWorldBaseline()) : observed;
      if (readWorld) this.recordWorldChanges(store, observed, previousWorld);
      const world = applyThreadReopens(observed, store.prThreadReopens());
      if (readWorld) await this.deps.plans?.reconcile(world);
      if (readWorld) await this.deps.prWatch?.run(world);
      if (readWorld) await this.deps.prWorkItems?.run(world);
      if (readWorld) await this.deps.naming?.run(world);
      if (readWorld) await this.deps.branchReaps?.run(world);
      this.deps.landings?.settle(world);
      this.deps.validationAsks?.run();
      this.deps.validationReady?.run(world);
      this.deps.closeOuts?.run(world);
      this.deps.schedules?.run();
      if (readWorld) await this.deps.updates?.run();
      this.deps.graph?.record(world);
      if (readWorld) await this.deps.environments?.run(world);
      if (readWorld) this.deps.notices?.run(previousWorld, world);
      this.deps.graduations?.run();
      this.deps.clusters?.run();
      if (readWorld) this.deps.obstacleVoice?.run(previousWorld, world);
      void this.deps.obstacleDesk?.run();
      this.deps.obstacleNotices?.run();
      await this.deps.obstacleOwnership?.run(world);
      if (readWorld) this.deps.obstacleEndings?.run(world);
      if (readWorld) await this.deps.pool?.run();
      for (const { agentId, error } of this.deps.fleet?.resumeExpiredParks() ?? [])
        this.deps.errors.record({
          source: 'agent',
          message: `Agent ${agentId} could not be resumed after its usage limit cleared; it stays parked`,
          detail: error,
        });
      this.deps.fleet?.completeExpiredStalls();
      this.deps.ejections?.sweepExpiries();
      const tasks = store.listTasks();
      store.foldReviewWaits(
        world.pullRequests
          .filter((pr) =>
            awaitingReview(
              pr,
              tasks.some((t) => isActiveTask(t) && t.branch === pr.branch),
            ),
          )
          .map((pr) => pr.number),
      );
      const agents = store.listAgents();
      this.deps.burn?.run({ agents, tasks });
      this.deps.escalations?.tidyDeadAgents();
      this.deps.escalations?.tidySettledMerges();
      const openEscalations = store.listOpenEscalations();
      const queuedJobs = store.listQueuedJobs();
      const standingJobs = store.listStandingJobs();
      const ejections = store.liveEjections();
      const plans = store.listPlans();
      const planParts = store.listAllPlanParts();
      const conclusions = store.listIssueConclusions();
      const deliveries = store.listDeliveries();
      const deliveryWindow = deliverySignalQuery(deliveries);
      const shortfalls = store.listShortfalls();
      const deliverySignals = deliveryWindow
        ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs)
        : [];
      const appraisals = store.listAppraisals();
      if (readWorld) await this.deps.appraisals?.announce(world);
      if (readWorld) await this.deps.areaPaths?.refresh();
      const retrospectiveOrigins = store.listRetrospectiveOrigins();
      try {
        for (const r of runsToRecord(world.issues, tasks, {
          retrospectiveOrigins,
          conclusions,
          deliveries,
          shortfalls,
          plans,
          planParts: store.listAllPlanParts(),
        }))
          store.recordIssueRun(r);
      } catch (err) {
        this.deps.errors.record({
          source: 'cycle',
          message: `Recording issue runs failed: ${(err as Error).message}`,
          detail: (err as Error).stack ?? null,
        });
      }
      const recentDecisions = store.listDecisions(200);
      const proposals = store.listProposals();
      const signals = rejectionSignalQuery(proposals);
      const rejectionSignals = signals ? store.listWorldEventsSince(signals.since, signals.refs) : [];
      const priorityOverrides = store.listPriorityOverrides();
      const goalPriorities = store.listGoalPriorities();
      const goalPauses = store.listGoalPauses();
      const profileOverrides = store.listProfileOverrides();
      const liveAgents = store.countLiveAgents();
      const headroom = this.deps.runtime.paused ? 0 : Math.max(0, this.deps.runtime.cap - liveAgents);

      const label = this.deps.prWatchLabel;
      const actedOn = (pr: PullRequest): boolean => isPrWatched(pr, label) && !isSomeoneElsesPr(pr);
      const hiddenPrs = world.pullRequests.filter((pr) => !actedOn(pr));

      const retainedIssues = retainedRunIssues(store.listIssueRuns(), world.issues);
      const dispatchWorld: WorldSnapshot =
        hiddenPrs.length > 0 || retainedIssues.length > 0
          ? {
              ...world,
              pullRequests: world.pullRequests.filter(actedOn),
              issues: [...world.issues, ...retainedIssues],
            }
          : world;

      const featureStandings = this.deps.featureStandings?.() ?? [];
      const featureSummaryKeys =
        featureStandings.length === 0
          ? []
          : store.listFeatureSummaries().map((f) => ({ originRef: f.originRef, standingKey: f.standingKey }));

      if (readWorld) await this.askReviewedElsewhere(store, dispatchWorld);

      this.deps.localValidations?.sweep();

      const plan = await this.deps.dispatcher.decide({
        world: dispatchWorld,
        retainedIssues: retainedIssues.map((i) => i.number),
        hiddenPrs,
        tasks,
        agents,
        openEscalations,
        queuedJobs,
        standingJobs,
        ejections,
        plans,
        planParts,
        planAtoms: store.listAllPlanAtoms(),
        planAmendments: store.listPendingPlanAmendments(),
        validationChecks: store.listAllValidationChecks(),
        localRun: store.liveLocalRun(),
        localValidations: [...store.listOpenLocalValidations(), ...store.listLocalValidationsAwaitingFix()],
        conclusions,
        deliveries,
        deliverySignals,
        shortfalls,
        appraisals,
        retrospectiveOrigins,
        featureStandings,
        featureSummaryKeys,
        featureSequences: store.listFeatureSequences(),
        recentDecisions,
        proposals,
        rejectionSignals,
        priorityOverrides,
        goalPriorities,
        goalPauses,
        profileOverrides,
        priorRemedies: [
          ...store.listRecentRemedies('ci', PRIOR_REMEDY_ROWS),
          ...store.listRecentRemedies('review', PRIOR_REMEDY_ROWS),
        ],
        prReviews: store.listPrReviews(),
        prReviewRoutes: store.listPrReviewRoutes(),
        prSplits: store.listPrSplitVerdicts(),
        prReviewedElsewhere: store.prsReviewedElsewhere(),
        obstacles: store.obstacleBoard(),
        obstacleBlocks: store.listObstacleBlocks(),
        modelPins: this.deps.modelPins,
        agentHeadroom: headroom,
      });

      this.lastPlan = plan.upcoming ? { cycleId, at: world.takenAt, items: plan.upcoming } : null;

      const working = (plan.upcoming ?? []).some(
        (item) => item.status !== 'unapproved' && item.status !== 'superseded',
      );
      this.busy =
        liveAgents > 0 ||
        queuedJobs.length > 0 ||
        working ||
        world.pullRequests.some((pr) => pr.ciStatus === 'pending');

      const trackedOrigins = new Set<string>((plan.upcoming ?? []).map((i) => i.origin));
      for (const t of tasks) if (isActiveTask(t) && t.originRef) trackedOrigins.add(t.originRef);
      store.reconcilePriorityOverrides([...trackedOrigins], this.deps.upNextOverrideTtlMs);
      store.reconcileProfileOverrides([...trackedOrigins], this.deps.upNextOverrideTtlMs);

      if (this.deps.runway && this.deps.issuePickup)
        this.deps.runway.run({
          issues: world.issues,
          pickup: {
            policy: this.deps.issuePickup,
            cooldown: DEFAULT_COOLDOWN,
            now: world.takenAt,
            tasks,
            recentDecisions,
            openPrs: world.pullRequests,
            plans,
            planParts,
            deliveries,
            deliverySignals,
            appraisals,
            runs: store.listIssueRuns(),
            headroom,
            paused: this.deps.runtime.paused,
          },
          cap: this.deps.runtime.cap,
        });

      const stale = world.staleSources ?? [];
      const caveat = stale.length > 0 ? `[stale: ${stale.join(', ')}] ` : '';
      store.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'cycle rationale' } as Action,
        outcome: 'skipped',
        detail: `[${source}] ${caveat}${plan.rationale}`,
      });

      const summary = await this.deps.executor.execute(cycleId, plan);
      if (readWorld) await this.deps.tickets?.run();
      const report: CycleReport = {
        cycleId,
        source,
        readWorld,
        nextIntervalMs: this.intervalMs(),
        rationale: plan.rationale,
        summary,
        at: new Date().toISOString(),
      };
      this.emit('cycle:end', report);
      return report;
    } catch (err) {
      this.deps.errors.record({
        source: 'cycle',
        message: `Cycle ${cycleId} (${source}) failed: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
      const report: CycleReport = {
        cycleId,
        source,
        readWorld,
        nextIntervalMs: this.intervalMs(),
        rationale: `cycle failed: ${(err as Error).message}`,
        summary: { cycleId, executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
      this.emit('cycle:end', report);
      return report;
    } finally {
      this.cycleInFlight = false;
      if (this.pendingManual && !this.stopped) {
        this.pendingManual = false;
        void this.runCycle('manual');
      }
    }
  }

  private async askReviewedElsewhere(store: HarnessDeps['store'], world: WorldSnapshot): Promise<void> {
    const prober = this.deps.reviewProber;
    const command = this.deps.review.reviewedElsewhere;
    if (prober === undefined || command === null || command.trim() === '') return;
    const rows = {
      prReviews: new Map(store.listPrReviews().map((r) => [r.prNumber, r])),
      prReviewRoutes: new Map(store.listPrReviewRoutes().map((r) => [r.prNumber, r])),
      prReviewedElsewhere: store.prsReviewedElsewhere(),
    };
    for (const pr of world.pullRequests) {
      if (!needsFleetReview(pr, reviewReading(rows, pr.number), this.deps.review)) continue;
      const report = await prober.check(pr.number, command);
      if (report.verdict === 'reviewed') {
        store.recordPrReviewedElsewhere(pr.number, command);
        continue;
      }
      if (report.verdict === 'unknown') {
        this.deps.errors.record({
          source: 'cycle',
          message: `the review.reviewedElsewhere check for PR ${pr.number} said nothing: ${report.detail ?? 'no detail'}`,
        });
      }
    }
  }

  private recordWorldChanges(store: HarnessDeps['store'], world: WorldSnapshot, prev: WorldSnapshot | null): void {
    if (world.staleSources && world.staleSources.length > 0) return;
    if (prev) {
      const changes = diffWorlds(prev, world);
      if (changes.length) {
        const events = store.recordWorldEvents(changes);
        this.emit('world:events', { events });
      }
    }
    this.prevWorld = world;
    store.setWorldBaseline(world);
    store.archiveClosedPrs(world.closedPullRequests ?? []);
  }

  override emit<K extends keyof HarnessEvents>(event: K, ...args: HarnessEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HarnessEvents>(event: K, listener: (...args: HarnessEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
