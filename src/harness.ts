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

/**
 * How many accounts of each kind the dispatch context carries — the read's bound, not the
 * prompt block's (`priorRemedies.ts` keeps that).
 */
const PRIOR_REMEDY_ROWS = 40;

/** How many recent `world_events` the lane split reads to answer "what has moved lately". */
const READ_PLAN_EVENTS = 200;

interface HarnessDeps {
  store: Store;
  connector: Connector;
  dispatcher: Dispatcher;
  executor: ActionExecutor;
  heartbeatIntervalMs: number;
  /** The pulse while nothing is moving. */
  idleHeartbeatIntervalMs: number;
  /** The hot/cold hydration backstops handed down to the world read each pulse. */
  readLanes: ReadLanes;
  /** Central error sink: a cycle exception is recorded here, never thrown away. */
  errors: ErrorRecorder;
  /** Live cap + pause flag, read by reference each cycle (never a frozen copy). */
  runtime: RuntimeControl;
  /**
   * Only PRs carrying this label (`${labelPrefix}-watch`) are dispatched at — pull requests
   * are opt-in exactly as issues are.
   */
  prWatchLabel: string;
  /**
   * The fleet review's policy — held here for one thing only: the pass below that asks the
   * operator's `review.reviewedElsewhere` command which of this pulse's would-be reviews
   * have already happened.
   */
  review: PrReviewPolicy;
  /**
   * Asks something outside the harness whether a pull request has already been reviewed
   * (`review.reviewedElsewhere`).
   */
  reviewProber?: ReviewProber;
  /**
   * What a dispatch needs to resolve the profile its origin is pinned to (issue #342) —
   * passed straight through to the dispatch context. Absent = no `agentModels`, no
   * `labelPrefix`, or a test that does not care, and then no dispatch is ever pinned.
   */
  modelPins?: { labelPrefix: string; models: AgentModels };
  /**
   * Where every Feature's work stands right now, digested — what rule `feature-summary`
   * compares against the summaries on file. Absent = no Feature is ever summarised, which
   * is the safe absence.
   */
  featureStandings?: () => { number: number; title: string; key: string }[];
  /**
   * How long an operator "Up next" priority override survives after its origin stops being
   * tracked (issue #128; 0 disables pruning).
   */
  upNextOverrideTtlMs: number;
  /**
   * Folds git + provider reality onto the plan-part rows, next to the world diff. Absent =
   * no plan tracking (and it no-ops anyway with the funnel off).
   */
  plans?: PlanReconciler;
  /**
   * Asks the goal appraisal's question on the ticket itself. Absent = no comment (and it
   * no-ops anyway with the appraisal off).
   */
  appraisals?: AppraisalDesk;
  /**
   * The project's area tree, kept fresh enough for the appraisal tool and the state
   * snapshot to read synchronously. Absent = never read, and then every item reads as
   * classified — correct for a tracker with no such tree.
   */
  areaPaths?: AreaPathDirectory;
  /** Keeps open pull requests on the naming convention. Absent = no renaming. */
  naming?: PrNamingDesk;
  /**
   * Tags the pull requests the harness opened, so its own work is watched without an
   * operator clicking anything. Absent = no seeding, and then only what `open_pr` tagged at
   * creation is worked.
   */
  prWatch?: PrWatchDesk;
  /**
   * Links the pull requests the harness opened to their work items, so Azure's
   * linked-work-items policy is satisfied without an agent being spent working out a number
   * the harness already holds. Absent = no linking, and then only what `open_pr` linked at
   * creation carries a link.
   */
  prWorkItems?: PrWorkItemDesk;
  /**
   * Files the "close the ticket" obligation on a delivered goal, and settles it when the
   * tracker stops listing the item open. Absent = no close-out (tests that do not care).
   */
  closeOuts?: DeliveryCloseOutDesk;
  /**
   * Files the ask for a validation resource a delivered goal's plan says it needs and could
   * not produce. Absent = no resource asks (tests that do not care).
   */
  validationAsks?: ValidationAskDesk;
  /**
   * Files the "this goal is ready to be validated" obligation on a delivered goal, and
   * settles it once nothing is left for a person to run. Absent = no validate rows (tests
   * that do not care).
   */
  validationReady?: ValidationReadyDesk;
  /**
   * Surfaces a live run spending far past what its kind of work costs. Absent = no burn
   * watch (tests that do not care).
   */
  burn?: SpendBurnDesk;
  /**
   * Says when the queue of work is running out. Absent = no runway watch (tests that do not
   * care).
   */
  runway?: RunwayDesk;
  /**
   * The pickup gate's own policy, so the runway watch asks `issuePickupStatus` the question
   * rule `issue-pickup` asks.
   */
  issuePickup?: IssuePickupPolicy;
  /** Deletes the branch behind a merged pull request. Absent = `reapMergedBranches` is off. */
  branchReaps?: BranchReapDesk;
  /**
   * Attributes each merge to the goal it was for, and asks the configured environments
   * where those commits have got to. Absent = tests that do not care; with no
   * `environments` configured it records landings and probes nothing.
   */
  environments?: EnvironmentDesk;
  /**
   * Queues the job behind every recurrence that has come due. Absent = no schedules (tests
   * that do not care).
   */
  schedules?: ScheduleDesk;
  /**
   * Reconciles the operator's standing stack-landing authorizations with the world. Absent
   * = no landings (tests that do not care).
   */
  landings?: StackLandingDesk;
  /** Writes the durable work graph each pulse. Absent = no graph (tests that do not care). */
  graph?: WorkGraphRecorder;
  /**
   * Keeps the ticket mirror current (issue #329). Absent = no mirror, which is every test
   * that does not name one and every deployment whose issues provider cannot list history.
   */
  tickets?: { run(): Promise<void> };
  /**
   * The local run, asked once a beat to date the environment it is holding. Absent =
   * nothing is dated. → [23](../docs/spec/23-local-runs.md)
   */
  localRun?: { noteAlive(): void };
  /**
   * The local-validation desk's sweep: settles the rows nobody will ever answer. **Above
   * the dispatch**, so the rule never proposes an agent for a row this beat is about to
   * abandon. → [32](../docs/spec/32-local-validation.md)
   */
  localValidations?: { sweep(): void };
  /**
   * Watches the harness's own build, and advances a drain that has run dry. Absent = the
   * watch is off, which is a supported configuration and every test that does not name one.
   */
  updates?: { run(): Promise<void> };
  /**
   * The crash-recovery gate: how many agents orphaned by the previous run are still waiting
   * on an operator's verdict.
   */
  recovery?: { pendingCount(): number };
  /**
   * Ends the usage-limit parks whose window has turned over. Absent = no auto-resume, and a
   * park waits for the cockpit's Resume.
   */
  fleet?: { resumeExpiredParks(): LimitResumeFailure[]; completeExpiredStalls(): string[] };
  /**
   * Raises the notices the harness can see for itself, and ends the ones the world has
   * settled. Absent = no harness notices.
   */
  notices?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  /**
   * Ends the graduations the world has settled: a merged documentation pull request takes
   * its claim to `committed` and out of every prompt; one closed unmerged leaves it where
   * it was. Absent = nothing sweeps.
   */
  graduations?: { run(): void };
  clusters?: { run(): void };
  /**
   * Sends the obstacle notices owed to running agents. Absent = no mid-session channel. →
   * `docs/spec/27-obstacles.md#delivery`
   */
  obstacleNotices?: { run(): void };
  /**
   * Records the harness's own voice on the obstacle board. Absent = the harness never
   * speaks, and every row waits for two *agents* to hit it. →
   * `docs/spec/27-obstacles.md#the-harness-is-a-voice`
   */
  obstacleVoice?: { run(prev: WorldSnapshot | null, next: WorldSnapshot): void };
  /**
   * What a model may decide about the obstacle rows nobody has read lately. Absent =
   * nothing calls a model, and extraction stays mechanical. →
   * `docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not`
   */
  obstacleDesk?: { run(): Promise<void> };
  /**
   * Gives a standing obstacle an owner and lets a goal parked behind one back into pickup.
   * Absent = nothing owns anything. → `docs/spec/27-obstacles.md#ownership`
   */
  obstacleOwnership?: { run(world: WorldSnapshot): Promise<void> };
  /**
   * Ends an obstacle: a watched condition met on two consecutive real readings, the owner
   * landing, the reporter's clock, or dormancy. Absent = nothing ever ends. →
   * `docs/spec/27-obstacles.md#how-an-obstacle-ends`
   */
  obstacleEndings?: { run(world: WorldSnapshot): void };
  /**
   * The cross-fleet pool's one desk: polls everybody else's documents into the mirror and
   * publishes this fleet's when they have moved. Absent = no pool. →
   * `docs/spec/28-cross-fleet-pool.md#the-clocks`
   */
  pool?: PoolDesk;
  /**
   * Clears "Needs you" items whose agent has died. Absent = no sweep (tests that do not
   * care), and then only the terminal-state listeners tidy.
   */
  escalations?: { tidyDeadAgents(): unknown[] };
  /**
   * What an inbound delivery has said is stale since the last plan was built, drained into
   * this pulse's read plan. Absent = no ingress, and the lanes decide alone. →
   * `docs/spec/30-ingress.md#invalidating-precisely`
   */
  freshReads?: { drain(): string[] };
}

/**
 * Where a cycle came from. → `docs/spec/04-harness-cycle.md#the-local-cycle` `ingress` is a
 * real read like the first three, and is named apart from them for what it says rather than
 * what it does: a verified webhook delivery announced that something outside moved, so this
 * pulse carries an invalidation the timer's does not. A local cycle would be no use to it —
 * the thing it came to see is precisely the world a local cycle does not read. →
 * `docs/spec/30-ingress.md#triggering-a-pulse`
 */
type CycleSource = 'timer' | 'manual' | 'boot' | 'local' | 'ingress';

export interface CycleReport {
  cycleId: string;
  source: CycleSource;
  /** Whether this cycle read the outside world. */
  readWorld: boolean;
  /**
   * How long the heartbeat will wait before the next timer cycle, as this cycle left it. →
   * `docs/spec/04-harness-cycle.md#the-adaptive-cadence`
   */
  nextIntervalMs: number;
  rationale: string;
  summary: ExecutionSummary;
  at: string;
}

/** Did a cycle actually run? */
export function cycleRan(report: CycleReport): boolean {
  return report.cycleId.startsWith('cyc_');
}

/**
 * The heart of the system: each pulse snapshots the world and the fleet, asks the
 * dispatcher what to do, and runs the result through the executor, recording the rationale
 * so every cycle is explainable afterwards.
 */
interface HarnessEvents {
  'cycle:start': [{ cycleId: string; source: string }];
  'cycle:end': [CycleReport];
  'world:events': [{ events: WorldEvent[] }];
}

export class Harness extends EventEmitter {
  private readonly heartbeat: Heartbeat;
  private cycleInFlight = false;
  /**
   * An operator's cycle that arrived while one was already running — the trailing edge of
   * the coalescing guard below.
   */
  private pendingManual = false;
  /** Stopped, so a trailing cycle is never fired into a store on its way closed. */
  private stopped = false;
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
    this.heartbeat = new Heartbeat(
      () => this.intervalMs(),
      async (source) => {
        await this.runCycle(source);
      },
    );
  }

  /**
   * The gap before the next timer cycle: fast while the fleet is doing something, idle
   * while it is not.
   */
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
    // Before the hold and anything that can refuse to run: a held pulse is still a
    // beat the harness was alive for, and this is the only thing that dates a run
    // through a force close.
    this.deps.localRun?.noteAlive();
    // The crash-recovery hold, asked before anything else including the world fetch:
    // while orphaned agents are undecided the harness's model of its fleet is wrong,
    // so every verdict a pulse would reach is reached against a fiction. Held rather
    // than stopped — re-asked each beat, so the pulse resumes on its own. Emits
    // nothing, because no cycle ran.
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
      // Refused, and remembered: the running cycle read the world before this call's
      // write landed, so it cannot answer it (see {@link Harness.pendingManual}).
      // Only `manual` — the other sources' triggers retry a refusal themselves.
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
    // The local cycle's precondition: nothing to decide *against* until a real cycle
    // has read the world once. Never synthesized as an empty world, which every rule
    // would read as a tracker gone dark.
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
    // Hoisted so the failure path can report it: a cycle that threw still has to say
    // whether it was deciding against a fresh reading.
    const readWorld = cached === null;
    this.cycleInFlight = true;
    const cycleId = `cyc_${nanoid(8)}`;
    this.emit('cycle:start', { cycleId, source });
    try {
      const { store } = this.deps;
      // **The whole of what a local cycle changes is here and in the `readWorld`
      // guards below**: it decides against the last real cycle's snapshot and skips
      // every pass whose subject is that snapshot, since each already ran against it
      // and is idempotent. What is left is everything derived from the *store*. With
      // the executor's one exception, every awaited call below talks to the world.
      //
      // The read plan is a **cost** hint and never a filter: the same population
      // comes back either way. Built from the fleet as it stands before the desks
      // below run, which is a beat of lag on a hint and nothing else.
      // → `docs/spec/04-harness-cycle.md#hot-and-cold`
      const readPlan = readWorld
        ? buildReadPlan({
            previous: this.prevWorld ?? store.getWorldBaseline(),
            tasks: store.listTasks(),
            events: store.listWorldEvents(READ_PLAN_EVENTS),
            now: Date.now(),
            lanes: this.deps.readLanes,
            // Drained on the one path that builds a plan, so a delivery arriving
            // mid-cycle is picked up by the next one rather than by the read already
            // underway.
            fresh: this.deps.freshReads?.drain(),
          })
        : undefined;
      const observed = cached ?? (await this.deps.connector.getState(readPlan));
      // Read before the diff records it: the notice desk below needs the same *pair*
      // the diff is taken from, and `recordWorldChanges` moves the baseline on.
      // Seeded from the persisted baseline, or a restart goes blind to every
      // transition that straddled it.
      const previousWorld = readWorld ? (this.prevWorld ?? store.getWorldBaseline()) : observed;
      // Nothing to diff on a local cycle, and nothing to re-stamp: moving the
      // baseline onto itself would claim the world was read when it was not. The
      // baseline stays the **provider's own reading** — folding the operator's
      // overrides in would leave the harness unable to say what the provider said.
      if (readWorld) this.recordWorldChanges(store, observed, previousWorld);
      // The operator's reopened review threads, laid over that reading before
      // anything decides against it, so every desk and the dispatcher see one world.
      // The cockpit applies the same fold when it serves the snapshot.
      // → `docs/spec/07-pull-requests.md#reopening-a-thread`
      const world = applyThreadReopens(observed, store.prThreadReopens());
      // Fold observed reality onto the plan-part rows before anything reads them: a
      // part this moves to `ready` is dispatchable in this same cycle.
      if (readWorld) await this.deps.plans?.reconcile(world);
      // The harness's own pull requests, tagged as watched. A pull request tagged
      // here is worked from the *next* pulse, since this snapshot predates the label
      // — `open_pr` tags at creation, so this only catches strays.
      if (readWorld) await this.deps.prWatch?.run(world);
      // Beside the tagging: the tracker link the harness can supply from a row, so
      // the linked-work-items policy clears without a dispatch. Idempotent, with the
      // same one-pulse lag.
      if (readWorld) await this.deps.prWorkItems?.run(world);
      // Mechanical bookkeeping, like the plan's status comment: idempotent, so a
      // world already on convention writes nothing.
      if (readWorld) await this.deps.naming?.run(world);
      // One step later in a pull request's life: a merged branch is deleted locally
      // and on the remote. A rung the retarget just moved holds its parent's branch
      // one more pulse — the safe direction, and deliberately not closed by
      // re-reading: reaping a branch an open PR is based on destroys the stack.
      if (readWorld) await this.deps.branchReaps?.run(world);
      // What the world has made of the operator's standing stack landings. Before
      // `decide`, so a stopped intent cannot authorize a merge in the very cycle it
      // stopped — the executor reads the same rows a few lines later. It decides no
      // dispatch and does not rebuild the stack model (see `src/stacks/landing.ts`).
      this.deps.landings?.settle(world);
      // What a delivered goal owes a person: the fixtures and accounts its validation
      // plan needs and could not produce. It writes `human_tasks` rows and nothing else.
      this.deps.validationAsks?.run();
      // And the obligation those resources are for: a delivered goal with checks a
      // person still has to run says so on the bench. It writes `human_tasks` rows,
      // blocks nothing, and settles itself as results are recorded.
      this.deps.validationReady?.run(world);
      // A delivered goal whose ticket is still open owes a person one close. Staffs
      // nothing, and no rule reads what it writes.
      //
      // **Below the validation desk, and that ordering is load-bearing**: the
      // close-out waits on the goal's `validate` row being settled, and above this
      // line it would ask for the close on the pulse the delivery landed.
      // → `docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time`
      this.deps.closeOuts?.run(world);
      // A recurrence that has come due queues its job here, above the
      // `listQueuedJobs` the dispatcher decides from, so a firing is dispatched on
      // the pulse it fires. What it queues is an ordinary job, so the cap, the pause
      // flag and rule `manual-job` see a hand-launched one.
      this.deps.schedules?.run();
      // The harness reading its own build — the only pass about *this process*
      // rather than the world, so nothing downstream reads it. Awaited but never
      // blocking: a check that fails records itself rather than throwing.
      if (readWorld) await this.deps.updates?.run();
      // Record what the world and the store now say happened: after the reconciler so
      // part→PR observations are fresh, before `decide` so stage 2 can read it.
      // Never deletes — `closedPullRequests` forgets a merge and the graph must not.
      this.deps.graph?.record(world);
      // Where that work has got to: the commit each merged pull request landed as,
      // attributed to its goal, and what the environment probes say.
      //
      // **Immediately below the graph record, and that ordering is load-bearing** —
      // attribution walks `parentRef` up to the goal, so a graph one pulse stale
      // resolves nothing for a pull request whose issue is already closed.
      // → `docs/spec/24-environments.md#recording-a-landing`
      if (readWorld) await this.deps.environments?.run(world);
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
      // Skipped on a local cycle, and not for the provider-traffic reason the
      // others are: it is handed the *pair* the diff was taken from, and a local
      // cycle takes no diff. Run with `previousWorld === world` it would read every
      // notice as settled by a world that has not moved.
      if (readWorld) this.deps.notices?.run(previousWorld, world);
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
      // What the harness has seen for itself on the board the agents read: a check
      // red on a branch other pull requests are based on, a check flapping
      // red-then-green on one commit. **The harness is one of the two voices**, so
      // a row it can see is standing from the first agent's report rather than the
      // second — which is what makes the two-goal gate safe on a small fleet.
      //
      // **Skipped on a local cycle**, for the endings desk's reason rather than the
      // provider-traffic one: it is handed the *pair* the diff was taken from, and
      // a local cycle takes no diff. Run with `previousWorld === world` it would
      // read every transition as new or as none.
      //
      // **Above the three desks below it**, and every half of that matters: a row
      // filed here is one the notice desk may tell a running agent about, one the
      // ownership desk may take up, and one the endings desk promises to watch a
      // condition for — all on the pulse that saw it rather than the next.
      if (readWorld) this.deps.obstacleVoice?.run(previousWorld, world);
      // What a model may decide about the rows the board has not had read since a
      // voice last landed words on one — the keys in their prose, a merge the keys
      // missed, what each is for, and the ticket written from the sightings.
      //
      // **Not awaited**, alone among the desks here, and that is the whole of what
      // its position in the pulse means. A model round trip is not a provider's:
      // nothing below waits on a reading, and a pulse that blocked on one would
      // hold every dispatch behind a call this subsystem makes for its own
      // convenience. What it writes is read by the pulse that finds it written,
      // which for a suggestion nobody is bound by and a ticket nobody has filed yet
      // is a pulse either way. It runs one pass at a time and never rejects.
      void this.deps.obstacleDesk?.run();
      // What has changed about an obstacle since the agents now running were
      // dispatched — their own reports being taken up or settled, and what a
      // second voice has since corroborated on the checks they are working.
      //
      // **Above `decide` and above the executor**, for `notices`' reason exactly:
      // the block a dispatch carries is rendered at launch a few lines below, so
      // an agent dispatched on this pulse reads what is on the board rather than
      // being told it again a moment later. Beside the other bookkeeping and not
      // in the dispatcher for `closeOuts`' reason — it staffs nobody, and no rule
      // reads what it writes.
      this.deps.obstacleNotices?.run();
      // Who owns each of them, and which goals the board has let back out.
      //
      // **Above `decide`**, and both halves matter: a block cleared here is a goal
      // rule `issue-pickup` sees this pulse rather than next, and a row owned here
      // reads as owned in the prompt of every dispatch composed a few lines below
      // — an agent told *do not fix it, #841 has it* on the pulse the ticket was
      // filed rather than a pulse later. Below the notices for the same reason
      // they sit above `decide`: an agent whose report was taken up is told so by
      // the pulse that took it. Awaited but never blocking — every failure inside
      // is recorded and non-fatal, and a tracker that will not answer costs the
      // ticket and nothing else.
      await this.deps.obstacleOwnership?.run(world);
      // And how each of them ends: a condition the harness promised to watch, the
      // owner landing, the reporter's clock, or nothing having said it for a week.
      //
      // **Skipped on a local cycle, and not for the provider-traffic reason most of
      // the others are.** A resolution fires on two consecutive *real* world
      // readings, and the resolving read is never one the local cycle served: a
      // local cycle re-serves the snapshot the last real one read, so counting it
      // would take one reading twice and close an obstacle that is still live —
      // the fleet then pays for it again, and nothing is red.
      //
      // **Below the ownership desk**, because it reads the owner the desk above may
      // have just written, and above `decide` for the notice desk's reason: a row
      // resolved here has left the prompt of every dispatch composed a few lines
      // below, rather than being told to one more agent and taken back a pulse
      // later. Every failure inside is recorded and non-fatal.
      if (readWorld) this.deps.obstacleEndings?.run(world);
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
      if (readWorld) await this.deps.pool?.run();
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
      // and nothing else is read for it: the one thing that ends an `unclear`
      // verdict is the ticket's own text, which the world snapshot already carries.
      const appraisals = store.listAppraisals();
      // Put the appraisal's checklist where the person who wrote the ticket will see
      // it. After the read above so it judges the same verdicts the dispatcher will,
      // and before `decide` only because everything else on the pulse is — it
      // changes no decision, and a failure is recorded rather than thrown.
      if (readWorld) await this.deps.appraisals?.announce(world);
      // The area tree, if its own TTL says it is stale — otherwise a no-op. Here
      // rather than on a timer of its own for the reason every other periodic read
      // is on the pulse: a timer keeps firing across a drain and an upgrade
      // handoff. A failure is recorded inside and never thrown, so a provider that
      // will not answer costs the placement question and nothing else.
      if (readWorld) await this.deps.areaPaths?.refresh();
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
      const liveAgents = store.countLiveAgents();
      const headroom = this.deps.runtime.paused ? 0 : Math.max(0, this.deps.runtime.cap - liveAgents);

      // Two reasons a pull request is not the fleet's to touch, and one gate.
      //
      // Without the watch tag nobody opted it in — the harness's own are tagged as
      // they are opened (`src/prWatch.ts`), so what is left is work an operator has
      // taken off the fleet. And a pull request a *colleague* opened is never the
      // fleet's however it is tagged: `ownWorkOnly` widens the fetch to the ones
      // somebody assigned the operator, which is how another team's review threads
      // reached rule `pr-review-comment` and got answered by an agent. The provider
      // says which those are (`PullRequest.viewerAuthored`); a provider that cannot
      // say hides nothing, so the tag stays the only gate on those deployments.
      //
      // Hidden from the dispatch view so *both* dispatchers leave them alone
      // uniformly — no CI fix, base update, comment note, reply or merge. The world
      // used for diffing/baseline above is untouched, and the cockpit snapshot reads
      // the connector directly, so a hidden PR stays fully visible (with its health
      // and its tags) — it is just not acted on.
      const label = this.deps.prWatchLabel;
      const actedOn = (pr: PullRequest): boolean => isPrWatched(pr, label) && !isSomeoneElsesPr(pr);
      const hiddenPrs = world.pullRequests.filter((pr) => !actedOn(pr));

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
        hiddenPrs.length > 0 || retainedIssues.length > 0
          ? {
              ...world,
              pullRequests: world.pullRequests.filter(actedOn),
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

      // Has somebody *outside* the harness already read this pull request? Asked
      // here rather than in a rule because it is a process spawn and the rules are
      // pure and synchronous — and
      // asked only of the pull requests a review would otherwise be dispatched for
      // this pulse, which is what keeps the cost to the handful of pulses between a
      // pull request appearing and its review landing rather than one spawn per open
      // pull request for ever. → `src/review/reviewedElsewhere.ts`
      if (readWorld) await this.askReviewedElsewhere(store, dispatchWorld);

      // Above the dispatch, so the rule below never proposes an agent for a row this
      // beat is about to abandon: a validation whose environment was stopped or
      // swapped is settled here, and the two arms then read the same table in the
      // same state. The runner's own `changed` calls it too, so the usual case is
      // that this finds nothing to do.
      this.deps.localValidations?.sweep();

      const plan = await this.deps.dispatcher.decide({
        world: dispatchWorld,
        // Which of `world.issues` above are retained runs rather than the tracker's
        // own answer. A number list, not a flag on the issue: `Issue` is what the
        // connector returned, and a synthesized field on it would be indistinguishable
        // from one a provider set.
        retainedIssues: retainedIssues.map((i) => i.number),
        // Hidden from dispatch, but still open — the issue-pickup gate has to see
        // them or a hidden PR reads as merged and its issue gets a second agent.
        hiddenPrs,
        tasks,
        agents,
        openEscalations,
        queuedJobs,
        standingJobs,
        plans,
        planParts,
        // Changes proposed to plans that are already running, waiting on the
        // operator. Only the pending ones: rule `plan-amendment` reads nothing
        // else, and a settled amendment is history the cockpit reads out of the
        // plan sheet rather than off the pulse.
        planAmendments: store.listPendingPlanAmendments(),
        // How anyone checks each goal was met. Rule `validate-check` reads only
        // whether a check was handed to the fleet and whether anybody has
        // recorded a reading against it — never what it says.
        validationChecks: store.listAllValidationChecks(),
        // The one dev environment on this machine, and the validations pinned to
        // it. Rule `local-validation` reads both to answer the question its own row
        // cannot: is the environment this reading was planned against still the one
        // that is up. Nothing else in the pipeline knows local runs exist.
        localRun: store.liveLocalRun(),
        localValidations: [...store.listOpenLocalValidations(), ...store.listLocalValidationsAwaitingFix()],
        conclusions,
        deliveries,
        deliverySignals,
        shortfalls,
        appraisals,
        // Which goals already have a write-up — origins only. Rule `issue-retro` needs to know
        // whether to dispatch one; what it says is deliberately out of its reach.
        retrospectiveOrigins,
        // Standings and digests only — never a word of what a summary says, for
        // `retrospectiveOrigins`' reason one line up.
        featureStandings,
        featureSummaryKeys,
        // One read for both halves of sequencing: the key rule `feature-sequence`
        // compares against, and the edges an accepted order holds work with. Cheap
        // and unconditional — two small tables, and gating it on the config here
        // would be a second opinion about whether the feature is on.
        featureSequences: store.listFeatureSequences(),
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
        // What the fleet has already read. One list per pulse rather than a
        // lookup per pull request, and the same list the merge gate asks — a
        // second read here would be a second opinion about what has been
        // reviewed.
        prReviews: store.listPrReviews(),
        prReviewRoutes: store.listPrReviewRoutes(),
        prReviewedElsewhere: store.prsReviewedElsewhere(),
        // The obstacle board, and the goals parked behind one. Rule
        // `obstacle-repair` is the only rule that reads the first; the second
        // gates pickup, exactly as a delivery verdict does. Read here beside every
        // other store read, so the cycle stays the only thing that touches the
        // store — and read *after* the ownership desk above, so a block it cleared
        // this pulse is a goal the funnel sees now.
        obstacles: store.obstacleBoard(),
        obstacleBlocks: store.listObstacleBlocks(),
        // The goal tags and the profiles they may name, so a dispatch on a pinned
        // issue is priced by the pin rather than by its rule.
        modelPins: this.deps.modelPins,
        agentHeadroom: headroom,
      });

      this.lastPlan = plan.upcoming ? { cycleId, at: world.takenAt, items: plan.upcoming } : null;

      // What the next wait is going to be. Busy is "there is something whose next
      // state this fleet is waiting on": an agent running, work queued behind it,
      // a queued job, or a build in flight — the last because a check going green
      // is the commonest thing an idle-looking fleet is actually waiting for, and
      // it arrives with no token moving anywhere. Everything else is idle, and an
      // idle fleet still looks: what ends the idleness (an issue filed, a review
      // left) is outside, it just does not need looking at every thirty seconds.
      //
      // Read from this cycle's own inputs rather than taken separately, so the
      // cadence can never be decided against a different pulse than the dispatch
      // was.
      //
      // A queued candidate counts only when the thing holding it is the fleet
      // itself — headroom, a cooldown, a plan's own concurrency cap, or nothing at
      // all. A candidate held `unapproved` is waiting on a **person**, and a fleet
      // that polls every thirty seconds because somebody has not clicked yet is a
      // fleet that never goes idle: the click is not a thing any provider read can
      // discover, and the pulse is not what delivers it.
      const working = (plan.upcoming ?? []).some(
        (item) => item.status !== 'unapproved' && item.status !== 'superseded',
      );
      this.busy =
        liveAgents > 0 ||
        queuedJobs.length > 0 ||
        working ||
        world.pullRequests.some((pr) => pr.ciStatus === 'pending');

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
      // The trailing edge of the coalescing guard. Fired and not awaited, because
      // the route that asked for it has long since had its `coalesced` report back
      // — what it is owed is a cycle that starts after its write, not a response
      // held open for two of them. `runCycle` records its own failures and returns
      // rather than throwing, so there is nothing here for a rejection to escape
      // through; `stopped` is what keeps it out of a store on its way closed.
      if (this.pendingManual && !this.stopped) {
        this.pendingManual = false;
        void this.runCycle('manual');
      }
    }
  }

  /**
   * Diff this cycle's world against the previous snapshot, persist every observed
   * transition, and stream them to the cockpit. → it only records the baseline (no diff, no
   * spurious "everything is new" flood). `prev` is passed in rather than read here because
   * the pulse has a second reader of the same pair — the knowledge notice desk — and this
   * call moves the baseline on. One read, handed to both, so the two cannot come to be
   * looking at different pulses.
   */
  /**
   * Ask the operator's check which of this pulse's would-be reviews have already happened
   * elsewhere, and record the ones that have. A verdict that said **nothing** goes on the
   * error log and leaves the fleet reviewing.
   */
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
    // The window's rows, kept past the window. `closedPullRequests` carries a pull
    // request for `closedPrWindowMs` and then forgets it, and a goal's page drew its
    // closed rows off that list alone — so a goal delivered last month said no pull
    // request had ever named it. Written here rather than on the merge itself for
    // the reason `LandingDesk` sweeps: a hook on the transition loses every close
    // that happened while the harness was down, while the window re-reports one for
    // hours. → `docs/spec/14-persistence.md#the-closed-pull-request-archive`
    store.archiveClosedPrs(world.closedPullRequests ?? []);
  }

  // Typed emit/on overrides for a nicer call site (repo convention).
  override emit<K extends keyof HarnessEvents>(event: K, ...args: HarnessEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof HarnessEvents>(event: K, listener: (...args: HarnessEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
