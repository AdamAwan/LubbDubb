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
import { awaitingReview, isPrExcluded } from './prHealth.js';

import { rejectionSignalQuery } from './proposals/proposals.js';
import { deliverySignalQuery } from './delivery/delivery.js';
import { assaySignalQuery } from './intake/assay.js';
import { retainedRunIssues, runsToRecord } from './floor/runs.js';
import type { PlanReconciler } from './plans/planReconciler.js';
import type { AssayDesk } from './intake/assayDesk.js';
import type { PrNamingDesk } from './prNamingDesk.js';
import type { DeliveryCloseOutDesk } from './delivery/closeOutDesk.js';
import type { BranchReapDesk } from './branchReapDesk.js';
import type { ScheduleDesk } from './schedules/scheduleDesk.js';
import type { WorkGraphRecorder } from './graph/workGraphRecorder.js';
import type { Action, WorldEvent, WorldSnapshot } from './types.js';
import type { UpcomingPlan } from './wire.js';
import { isActiveTask } from './tasks.js';
import type { StackLandingDesk } from './stacks/landingDesk.js';

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
   * Asks the goal assay's question on the ticket itself. Absent = no comment (and
   * it no-ops anyway with the assay off).
   */
  assays?: AssayDesk;
  /** Keeps open pull requests on the naming convention. Absent = no renaming. */
  naming?: PrNamingDesk;
  /**
   * Files the "close the ticket" obligation on a delivered goal, and settles it
   * when the tracker stops listing the item open. Absent = no close-out (tests
   * that do not care). It writes `human_tasks` rows and decides no dispatch.
   */
  closeOuts?: DeliveryCloseOutDesk;
  /** Deletes the branch behind a merged pull request. Absent = `reapMergedBranches` is off. */
  branchReaps?: BranchReapDesk;
  /**
   * Queues the job behind every recurrence that has come due. Absent = no
   * schedules (tests that do not care). It writes `jobs` rows through the same
   * store call the launch route uses and decides no dispatch.
   */
  schedules?: ScheduleDesk;
  /**
   * Reconciles the operator's standing stack-landing authorizations with the
   * world. Absent = no landings (tests that do not care).
   */
  landings?: StackLandingDesk;
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
  // until a cycle runs. A per-pulse projection, never a persisted queue.
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
      // Mechanical bookkeeping, like the plan's status comment: idempotent, so a
      // world already on convention writes nothing.
      await this.deps.naming?.run(world);
      // The same register, one step later in a pull request's life: a merged branch
      // is deleted locally and on the remote. It reads the same snapshot the
      // retarget above was decided from, so a rung the retarget has just moved still
      // reads as based on its merged parent here and holds that parent's branch for
      // one more pulse. That lag is the safe direction, and deliberately not closed
      // by re-reading the world: reaping a branch an open PR is still based on
      // destroys the stack.
      await this.deps.branchReaps?.run(world);
      // What the world has made of the operator's standing stack landings: a chain
      // fully merged is finished, and a rung that has gone red since it was
      // authorized stops the chain and surfaces. Before `decide`, so a stopped
      // intent cannot authorize a merge in the very cycle it stopped — the executor
      // reads the same rows a few lines later. It settles rows and raises inbox
      // items; it decides no dispatch, and it deliberately does not rebuild the
      // stack model to do it (see `src/stacks/landing.ts`).
      this.deps.landings?.settle(world);
      // The step after the launch: a delivered goal whose ticket is still open owes
      // a person one close, and the tracker is where that is observed. Beside the
      // other bookkeeping rather than in the dispatcher, because it is not a
      // dispatch — nothing here staffs anything, and no rule reads what it writes.
      this.deps.closeOuts?.run(world);
      // The operator's standing "every weekday at 09:00": a recurrence that has
      // come due queues its job here, a few lines above the `listQueuedJobs` the
      // dispatcher decides from — so a firing is dispatched on the pulse it fires
      // rather than waiting for the next one. Beside the other bookkeeping and not
      // in the dispatcher for `closeOuts`' reason: it staffs nothing and no rule
      // reads what it writes. What it queues is an ordinary job, so the cap, the
      // pause flag and rule `manual-job` see exactly what a hand-launched one is.
      this.deps.schedules?.run();
      // Record what the world and the store now say happened, after the reconciler
      // so part→PR observations are fresh, and before `decide` so stage 2 can read
      // it. Never deleting is the point: `closedPullRequests` forgets a merge after
      // `closedPrWindowMs` and the graph must not.
      this.deps.graph?.record(world);
      const tasks = store.listTasks();
      // How long each open PR has been sitting on a reviewer. Folded here rather
      // than derived on read because it is the one reading about a *span*: the
      // moment a pull request becomes reviewable is observable only as it
      // happens, and no provider reports it afterwards. Cheap — one short row per
      // PR currently waiting, and none once it stops.
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
      const openEscalations = store.listOpenEscalations();
      const queuedJobs = store.listQueuedJobs();
      // Work a requeue is redoing, keyed on the origin it stands in for rather
      // than on its own `job:<id>` — what stops the rule that produced the
      // original dispatching a second agent onto it (issue #249).
      const standingJobs = store.listStandingJobs();
      // The plan funnel's memory: which issues already have a verdict, so a planner
      // never re-runs and pickup only fires for the ones that resolved to `single`.
      const plans = store.listPlans();
      const planParts = store.listAllPlanParts();
      // Who said an issue is finished. Small (one row per concluded issue) and
      // unbounded in age on purpose: a verdict that aged out of a window would
      // have the harness re-pick work someone already declared done.
      const conclusions = store.listIssueConclusions();
      // The harness's own park: issues an assessor judged delivered. Unbounded in
      // age for the same reason conclusions are, and the world read that ends one
      // is derived from the verdicts themselves — so a deployment that has never
      // assessed an issue does no read at all.
      const deliveries = store.listDeliveries();
      const deliveryWindow = deliverySignalQuery(deliveries);
      // Its negative mirror: issues an assessor judged worked-and-still-short. It
      // holds nothing, so it needs no signal read of its own — it lives until the
      // arm it named has been performed, and rule `issue-shortfall` is its one reader.
      const shortfalls = store.listShortfalls();
      const deliverySignals = deliveryWindow
        ? store.listWorldEventsSince(deliveryWindow.since, deliveryWindow.refs)
        : [];
      // The content gate in front of the funnel: which issues have had their goal
      // judged, and what was said. Unbounded in age for the reason deliveries are,
      // and the read that can end an `unclear` verdict is derived from the verdicts
      // themselves — so a deployment that has never refused a goal does no read.
      const assays = store.listAssays();
      const assayWindow = assaySignalQuery(assays);
      const assaySignals = assayWindow ? store.listWorldEventsSince(assayWindow.since, assayWindow.refs) : [];
      // Put the assay's question where the person who wrote the ticket will see it.
      // After the read above so it judges the same verdicts the dispatcher will, and
      // before `decide` only because everything else on the pulse is — it changes no
      // decision, and a failure is recorded rather than thrown.
      await this.deps.assays?.announce(world, assaySignals);
      // Which goals already have a write-up — origins only. Rule `issue-retro` reads this to
      // know whether to dispatch one; the Goal Floor's retention (below) reads it
      // as one of the signals that a goal is finished.
      const retrospectiveOrigins = store.listRetrospectiveOrigins();
      // A run lives until the operator dismisses it, not until the tracker stops
      // returning the issue (issue #234). Minted the first pulse the harness has
      // work under a goal and refreshed while the issue is live, so the snapshot a
      // retained run is later dispatched and drawn from is the issue as it last
      // actually stood. A store write, not a decision, and idempotent per pulse, so
      // a failure is recorded and the next pulse retries rather than failing the
      // whole cycle.
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

      // The other half of #234: the runs the tracker has forgotten join the
      // dispatcher's issue list, so a goal whose ticket was closed by the very PR
      // that delivered it is still a subject the assessor and the retrospective can
      // finish. Only the *dispatch* view is widened — the snapshot above stays the
      // connector's own answer, exactly as the ignore-tag filter below it does, so
      // nothing that reports the world reports a stub as something the tracker said.
      //
      // Not safe by accident: every rule that must not act on a retained run says
      // so in its own body, off `retainedIssues`. Most of them would skip a
      // `closed` stub anyway, and that is precisely the kind of safety a later
      // change removes without a test failing.
      const retainedIssues = retainedRunIssues(store.listIssueRuns(), world.issues);
      const dispatchWorld: WorldSnapshot =
        excludedPrs.length > 0 || retainedIssues.length > 0
          ? {
              ...world,
              pullRequests: world.pullRequests.filter((pr) => !isPrExcluded(pr, label)),
              issues: [...world.issues, ...retainedIssues],
            }
          : world;

      const plan = await this.deps.dispatcher.decide({
        world: dispatchWorld,
        // Which of `world.issues` above are retained runs rather than the tracker's
        // own answer. A number list, not a flag on the issue: `Issue` is what the
        // connector returned, and a synthesized field on it would be indistinguishable
        // from one a provider set.
        retainedIssues: retainedIssues.map((i) => i.number),
        // Hidden from dispatch, but still open — the issue-pickup gate has to see
        // them or an ignored PR reads as merged and its issue gets a second agent.
        excludedPrs,
        tasks,
        agents,
        openEscalations,
        queuedJobs,
        standingJobs,
        plans,
        planParts,
        // How anyone checks each goal was met. Rule `validate-check` reads only
        // whether a check was handed to the fleet and whether anybody has
        // recorded a reading against it — never what it says.
        validationChecks: store.listAllValidationChecks(),
        conclusions,
        deliveries,
        deliverySignals,
        shortfalls,
        assays,
        assaySignals,
        // Which goals already have a write-up — origins only. Rule `issue-retro` needs to know
        // whether to dispatch one; what it says is deliberately out of its reach.
        retrospectiveOrigins,
        recentDecisions,
        proposals,
        rejectionSignals,
        priorityOverrides,
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

      // The dispatcher's reasoning is itself an audit record — prefixed, when any
      // provider served a fallback slice, with the fact that it was reasoning about
      // a world that is partly old. The caveat rides on the rationale rather than
      // only in the error log because this row is what an operator reads to work
      // out why a cycle decided what it did, and a stale input is the first thing
      // that would explain a decision that looks wrong.
      const stale = world.staleSources ?? [];
      const caveat = stale.length > 0 ? `[stale: ${stale.join(', ')}] ` : '';
      store.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'cycle rationale' } as Action,
        outcome: 'skipped',
        detail: `[${source}] ${caveat}${plan.rationale}`,
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
