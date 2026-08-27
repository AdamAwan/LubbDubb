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
import { awaitingReview, isPrWatched } from './prHealth.js';

import { rejectionSignalQuery } from './proposals/proposals.js';
import { deliverySignalQuery } from './delivery/delivery.js';
import { appraisalSignalQuery } from './intake/appraisal.js';
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
import type { Action, WorldEvent, WorldSnapshot } from './types.js';
import type { UpcomingPlan } from './wire.js';
import { isActiveTask } from './tasks.js';
import type { StackLandingDesk } from './stacks/landingDesk.js';
import type { PoolDesk } from './pool/poolDesk.js';

/**
 * How many accounts of each kind the dispatch context carries.
 *
 * Read on **every** pulse, and it feeds a prompt block that renders at most a
 * handful of lines — so this is the read's bound rather than the block's, which
 * `priorRemedies.ts` keeps for itself. Wider than that block's cap on purpose:
 * the CI arm filters to the checks that are red now, so a fetch of exactly six
 * would routinely arrive with none of them relevant.
 */
const PRIOR_REMEDY_ROWS = 40;

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
  /**
   * Only PRs carrying this label (`${labelPrefix}-watch`) are dispatched at — pull
   * requests are opt-in exactly as issues are. Empty = the gate is off and every PR
   * is worked, which is the no-prefix and test posture.
   */
  prWatchLabel: string;
  /**
   * What a dispatch needs to resolve the profile its origin is pinned to (issue
   * #342) — passed straight through to the dispatch context. Absent = no
   * `agentModels`, no `labelPrefix`, or a test that does not care, and then no
   * dispatch is ever pinned.
   */
  modelPins?: { labelPrefix: string; models: AgentModels };
  /**
   * Where every Feature's work stands right now, digested — what rule
   * `feature-summary` compares against the summaries on file.
   *
   * A thunk rather than the mirror, on `modelPins`' terms: the harness asks one
   * question and gets the answer, and stays as ignorant of container types, watch
   * labels and environments as it is of the board that draws them. It is also
   * where the *cost* is gated — the gather is several full-table reads, so the
   * wiring returns an empty list on a deployment with no feature board and this
   * pulse then does no read at all.
   *
   * Absent = a caller that has not wired it, and then no Feature is ever
   * summarised: the safe absence, since the other direction would dispatch against
   * a digest nobody built.
   */
  featureStandings?: () => { number: number; title: string; key: string }[];
  /** How long an operator "Up next" priority override survives after its origin stops being tracked (issue #128; 0 disables pruning). */
  upNextOverrideTtlMs: number;
  /**
   * Folds git + provider reality onto the plan-part rows, next to the world diff.
   * Absent = no plan tracking (and it no-ops anyway with the funnel off).
   */
  plans?: PlanReconciler;
  /**
   * Asks the goal appraisal's question on the ticket itself. Absent = no comment (and
   * it no-ops anyway with the appraisal off).
   */
  appraisals?: AppraisalDesk;
  /**
   * The project's area tree, kept fresh enough for the appraisal tool and the state
   * snapshot to read synchronously. Absent = never read, and then every item
   * reads as classified — which is the correct answer for a tracker that has no
   * such tree, and the reason the directory itself distinguishes "no tree" from
   * "not read yet".
   */
  areaPaths?: AreaPathDirectory;
  /** Keeps open pull requests on the naming convention. Absent = no renaming. */
  naming?: PrNamingDesk;
  /**
   * Tags the pull requests the harness opened, so its own work is watched without
   * an operator clicking anything. Absent = no seeding, and then only what `open_pr`
   * tagged at creation is worked.
   */
  prWatch?: PrWatchDesk;
  /**
   * Links the pull requests the harness opened to their work items, so Azure's
   * linked-work-items policy is satisfied without an agent being spent working out
   * a number the harness already holds. Absent = no linking, and then only what
   * `open_pr` linked at creation carries a link.
   */
  prWorkItems?: PrWorkItemDesk;
  /**
   * Files the "close the ticket" obligation on a delivered goal, and settles it
   * when the tracker stops listing the item open. Absent = no close-out (tests
   * that do not care). It writes `human_tasks` rows and decides no dispatch.
   */
  closeOuts?: DeliveryCloseOutDesk;
  /**
   * Files the ask for a validation resource a delivered goal's plan says it needs
   * and could not produce. Absent = no resource asks (tests that do not care). It
   * writes `human_tasks` rows and decides no dispatch.
   */
  validationAsks?: ValidationAskDesk;
  /**
   * Files the "this goal is ready to be validated" obligation on a delivered goal,
   * and settles it once nothing is left for a person to run. Absent = no validate
   * rows (tests that do not care). It writes `human_tasks` rows and decides no
   * dispatch.
   */
  validationReady?: ValidationReadyDesk;
  /**
   * Surfaces a live run spending far past what its kind of work costs. Absent =
   * no burn watch (tests that do not care). It writes `human_tasks` rows, decides
   * no dispatch, and stops nothing.
   */
  burn?: SpendBurnDesk;
  /**
   * Says when the queue of work is running out. Absent = no runway watch (tests
   * that do not care). It writes `human_tasks` rows, decides no dispatch and
   * holds nothing — and it needs {@link HarnessDeps.issuePickup} to read the same
   * gate the dispatcher reads.
   */
  runway?: RunwayDesk;
  /**
   * The pickup gate's own policy, so the runway watch can ask
   * `issuePickupStatus` the question rule `issue-pickup` asks. Read here rather
   * than off the dispatcher because {@link Dispatcher} is an interface and only
   * one implementation happens to carry a policy — a lens reaching through it
   * would be reading a private field of one dispatcher.
   */
  issuePickup?: IssuePickupPolicy;
  /** Deletes the branch behind a merged pull request. Absent = `reapMergedBranches` is off. */
  branchReaps?: BranchReapDesk;
  /**
   * Attributes each merge to the goal it was for, and asks the configured
   * environments where those commits have got to. Absent = tests that do not care;
   * with no `environments` configured it records landings and probes nothing.
   */
  environments?: EnvironmentDesk;
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
   * Keeps the ticket mirror current (issue #329). Absent = no mirror, which is
   * every test that does not name one and every deployment whose issues provider
   * cannot list history.
   */
  tickets?: { run(): Promise<void> };
  /**
   * Watches the harness's own build, and advances a drain that has run dry. Absent
   * = the watch is off, which is a supported configuration and every test that does
   * not name one. It decides no dispatch: what it can pause is the same `paused`
   * flag the operator's own pause writes, and it writes that only when asked.
   */
  updates?: { run(): Promise<void> };
  /**
   * The crash-recovery gate: how many agents orphaned by the previous run are
   * still waiting on an operator's verdict. Any at all holds the pulse — see
   * {@link Harness.runCycle}.
   */
  recovery?: { pendingCount(): number };
  /**
   * Ends the usage-limit parks whose window has turned over. Absent = no
   * auto-resume (tests that do not care), and then a park waits for the cockpit's
   * Resume as it did before. It staffs nobody and no rule reads what it writes: the
   * agent it wakes is one already holding its slot.
   */
  fleet?: { resumeExpiredParks(): LimitResumeFailure[]; completeExpiredStalls(): string[] };
  /**
   * Raises the notices the harness can see for itself, and ends the ones the world
   * has settled. Absent = no harness notices (tests that do not care), and then
   * the only expiring facts are the ones agents raise. It writes `knowledge_facts`
   * rows, decides no dispatch, and nothing but a prompt reads what it writes.
   */
  notices?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  /**
   * Ends the graduations the world has settled: a documentation pull request
   * merged takes its claim to `committed` and out of every prompt, and one closed
   * unmerged leaves the claim exactly where it was. Absent = nothing sweeps (tests
   * that do not care), and then a committed claim only ever gets there through the
   * operator's own answer on the page. It writes `knowledge_graduations` and
   * `knowledge_facts` rows, decides no dispatch, and nothing but a prompt reads
   * what it writes.
   */
  graduations?: { run(): void };
  clusters?: { run(): void };
  /**
   * The cross-fleet pool's one desk: polls everybody else's documents into the
   * mirror, and publishes this fleet's when they have moved. Absent = no pool
   * (tests that do not care, and every deployment on the `fake` default), and then
   * nothing is published and nothing arrives.
   *
   * It writes `pool_*` rows and — through the ordinary proposal path — `knowledge_facts`
   * ones. It decides no dispatch and no rule reads what it writes, which is why it
   * sits beside the other bookkeeping rather than in the dispatcher.
   * → `docs/spec/28-cross-fleet-pool.md#the-clocks`
   */
  pool?: PoolDesk;
  /**
   * Clears "Needs you" items whose agent has died. Absent = no sweep (tests that
   * do not care), and then only the terminal-state listeners tidy. It settles
   * inbox rows, decides no dispatch, and no rule reads what it writes.
   */
  escalations?: { tidyDeadAgents(): unknown[] };
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
      // Read before the diff records it, because the notice desk below needs the
      // same *pair* the diff is taken from — and `recordWorldChanges` moves the
      // baseline on. Seeded from the persisted baseline for its reason too: a
      // restart that read null here would go blind to every transition that
      // straddled it.
      const previousWorld = this.prevWorld ?? store.getWorldBaseline();
      this.recordWorldChanges(store, world, previousWorld);
      // Fold observed reality onto the plan-part rows before anything reads them:
      // the store holds intent, the outside world stays the source of truth, and a
      // part this moves to `ready` is dispatchable in this same cycle.
      await this.deps.plans?.reconcile(world);
      // The harness's own pull requests, tagged as watched. Before the naming desk
      // only because it belongs with the other per-pulse bookkeeping; a pull request
      // tagged here is worked from the *next* pulse, since the snapshot below was
      // read before the label landed. That lag is the same one the retarget and the
      // reap accept, and it costs nothing on the path that matters: `open_pr` tags a
      // pull request as it creates it, so this is only ever catching the strays.
      await this.deps.prWatch?.run(world);
      // Beside the tagging and on its terms: the tracker link the harness can supply
      // from a row, so the linked-work-items policy is cleared without a dispatch.
      // Idempotent, so a world already linked writes nothing — and the same one-pulse
      // lag applies, since `open_pr` links a pull request as it opens one and this is
      // only ever catching the strays.
      await this.deps.prWorkItems?.run(world);
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
      // What a delivered goal owes a person: the fixtures and accounts its
      // validation plan says it needs and could not produce. Beside the close-out
      // below and against the same gate — a check runs against the delivered goal,
      // so this is the first pulse on which the ask is one anybody can act on. It
      // writes `human_tasks` rows and nothing else.
      this.deps.validationAsks?.run();
      // And the obligation those resources are for: a delivered goal with checks a
      // person still has to run says so on the bench, where the rest of their work
      // is, rather than only on a sheet somebody has to think to open. It writes
      // `human_tasks` rows, blocks nothing, and settles itself as the results are
      // recorded.
      this.deps.validationReady?.run(world);
      // The step after the launch: a delivered goal whose ticket is still open owes
      // a person one close, and the tracker is where that is observed. Beside the
      // other bookkeeping rather than in the dispatcher, because it is not a
      // dispatch — nothing here staffs anything, and no rule reads what it writes.
      //
      // **Below the validation desk, and that ordering is load-bearing.** The
      // close-out waits on the goal's `validate` row being settled, so run above
      // this line it would read a bench that has not been filed yet and ask for the
      // close on the very pulse the delivery landed — the two rows arriving
      // together, which is the thing the sequence exists to stop.
      this.deps.closeOuts?.run(world);
      // The operator's standing "every weekday at 09:00": a recurrence that has
      // come due queues its job here, a few lines above the `listQueuedJobs` the
      // dispatcher decides from — so a firing is dispatched on the pulse it fires
      // rather than waiting for the next one. Beside the other bookkeeping and not
      // in the dispatcher for `closeOuts`' reason: it staffs nothing and no rule
      // reads what it writes. What it queues is an ordinary job, so the cap, the
      // pause flag and rule `manual-job` see exactly what a hand-launched one is.
      this.deps.schedules?.run();
      // The harness reading its own build, beside the other bookkeeping for the
      // same reason and one more: it is the only pass here about *this process*
      // rather than the world, so nothing it writes is derived from `world` and
      // nothing downstream reads it. Awaited but never blocking — a check that is
      // not due returns the reading it already has, and one that fails records
      // itself rather than throwing into the cycle.
      await this.deps.updates?.run();
      // Record what the world and the store now say happened, after the reconciler
      // so part→PR observations are fresh, and before `decide` so stage 2 can read
      // it. Never deleting is the point: `closedPullRequests` forgets a merge after
      // `closedPrWindowMs` and the graph must not.
      this.deps.graph?.record(world);
      // Where that work has actually got to: the commit each merged pull request
      // landed as, attributed to the goal it was for, and what the operator's
      // environment probes say about those commits.
      //
      // **Immediately below the graph record, and that ordering is load-bearing.**
      // Attribution walks `parentRef` from a PR node up to its goal, so run above
      // this line it would read a graph one pulse stale and fall back to the
      // world's own `issueForPr` for every merge on the pulse it happened —
      // which resolves nothing for a pull request whose issue the tracker has
      // already closed. Beside the other bookkeeping and not in the dispatcher for
      // `closeOuts`' reason: it staffs nothing and no rule reads what it writes.
      await this.deps.environments?.run(world);
      // What the harness has seen for itself that the fleet would otherwise pay to
      // rediscover: a check that went red and green on one commit, a check red on a
      // branch other pull requests are based on — and the notices a green reading
      // has since settled.
      //
      // **Above `decide` and above the executor, and that ordering is what it is
      // for.** The block a dispatch carries is rendered at launch, a few lines
      // below: run under that and a notice raised on this pulse is a notice the
      // agents dispatched on this pulse are not told, and one settled on this pulse
      // is one they are still told. Beside the other bookkeeping and not in the
      // dispatcher for `closeOuts`' reason — it staffs nobody, holds nothing, and
      // no rule reads a fact.
      this.deps.notices?.run(previousWorld, world);
      // What became of the documentation pull requests an operator opened for a
      // claim — and, for the ones that landed, the claim leaving every prompt
      // because the repository now says it.
      //
      // **Below the graph record and above `decide`**, and both halves matter. It
      // reads the graph, which is `environments`' reason for sitting where it does:
      // run above that line and it reads a graph one pulse stale, so a merge is
      // acted on a pulse late every time. And a fact it commits leaves the block,
      // which is rendered at launch a few lines below — run under that and the
      // agents dispatched on this pulse are still told a claim the repository
      // states. Beside the other bookkeeping and not in the dispatcher for
      // `notices`' reason: it staffs nobody and no rule reads a fact.
      this.deps.graduations?.run();
      // Which proposals a machine thinks are one claim. Beside the two desks above
      // and not in the dispatcher for their reason — it staffs nobody and no rule
      // reads a suggestion — and its position in the pulse is not load-bearing at
      // all: nothing waits on a cluster, it takes its own cadence, and the page an
      // operator opens is the only thing that reads what it writes.
      this.deps.clusters?.run();
      // The distance above `fleet`: what other fleets have vouched for, landed here,
      // and what this fleet has vouched for, sent out.
      //
      // **Above `decide` and above the executor**, for `notices`' reason exactly: an
      // arrival that carries a local claim to `lookup` on this pulse must be a claim
      // the agents dispatched on this pulse can be answered with. And below
      // `graduations`, so a claim that left for the repository on this pulse is out
      // of the document before it is derived rather than published one last time.
      //
      // Awaited but never blocking: every failure inside is recorded and non-fatal,
      // a fetch that fails leaves the last-known-good mirror in place, and a publish
      // that fails leaves the document dirty for the next pulse. A fleet with an
      // unreachable pool works exactly as a fleet without one.
      await this.deps.pool?.run();
      // An agent parked because the *account* ran out is resumed once the window
      // `claude` named has turned over — the one park with a known end, so the
      // ordinary case needs no operator (issue #318). Beside the other bookkeeping
      // and not in the dispatcher for `closeOuts`' reason: it staffs nobody and no
      // rule reads what it writes. It claims no headroom either — a parked agent
      // counts as live the whole time it is parked, so it has been holding its own
      // slot since it was dispatched.
      //
      // Immediately above the reads below rather than merely before `decide`, for
      // `tidyDeadAgents`' reason: an agent this wakes must read as `running` for the
      // rest of the pulse, not appear parked to the burn watch and the snapshot one
      // last time.
      //
      // A resume that fails puts the park back, so the next pulse retries — recorded
      // here because one that can never be resumed would otherwise retry forever in
      // silence, which is the shape of failure the park itself was written to end.
      for (const { agentId, error } of this.deps.fleet?.resumeExpiredParks() ?? [])
        this.deps.errors.record({
          source: 'agent',
          message: `Agent ${agentId} could not be resumed after its usage limit cleared; it stays parked`,
          detail: error,
        });
      // The other park with an ending nobody has to decide, settled on the same
      // terms and immediately below it. An agent that stopped without saying why,
      // was asked and did not answer, and has since stood in front of the operator
      // for `agentStallParkMs` without being answered there either, is recorded
      // `done` — the click they were always going to make, made for them. It settles
      // agents and dismisses their inbox rows; it staffs nobody, and no rule reads
      // what it writes.
      //
      // Above the reads below for the resume's reason in reverse: an agent this
      // settles must *stop* counting as live for the rest of the pulse, so the slot
      // it was holding is one the dispatch decided a few lines down can use.
      //
      // Nothing is recorded here — each settle writes its own audit row, and the ids
      // it returns are for a test to read rather than for the cycle.
      this.deps.fleet?.completeExpiredStalls();
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
      // What the fleet is spending *now*: a live run far past what its kind of
      // work costs becomes a visible obligation to go and look at it. Beside the
      // other bookkeeping and not in the dispatcher for `closeOuts`' reason — it
      // staffs nobody, holds nothing and no rule reads what it writes. Handed the
      // two reads above rather than taking its own, so the pulse walks the agents
      // and tasks tables once between here and `decide`.
      this.deps.burn?.run({ agents, tasks });
      // Clear the questions whose agent is gone, immediately before the read that
      // ships them to the cockpit — so a dead agent's card is off "Needs you" on
      // the same pulse rather than the next one. The listeners in `src/system.ts`
      // have usually done this already; this catches the deaths that reached no
      // listener. Beside the other bookkeeping and not in the dispatcher for
      // `closeOuts`' reason: it staffs nobody and no rule reads what it writes.
      this.deps.escalations?.tidyDeadAgents();
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
      const appraisals = store.listAppraisals();
      const appraisalWindow = appraisalSignalQuery(appraisals);
      const appraisalSignals = appraisalWindow
        ? store.listWorldEventsSince(appraisalWindow.since, appraisalWindow.refs)
        : [];
      // Put the appraisal's question where the person who wrote the ticket will see it.
      // After the read above so it judges the same verdicts the dispatcher will, and
      // before `decide` only because everything else on the pulse is — it changes no
      // decision, and a failure is recorded rather than thrown.
      await this.deps.appraisals?.announce(world, appraisalSignals);
      // The area tree, if its own TTL says it is stale — otherwise a no-op. Here
      // rather than on a timer of its own for the reason every other periodic read
      // is on the pulse: a timer keeps firing across a drain and an upgrade
      // handoff. A failure is recorded inside and never thrown, so a provider that
      // will not answer costs the placement question and nothing else.
      await this.deps.areaPaths?.refresh();
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
      // The standing statement above that per-origin arrangement: the goals the
      // operator marked a priority, whose whole subtree the ranking lifts. Not
      // reconciled with the tracked origins below — a flagged goal waiting on a
      // human is queueing nothing, and that is exactly when the flag must survive.
      const goalPriorities = store.listGoalPriorities();
      // What the operator has said one queued row should *run on*, keyed on the
      // same origin. Read here rather than in the dispatcher so the pin chain has
      // one input per level and the cycle stays the only thing that touches the
      // store.
      const profileOverrides = store.listProfileOverrides();
      // While paused, advertise zero headroom so the dispatcher plans no new
      // dispatches; the executor also hard-defers them (belt and braces).
      const headroom = this.deps.runtime.paused ? 0 : Math.max(0, this.deps.runtime.cap - store.countLiveAgents());

      // A PR without the watch tag is one nobody opted in — the harness's own are
      // tagged as they are opened (`src/prWatch.ts`), so what is left here is
      // somebody else's work, or work an operator has taken off the fleet. Hide them
      // from the dispatch view so *both* dispatchers leave them alone uniformly — no
      // CI fix, base update, comment note, or merge. The world used for
      // diffing/baseline above is untouched, and the cockpit snapshot reads the
      // connector directly, so an unwatched PR stays fully visible (with its health
      // and its tags) — it is just not acted on.
      const label = this.deps.prWatchLabel;
      const unwatchedPrs = world.pullRequests.filter((pr) => !isPrWatched(pr, label));

      // The other half of #234: the runs the tracker has forgotten join the
      // dispatcher's issue list, so a goal whose ticket was closed by the very PR
      // that delivered it is still a subject the assessor and the retrospective can
      // finish. Only the *dispatch* view is widened — the snapshot above stays the
      // connector's own answer, exactly as the watch-tag filter below it does, so
      // nothing that reports the world reports a stub as something the tracker said.
      //
      // Not safe by accident: every rule that must not act on a retained run says
      // so in its own body, off `retainedIssues`. Most of them would skip a
      // `closed` stub anyway, and that is precisely the kind of safety a later
      // change removes without a test failing.
      const retainedIssues = retainedRunIssues(store.listIssueRuns(), world.issues);
      const dispatchWorld: WorldSnapshot =
        unwatchedPrs.length > 0 || retainedIssues.length > 0
          ? {
              ...world,
              pullRequests: world.pullRequests.filter((pr) => isPrWatched(pr, label)),
              issues: [...world.issues, ...retainedIssues],
            }
          : world;

      // Where every Feature stands, and what the summaries on file were written
      // against — the two halves of rule `feature-summary`'s one comparison. The
      // second read is skipped entirely when the first came back empty, which is
      // every deployment with no feature board.
      const featureStandings = this.deps.featureStandings?.() ?? [];
      const featureSummaryKeys =
        featureStandings.length === 0
          ? []
          : store.listFeatureSummaries().map((f) => ({ originRef: f.originRef, standingKey: f.standingKey }));

      const plan = await this.deps.dispatcher.decide({
        world: dispatchWorld,
        // Which of `world.issues` above are retained runs rather than the tracker's
        // own answer. A number list, not a flag on the issue: `Issue` is what the
        // connector returned, and a synthesized field on it would be indistinguishable
        // from one a provider set.
        retainedIssues: retainedIssues.map((i) => i.number),
        // Hidden from dispatch, but still open — the issue-pickup gate has to see
        // them or an unwatched PR reads as merged and its issue gets a second agent.
        unwatchedPrs,
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
        appraisals,
        appraisalSignals,
        // Which goals already have a write-up — origins only. Rule `issue-retro` needs to know
        // whether to dispatch one; what it says is deliberately out of its reach.
        retrospectiveOrigins,
        // Standings and digests only — never a word of what a summary says, for
        // `retrospectiveOrigins`' reason one line up.
        featureStandings,
        featureSummaryKeys,
        recentDecisions,
        proposals,
        rejectionSignals,
        priorityOverrides,
        goalPriorities,
        profileOverrides,
        // What agents said the last few returns to a pull request turned out to
        // be. Prompt material only — no rule reads it, and the two CI/review
        // arms render it into the prompt they were already building. Both kinds
        // are fetched because both arms can fire in one pass over one PR.
        priorRemedies: [
          ...store.listRecentRemedies('ci', PRIOR_REMEDY_ROWS),
          ...store.listRecentRemedies('review', PRIOR_REMEDY_ROWS),
        ],
        // The goal tags and the profiles they may name, so a dispatch on a pinned
        // issue is priced by the pin rather than by its rule.
        modelPins: this.deps.modelPins,
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
      // The same sweep, for the same reason and off the same set: an override
      // naming an origin nothing tracks any more prices no dispatch, and a
      // profile pin that outlives its row is one nobody can see to take off.
      store.reconcileProfileOverrides([...trackedOrigins], this.deps.upNextOverrideTtlMs);

      // Whether there is anything left for the fleet to do, and whether the reason
      // there is not is upstream of it. Beside the other bookkeeping and not in the
      // dispatcher for `closeOuts`' reason — it staffs nobody, holds nothing and no
      // rule reads what it writes.
      //
      // **Below `decide` rather than above it**, and for both neighbours. It needs
      // every read `decide` needs — the plan funnel, the verdicts, the decision
      // window — so this is the first point in the pulse where they all exist; and
      // running it after the decision means a lens about supply can never delay a
      // dispatch, however long its walk over the issues takes.
      //
      // It reads the *pre-dispatch* headroom, so a goal this pulse is about to
      // start still counts as queued rather than in flight. One pulse of lag, the
      // same lag the retarget and the reap accept, and in the safe direction: it
      // over-reports supply for a beat rather than announcing a drought that the
      // dispatch happening milliseconds later has already answered.
      if (this.deps.runway && this.deps.issuePickup)
        this.deps.runway.run({
          issues: world.issues,
          pickup: {
            policy: this.deps.issuePickup,
            cooldown: DEFAULT_COOLDOWN,
            now: world.takenAt,
            tasks,
            recentDecisions,
            // Unfiltered, exactly as the gate itself takes it: an unwatched PR is
            // hidden from dispatch but is still an open PR, and one read as gone
            // would have its goal counted as unstarted supply.
            openPrs: world.pullRequests,
            plans,
            planParts,
            deliveries,
            deliverySignals,
            appraisals,
            appraisalSignals,
            runs: store.listIssueRuns(),
            headroom,
            paused: this.deps.runtime.paused,
          },
          cap: this.deps.runtime.cap,
        });

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
      // The ticket mirror, last in the cycle and deliberately so: it is a record
      // nothing here decides from, and its first run is a month of backfill. Ahead
      // of `execute` that one slow sweep would hold the fleet's work on the pulse a
      // deployment starts; behind it, it costs a boot's latency and nothing else.
      // It records its own failures and never throws — a tracker that refused us
      // must not cost the cycle it happened in.
      await this.deps.tickets?.run();
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
   *
   * `prev` is passed in rather than read here because the pulse has a second
   * reader of the same pair — the knowledge notice desk — and this call moves the
   * baseline on. One read, handed to both, so the two cannot come to be looking at
   * different pulses.
   */
  private recordWorldChanges(store: HarnessDeps['store'], world: WorldSnapshot, prev: WorldSnapshot | null): void {
    // A stale slice is by construction equal to the last one the same source
    // reported, so a diff against it loses nothing — but diffing it would, and
    // moving the baseline onto it would make the next fresh pulse diff a real
    // world against nothing and re-announce everything. Leave the baseline on the
    // last world anybody actually read.
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
  }

  // Typed emit/on overrides for a nicer call site (repo convention).
  override emit<K extends keyof HarnessEvents>(event: K, ...args: HarnessEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HarnessEvents>(event: K, listener: (...args: HarnessEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
