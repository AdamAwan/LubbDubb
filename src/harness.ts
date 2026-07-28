import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { Heartbeat } from './heartbeat.js';
import type { Store } from './store/store.js';
import type { Connector } from './connector/connector.js';
import type { Dispatcher, QueueItem } from './dispatcher/dispatcher.js';
import type { ActionExecutor, ExecutionSummary } from './executor/actionExecutor.js';
import type { ErrorRecorder } from './errorLog.js';
import type { RuntimeControl } from './runtimeControl.js';
import { diffWorlds } from './world/worldDiff.js';
import { isPrExcluded } from './prHealth.js';
import { rejectionSignalQuery } from './proposals/proposals.js';
import type { PlanReconciler } from './plans/planReconciler.js';
import type { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import type { Action, Task, WorldEvent, WorldSnapshot } from './types.js';

interface HarnessDeps {
  store: Store;
  connector: Connector;
  dispatcher: Dispatcher;
  executor: ActionExecutor;
  heartbeatIntervalMs: number;
  /** Central error sink: a cycle exception is recorded here, never thrown away. */
  errors: ErrorRecorder;
  /** Live cap + pause flag, read by reference each cycle (never a frozen copy). */
  runtime: RuntimeControl;
  steeringPriorities: string[];
  /** PRs carrying this label (`${labelPrefix}-ignore`) are excluded from dispatch (the operator's "leave it alone" tag). */
  prIgnoreLabel: string;
  /** How long an operator "Up next" priority override survives after its origin stops being tracked (issue #128; 0 disables pruning). */
  upNextOverrideTtlMs: number;
  /**
   * Folds git + provider reality onto the plan-part rows, next to the world diff.
   * Absent = no plan tracking (and it no-ops anyway with the funnel off).
   */
  plans?: PlanReconciler;
  /**
   * Writes the durable work graph each pulse. Absent = no graph (tests that do not
   * care). Stage 1 is a lens: nothing reads what it writes.
   */
  graph?: WorkGraphRecorder;
  /**
   * The crash-recovery gate: how many agents orphaned by the previous run are
   * still waiting on an operator's verdict. Any at all holds the pulse — see
   * {@link Harness.runCycle}.
   */
  recovery?: { pendingCount(): number };
}

/**
 * The last cycle's ordered pickup plan (issue #69) — "what's next as of this
 * pulse". A projection recomputed every cycle, not a persisted queue; `at` is
 * the world snapshot it was planned against.
 */
interface UpcomingPlan {
  cycleId: string;
  at: string;
  items: QueueItem[];
}

interface CycleReport {
  cycleId: string;
  source: 'timer' | 'manual' | 'boot';
  rationale: string;
  summary: ExecutionSummary;
  at: string;
}

/**
 * The heart of the system: each pulse takes a snapshot of the world and the
 * fleet, asks the dispatcher what to do, and runs the result through the
 * executor. It records the dispatcher's free-form rationale to the audit log so
 * every cycle — even an idle one — is explainable after the fact.
 */
interface HarnessEvents {
  'cycle:start': [{ cycleId: string; source: string }];
  'cycle:end': [CycleReport];
  'world:events': [{ events: WorldEvent[] }];
}

export class Harness extends EventEmitter {
  private readonly heartbeat: Heartbeat;
  private cycleInFlight = false;
  // Last snapshot we diffed against. Seeded from the persisted baseline on the
  // first cycle so a restart doesn't re-emit the whole world as "new".
  private prevWorld: WorldSnapshot | null = null;
  // The last cycle's ranked pickup plan, cached for the state snapshot. Null
  // until a cycle runs, or when the dispatcher reports no plan (LLM dispatcher).
  private lastPlan: UpcomingPlan | null = null;

  /** The "Up next" queue from the last pulse, for `/api/state`. */
  get upcoming(): UpcomingPlan | null {
    return this.lastPlan;
  }

  constructor(private readonly deps: HarnessDeps) {
    super();
    this.heartbeat = new Heartbeat(deps.heartbeatIntervalMs, async (source) => {
      await this.runCycle(source);
    });
  }

  start(): void {
    this.heartbeat.start();
  }

  stop(): void {
    this.heartbeat.stop();
  }

  async runCycle(source: 'timer' | 'manual' | 'boot' = 'manual'): Promise<CycleReport> {
    // The crash-recovery hold, asked before anything else — including the world
    // fetch, which is the point: while agents orphaned by the last run are
    // undecided, the harness's own model of its fleet is wrong (rows saying
    // `running` with no process behind them), so *every* verdict a pulse would
    // reach is reached against a fiction, not just the dispatch ones. Work already
    // in flight gets its decision before anything new is queued in front of it.
    //
    // Held rather than stopped: the timer keeps ticking and this is re-asked each
    // beat, so the pulse resumes on its own the moment the last decision lands —
    // no restart, and no separate "un-hold" anyone has to remember to call. The
    // shape mirrors the coalesced return below, and emits nothing for the same
    // reason: no cycle ran.
    const awaiting = this.deps.recovery?.pendingCount() ?? 0;
    if (awaiting > 0) {
      const rationale = `held: ${awaiting} agent(s) from the previous run await a recovery decision`;
      return {
        cycleId: 'held',
        source,
        rationale,
        summary: { cycleId: 'held', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    if (this.cycleInFlight) {
      return {
        cycleId: 'coalesced',
        source,
        rationale: 'cycle already running',
        summary: { cycleId: 'coalesced', executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
    }
    this.cycleInFlight = true;
    const cycleId = `cyc_${nanoid(8)}`;
    this.emit('cycle:start', { cycleId, source });
    try {
      const { store } = this.deps;
      const world = await this.deps.connector.getState();
      this.recordWorldChanges(store, world);
      // Fold observed reality onto the plan-part rows before anything reads them:
      // the store holds intent, the outside world stays the source of truth, and a
      // part this moves to `ready` is dispatchable in this same cycle.
      await this.deps.plans?.reconcile(world);
      // Record what the world and the store now say happened, after the reconciler
      // so part→PR observations are fresh, and before `decide` so stage 2 can read
      // it. Never deleting is the point: `closedPullRequests` forgets a merge after
      // `closedPrWindowMs` and the graph must not.
      this.deps.graph?.record(world);
      const tasks = store.listTasks();
      const agents = store.listAgents();
      const openEscalations = store.listOpenEscalations();
      const queuedJobs = store.listQueuedJobs();
      // The plan funnel's memory: which issues already have a verdict, so a planner
      // never re-runs and pickup only fires for the ones that resolved to `single`.
      const plans = store.listPlans();
      const planParts = store.listAllPlanParts();
      // Who said an issue is finished. Small (one row per concluded issue) and
      // unbounded in age on purpose: a verdict that aged out of a window would
      // have the harness re-pick work someone already declared done.
      const conclusions = store.listIssueConclusions();
      const recentDecisions = store.listDecisions(200);
      // Acts already put to a human: a rule that proposed one holds off while the
      // verdict stands, so one question is asked once (issue #109).
      const proposals = store.listProposals();
      // What ends a rejection's standing: anything observed on the item it
      // concerns since it was given (phase 4). The query is derived from the
      // rejections themselves, so it costs a read only once one exists — and the
      // executor asks the same question off the same predicate, since a hold the
      // two disagreed about would have the rule dispatch a merge the executor
      // then skips.
      const signals = rejectionSignalQuery(proposals);
      const rejectionSignals = signals ? store.listWorldEventsSince(signals.since, signals.refs) : [];
      // Operator "Up next" re-ordering (issue #128), keyed on candidate origin,
      // so it re-orders the ranking without persisting the projection itself.
      const priorityOverrides = store.listPriorityOverrides();
      // While paused, advertise zero headroom so the dispatcher plans no new
      // dispatches; the executor also hard-defers them (belt and braces).
      const headroom = this.deps.runtime.paused ? 0 : Math.max(0, this.deps.runtime.cap - store.countLiveAgents());

      // A PR carrying the exclusion tag is the operator's "leave this alone"
      // signal. Hide tagged PRs from the dispatch view so *both* dispatchers
      // ignore them uniformly — no CI fix, base update, comment note, or merge.
      // The world used for diffing/baseline above is untouched, and the cockpit
      // snapshot reads the connector directly, so an excluded PR stays fully
      // visible (with its health and tag) — it's just not acted on.
      const label = this.deps.prIgnoreLabel;
      const excludedPrs = world.pullRequests.filter((pr) => isPrExcluded(pr, label));
      const dispatchWorld: WorldSnapshot =
        excludedPrs.length > 0
          ? { ...world, pullRequests: world.pullRequests.filter((pr) => !isPrExcluded(pr, label)) }
          : world;

      const plan = await this.deps.dispatcher.decide({
        world: dispatchWorld,
        // Hidden from dispatch, but still open — the issue-pickup gate has to see
        // them or an ignored PR reads as merged and its issue gets a second agent.
        excludedPrs,
        tasks,
        agents,
        openEscalations,
        queuedJobs,
        plans,
        planParts,
        conclusions,
        recentDecisions,
        proposals,
        rejectionSignals,
        priorityOverrides,
        steeringPriorities: this.deps.steeringPriorities,
        agentHeadroom: headroom,
      });

      this.lastPlan = plan.upcoming ? { cycleId, at: world.takenAt, items: plan.upcoming } : null;

      // Keep the override set from lingering: an origin still tracked this pulse
      // (queued/waiting/held in the plan, or staffed by an active task) has its
      // override refreshed; one gone longer than the TTL is pruned. Reading the
      // plan and the active tasks together means a long-staffed item keeps its
      // priority even while it is absent from the ranked queue.
      const trackedOrigins = new Set<string>((plan.upcoming ?? []).map((i) => i.origin));
      for (const t of tasks) if (isActiveTask(t) && t.originRef) trackedOrigins.add(t.originRef);
      store.reconcilePriorityOverrides([...trackedOrigins], this.deps.upNextOverrideTtlMs);

      // The dispatcher's reasoning is itself an audit record.
      store.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'cycle rationale' } as Action,
        outcome: 'skipped',
        detail: `[${source}] ${plan.rationale}`,
      });

      const summary = await this.deps.executor.execute(cycleId, plan);
      const report: CycleReport = { cycleId, source, rationale: plan.rationale, summary, at: new Date().toISOString() };
      this.emit('cycle:end', report);
      return report;
    } catch (err) {
      // A throw anywhere in the cycle must not vanish as an unhandled rejection
      // (timer cycles run via `void fire('timer')`). Record it, report the cycle
      // as failed, and let the next pulse try again.
      this.deps.errors.record({
        source: 'cycle',
        message: `Cycle ${cycleId} (${source}) failed: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
      const report: CycleReport = {
        cycleId,
        source,
        rationale: `cycle failed: ${(err as Error).message}`,
        summary: { cycleId, executed: 0, deferred: 0, rejected: 0 },
        at: new Date().toISOString(),
      };
      this.emit('cycle:end', report);
      return report;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * Diff this cycle's world against the previous snapshot, persist every observed
   * transition, and stream them to the cockpit. The very first cycle over a fresh
   * store has no baseline → it only records the baseline (no diff, no spurious
   * "everything is new" flood).
   */
  private recordWorldChanges(store: HarnessDeps['store'], world: WorldSnapshot): void {
    const prev = this.prevWorld ?? store.getWorldBaseline();
    if (prev) {
      const changes = diffWorlds(prev, world);
      if (changes.length) {
        const events = store.recordWorldEvents(changes);
        this.emit('world:events', { events });
      }
    }
    this.prevWorld = world;
    store.setWorldBaseline(world);
  }

  // Typed emit/on overrides for a nicer call site (repo convention).
  override emit<K extends keyof HarnessEvents>(event: K, ...args: HarnessEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HarnessEvents>(event: K, listener: (...args: HarnessEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

/** A task the fleet is still working — the dispatcher excludes its origin from the ranked queue. */
function isActiveTask(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}
