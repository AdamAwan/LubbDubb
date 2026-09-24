import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { Heartbeat } from './heartbeat.js';
import type { Connector } from './connector/connector.js';
import type { Dispatcher } from './dispatcher/dispatcher.js';
import { buildDispatchInputs } from './dispatcher/dispatchInputs.js';
import type { ActionExecutor, ExecutionSummary } from './executor/actionExecutor.js';
import type { RuntimeControl } from './runtimeControl.js';
import { diffWorlds } from './world/worldDiff.js';
import { buildReadPlan, type ReadLanes } from './world/readPlan.js';
import { isPrWatched } from './pr/prHealth.js';
import { isSomeoneElsesPr } from './pr/prOwnership.js';

import { deliverySignalQuery } from './delivery/delivery.js';
import { retainedRunIssues } from './floor/runs.js';
import type { AgentModels } from './agents/modelPolicy.js';
import type { RunwayDesk } from './supply/runwayDesk.js';
import type { IssuePickupPolicy } from './dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from './dispatcher/dispatchCooldown.js';
import type { Action, PullRequest, RemoteRunBrief, WorldEvent, WorldSnapshot } from './types.js';
import { applyThreadReopens } from './pr/prThreads.js';
import { runPulse, type PulseDeps, type PulsePhase } from './pulseDesks.js';
import type { UpcomingPlan } from './wire.js';
import { isActiveTask } from './tasks.js';
import type { GoalIntake } from './intake/sitting.js';

// → docs/spec/04-harness-cycle.md

const READ_PLAN_EVENTS = 200;

/**
 * How long a cycle may be in flight before the watchdog calls it stuck: whichever is longer of ten
 * heartbeats and five minutes. → docs/spec/04-harness-cycle.md#when-a-cycle-does-not-come-back
 */
const STUCK_CYCLE_HEARTBEATS = 10;
const STUCK_CYCLE_FLOOR_MS = 5 * 60_000;

interface HarnessDeps extends PulseDeps {
  connector: Connector;
  dispatcher: Dispatcher;
  executor: ActionExecutor;
  heartbeatIntervalMs: number;
  idleHeartbeatIntervalMs: number;
  readLanes: ReadLanes;
  /** Overrides the derived stuck-cycle threshold. Injected by tests; nothing else sets it. */
  stuckCycleAfterMs?: number;
  runtime: RuntimeControl;
  prWatchLabel: string;
  modelPins?: { labelPrefix: string; models: AgentModels };
  featureStandings?: () => { number: number; title: string; key: string }[];
  upNextOverrideTtlMs: number;
  runway?: RunwayDesk;
  issuePickup?: IssuePickupPolicy;
  localRun?: { noteAlive(): void };
  remoteRuns?: () => RemoteRunBrief[];
  /** → docs/spec/08-planning.md#the-intake-sitting-stands-in-front-of-the-planner */
  goalIntake?: () => GoalIntake;
  recovery?: { pendingCount(): number };
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

export interface CycleStanding {
  cycleId: string;
  source: CycleSource;
  startedAt: string;
  elapsedMs: number;
  where: string;
  overdue: boolean;
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
  private inFlight: {
    cycleId: string;
    source: CycleSource;
    startedMs: number;
    where: string;
    watchdog: NodeJS.Timeout | null;
  } | null = null;
  private pendingManual = false;
  private stopped = false;
  private prevWorld: WorldSnapshot | null = null;
  private lastPlan: UpcomingPlan | null = null;

  get upcoming(): UpcomingPlan | null {
    return this.lastPlan;
  }

  /**
   * The cycle in flight, if there is one, and where in it the harness is sitting. Null between
   * cycles. → docs/spec/04-harness-cycle.md#when-a-cycle-does-not-come-back
   *
   * @public — read by the `fleet_status` MCP tool.
   */
  get inFlightCycle(): CycleStanding | null {
    const flight = this.inFlight;
    if (!flight) return null;
    const elapsedMs = Date.now() - flight.startedMs;
    return {
      cycleId: flight.cycleId,
      source: flight.source,
      startedAt: new Date(flight.startedMs).toISOString(),
      elapsedMs,
      where: flight.where,
      overdue: elapsedMs >= this.stuckAfterMs(),
    };
  }

  private stuckAfterMs(): number {
    return (
      this.deps.stuckCycleAfterMs ??
      Math.max(this.deps.heartbeatIntervalMs * STUCK_CYCLE_HEARTBEATS, STUCK_CYCLE_FLOOR_MS)
    );
  }

  private at(where: string): void {
    if (this.inFlight) this.inFlight.where = where;
  }

  private markPass(phase: PulsePhase): (pass: string | null) => void {
    return (pass) => this.at(pass === null ? `the ${phase} phase` : `pass "${pass}" of the ${phase} phase`);
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

  /**
   * Whether the harness is on its own clock. Between-cycles work — warming a worktree slot for the
   * queue — has nowhere to happen without it: a single `runCycle` has no "between".
   *
   * @public — read by the prewarm desk's gate in {@link buildSystem}.
   */
  get running(): boolean {
    return this.onClock;
  }

  private onClock = false;

  start(): void {
    this.onClock = true;
    this.heartbeat.start();
  }

  stop(): void {
    this.onClock = false;
    this.stopped = true;
    this.pendingManual = false;
    this.heartbeat.stop();
  }

  /**
   * A cycle that never returns takes the heartbeat with it: `Heartbeat` re-arms its timer only once
   * `onTick` settles, so nothing else is left to notice. The watchdog is the one thing that still
   * fires. → docs/spec/04-harness-cycle.md#when-a-cycle-does-not-come-back
   */
  private armWatchdog(): void {
    const flight = this.inFlight;
    if (!flight) return;
    const afterMs = this.stuckAfterMs();
    flight.watchdog = setTimeout(() => {
      flight.watchdog = null;
      if (this.inFlight !== flight) return;
      this.deps.errors.record({
        source: 'cycle',
        message:
          `Cycle ${flight.cycleId} (${flight.source}) has not returned after ${Math.round(afterMs / 1000)}s — ` +
          `it is stuck at ${flight.where}. No cycle can start behind it, so nothing is being dispatched.`,
        detail: null,
      });
    }, afterMs);
    flight.watchdog.unref?.();
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
      const standing = this.inFlightCycle;
      return {
        cycleId: 'coalesced',
        source,
        readWorld: false,
        nextIntervalMs: this.intervalMs(),
        rationale:
          standing?.overdue === true
            ? `cycle ${standing.cycleId} has been running for ${Math.round(standing.elapsedMs / 1000)}s at ${standing.where}`
            : 'cycle already running',
        summary: { cycleId: 'coalesced', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    const cached = source === 'local' ? (this.prevWorld ?? this.deps.store.world.getWorldBaseline()) : null;
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
    this.inFlight = { cycleId, source, startedMs: Date.now(), where: 'starting', watchdog: null };
    this.armWatchdog();
    this.emit('cycle:start', { cycleId, source });
    try {
      const { store } = this.deps;
      const readPlan = readWorld
        ? buildReadPlan({
            previous: this.prevWorld ?? store.world.getWorldBaseline(),
            tasks: store.tasks.listTasks(),
            events: store.world.listWorldEvents(READ_PLAN_EVENTS),
            now: Date.now(),
            lanes: this.deps.readLanes,
            fresh: this.deps.freshReads?.drain(),
          })
        : undefined;
      this.at('reading the world');
      const observed = cached ?? (await this.deps.connector.getState(readPlan));
      const previousWorld = readWorld ? (this.prevWorld ?? store.world.getWorldBaseline()) : observed;
      if (readWorld) this.recordWorldChanges(store, observed, previousWorld);
      const world = applyThreadReopens(observed, store.threadReopens.prThreadReopens());
      await runPulse(
        'reconcile',
        this.deps,
        { world, previousWorld, readWorld },
        readWorld,
        this.markPass('reconcile'),
      );
      await runPulse('open', this.deps, {}, readWorld, this.markPass('open'));
      const tasks = store.tasks.listTasks();
      await runPulse('afterTasks', this.deps, { world, tasks }, readWorld, this.markPass('afterTasks'));
      const agents = store.agents.listAgents();
      await runPulse('afterAgents', this.deps, { tasks, agents }, readWorld, this.markPass('afterAgents'));
      const queuedJobs = store.jobs.listQueuedJobs();
      const plans = store.plans.listPlans();
      const planParts = store.plans.listAllPlanParts();
      const conclusions = store.verdicts.listIssueConclusions();
      const deliveries = store.verdicts.listDeliveries();
      const deliveryWindow = deliverySignalQuery(deliveries);
      const shortfalls = store.verdicts.listShortfalls();
      const deliverySignals = deliveryWindow
        ? store.world.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs)
        : [];
      const appraisals = store.verdicts.listAppraisals();
      await runPulse('afterVerdicts', this.deps, { world }, readWorld, this.markPass('afterVerdicts'));
      const retrospectiveOrigins = store.scratch.listRetrospectiveOrigins();
      await runPulse(
        'afterOrigins',
        this.deps,
        { world, tasks, signals: { retrospectiveOrigins, conclusions, deliveries, shortfalls, plans, planParts } },
        readWorld,
        this.markPass('afterOrigins'),
      );
      const recentDecisions = store.decisions.listDecisions(200);
      const intake = this.deps.goalIntake?.() ?? { closedSittings: null, criteria: [] };
      const liveAgents = store.agents.countLiveAgents();
      const headroom = this.deps.runtime.paused ? 0 : Math.max(0, this.deps.runtime.cap - liveAgents);

      const label = this.deps.prWatchLabel;
      const actedOn = (pr: PullRequest): boolean => isPrWatched(pr, label) && !isSomeoneElsesPr(pr);
      const hiddenPrs = world.pullRequests.filter((pr) => !actedOn(pr));

      const issueRuns = store.floor.listIssueRuns();
      const retainedIssues = retainedRunIssues(issueRuns, world.issues);
      const dispatchWorld: WorldSnapshot =
        hiddenPrs.length > 0 || retainedIssues.length > 0
          ? {
              ...world,
              pullRequests: world.pullRequests.filter(actedOn),
              issues: [...world.issues, ...retainedIssues],
            }
          : world;

      const featureStandings = this.deps.featureStandings?.() ?? [];

      const prReviews = store.prReviews.listPrReviews();
      const prReviewRoutes = store.prReviewRoutes.listPrReviewRoutes();
      await runPulse(
        'afterReviews',
        this.deps,
        { dispatchWorld, prReviews, prReviewRoutes },
        readWorld,
        this.markPass('afterReviews'),
      );

      this.at('the dispatch decision');
      const plan = await this.deps.dispatcher.decide(
        buildDispatchInputs(store, {
          world: dispatchWorld,
          retainedIssues: retainedIssues.map((i) => i.number),
          hiddenPrs,
          tasks,
          agents,
          queuedJobs,
          plans,
          planParts,
          conclusions,
          deliveries,
          deliverySignals,
          shortfalls,
          appraisals,
          retrospectiveOrigins,
          recentDecisions,
          prReviews,
          prReviewRoutes,
          featureStandings,
          remoteRuns: this.deps.remoteRuns?.() ?? [],
          modelPins: this.deps.modelPins,
          agentHeadroom: headroom,
          closedSittings: intake.closedSittings,
          goalCriteria: intake.criteria,
        }),
      );

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
      store.priority.reconcilePriorityOverrides([...trackedOrigins], this.deps.upNextOverrideTtlMs);
      store.profileOverrides.reconcileProfileOverrides([...trackedOrigins], this.deps.upNextOverrideTtlMs);

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
            closedSittings: intake.closedSittings,
            runs: issueRuns,
            headroom,
            paused: this.deps.runtime.paused,
          },
          cap: this.deps.runtime.cap,
        });

      const stale = world.staleSources ?? [];
      const caveat = stale.length > 0 ? `[stale: ${stale.join(', ')}] ` : '';
      store.decisions.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'cycle rationale' } as Action,
        outcome: 'skipped',
        detail: `[${source}] ${caveat}${plan.rationale}`,
      });

      this.at('executing the plan');
      const summary = await this.deps.executor.execute(cycleId, plan);
      await runPulse('afterExecute', this.deps, {}, readWorld, this.markPass('afterExecute'));
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
      if (this.inFlight?.watchdog) clearTimeout(this.inFlight.watchdog);
      this.inFlight = null;
      this.cycleInFlight = false;
      if (this.pendingManual && !this.stopped) {
        this.pendingManual = false;
        void this.runCycle('manual');
      }
    }
  }

  private recordWorldChanges(store: HarnessDeps['store'], world: WorldSnapshot, prev: WorldSnapshot | null): void {
    if (world.staleSources && world.staleSources.length > 0) return;
    if (prev) {
      const changes = diffWorlds(prev, world);
      if (changes.length) {
        const events = store.world.recordWorldEvents(changes);
        this.emit('world:events', { events });
      }
    }
    this.prevWorld = world;
    store.world.setWorldBaseline(world);
    store.prArchive.archiveClosedPrs(world.closedPullRequests ?? []);
  }

  override emit<K extends keyof HarnessEvents>(event: K, ...args: HarnessEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HarnessEvents>(event: K, listener: (...args: HarnessEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
