import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import { systemClock, type Clock, type StoreContext } from './context.js';
import { dropRetiredTables, ensureColumns, rebuildTables, renameTables } from './migrate.js';
import { POOL_RETIRED_TABLES, PoolStore } from './pool.js';
import { backfillTaskDispatchKind, TaskStore, TASK_COLUMNS } from './tasks.js';
import { JobStore, JOB_COLUMNS } from './jobs.js';
import { JobScheduleStore, JOB_SCHEDULE_COLUMNS } from './schedules.js';
import { PauseStore } from './pauses.js';
import { EjectionStore, EJECTION_COLUMNS } from './ejections.js';
import { PriorityStore } from './priority.js';
import { ProfileOverrideStore } from './profileOverrides.js';
import { RemedyStore } from './remedies.js';
import { McpCallStore } from './mcpCalls.js';
import { SurfaceReachStore } from './surfaceReach.js';
import { HumanTaskStore, HUMAN_TASK_COLUMNS } from './humanTasks.js';
import { absorbSinglePlanStatus, backfillWholePlanParts, PlanStore, PLAN_COLUMNS } from './plans.js';
import { ValidationStore, VALIDATION_COLUMNS, VALIDATION_REBUILDS } from './validation.js';
import { IssueVerdictStore, ISSUE_VERDICT_COLUMNS, ISSUE_VERDICT_RENAMES } from './issueVerdicts.js';
import { ScratchStore, SCRATCH_COLUMNS } from './scratch.js';
import { ReviewPackStore, REVIEW_PACK_COLUMNS } from './reviewPacks.js';
import { RateLimitStore } from './rateLimits.js';
import { UpgradeStore } from './upgrades.js';
import { openPetsFromBeforeEggs, PetStore, PET_COLUMNS } from './pets.js';
import { InstructionStore } from './instructions.js';
import { AgentStore, AGENT_COLUMNS } from './agents.js';
import { TranscriptStore } from './transcripts.js';
import { EscalationStore } from './escalations.js';
import { StackLandingStore } from './landings.js';
import { BranchReapStore } from './branchReaps.js';
import { dropPartialGoalArrivals, ENVIRONMENT_COLUMNS, EnvironmentStore, repairPartRefGoals } from './environments.js';
import { dateInterruptionsFromBeforeTheStamp, LocalRunStore, LOCAL_RUN_COLUMNS } from './localRuns.js';
import { LocalValidationStore, LOCAL_VALIDATION_COLUMNS } from './localValidations.js';
import { WatchStore, WATCH_COLUMNS } from './watches.js';
import { RemoteValidationStore, REMOTE_VALIDATION_COLUMNS } from './remoteValidation.js';
import { PrWatchSeedStore } from './prWatchSeeds.js';
import { WorkItemLinkStore } from './workItemLinks.js';
import { ReviewWaitStore } from './reviewWaits.js';
import { PrReviewStore, PR_REVIEW_COLUMNS } from './prReviews.js';
import { PrReviewRouteStore, PR_REVIEW_ROUTE_COLUMNS } from './prReviewRoutes.js';
import { PrReviewExternalStore } from './prReviewExternals.js';
import { PrSplitStore } from './prSplits.js';
import { PrThreadReopenStore } from './prThreadReopens.js';
import { PrReplyStore } from './prReplies.js';
import { PrArchiveStore } from './prArchive.js';
import { ObstacleStore, OBSTACLE_COLUMNS } from './obstacles.js';
import { DecisionStore, DECISION_COLUMNS } from './decisions.js';
import { WorldStore } from './world.js';
import { ErrorStore } from './errors.js';
import { GraphStore, GRAPH_REBUILDS } from './graph.js';
import { BugFilingStore } from './bugFilings.js';
import { adoptFloorCompletions, FloorStore, FLOOR_COLUMNS } from './floor.js';
import { TicketStore, TICKET_COLUMNS } from './tickets.js';
import { SequenceStore, SEQUENCE_COLUMNS } from './sequences.js';
import type { Job, CostDelta } from '../types.js';

// → docs/spec/14-persistence.md

export class Store {
  private readonly db: Database.Database;
  readonly tasks: TaskStore;
  readonly jobs: JobStore;
  readonly schedules: JobScheduleStore;
  readonly priority: PriorityStore;
  readonly pauses: PauseStore;
  readonly ejections: EjectionStore;
  readonly profileOverrides: ProfileOverrideStore;
  readonly remedies: RemedyStore;
  readonly mcpCalls: McpCallStore;
  readonly surfaceReach: SurfaceReachStore;
  readonly humanTasks: HumanTaskStore;
  readonly plans: PlanStore;
  readonly validation: ValidationStore;
  readonly verdicts: IssueVerdictStore;
  readonly instructions: InstructionStore;
  readonly scratch: ScratchStore;
  readonly reviewPacks: ReviewPackStore;
  readonly rateLimits: RateLimitStore;
  readonly agents: AgentStore;
  readonly transcripts: TranscriptStore;
  readonly escalations: EscalationStore;
  readonly landings: StackLandingStore;
  readonly branchReaps: BranchReapStore;
  readonly environments: EnvironmentStore;
  readonly watches: WatchStore;
  readonly remoteValidation: RemoteValidationStore;
  readonly localRuns: LocalRunStore;
  readonly localValidations: LocalValidationStore;
  readonly prWatchSeeds: PrWatchSeedStore;
  readonly workItemLinks: WorkItemLinkStore;
  readonly reviewWaits: ReviewWaitStore;
  readonly prReviews: PrReviewStore;
  readonly prReviewRoutes: PrReviewRouteStore;
  readonly prReviewExternals: PrReviewExternalStore;
  readonly prSplits: PrSplitStore;
  readonly threadReopens: PrThreadReopenStore;
  readonly prReplies: PrReplyStore;
  readonly prArchive: PrArchiveStore;
  readonly obstacles: ObstacleStore;
  readonly decisions: DecisionStore;
  readonly world: WorldStore;
  readonly errors: ErrorStore;
  readonly graph: GraphStore;
  readonly bugFilings: BugFilingStore;
  readonly floor: FloorStore;
  readonly tickets: TicketStore;
  readonly sequences: SequenceStore;
  readonly upgrades: UpgradeStore;
  readonly pets: PetStore;
  readonly pool: PoolStore;

  constructor(dbPath: string, clock: Clock = systemClock) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    renameTables(this.db, ISSUE_VERDICT_RENAMES);
    dropRetiredTables(this.db, POOL_RETIRED_TABLES);
    rebuildTables(this.db, [...VALIDATION_REBUILDS, ...GRAPH_REBUILDS], () => this.db.exec(SCHEMA));
    const addedColumns: string[] = [];
    for (const columns of [
      TASK_COLUMNS,
      AGENT_COLUMNS,
      DECISION_COLUMNS,
      HUMAN_TASK_COLUMNS,
      PLAN_COLUMNS,
      VALIDATION_COLUMNS,
      JOB_COLUMNS,
      JOB_SCHEDULE_COLUMNS,
      ISSUE_VERDICT_COLUMNS,
      FLOOR_COLUMNS,
      TICKET_COLUMNS,
      PET_COLUMNS,
      LOCAL_RUN_COLUMNS,
      LOCAL_VALIDATION_COLUMNS,
      ENVIRONMENT_COLUMNS,
      WATCH_COLUMNS,
      REMOTE_VALIDATION_COLUMNS,
      PR_REVIEW_ROUTE_COLUMNS,
      PR_REVIEW_COLUMNS,
      SCRATCH_COLUMNS,
      REVIEW_PACK_COLUMNS,
      OBSTACLE_COLUMNS,
      SEQUENCE_COLUMNS,
      EJECTION_COLUMNS,
    ]) {
      addedColumns.push(...ensureColumns(this.db, columns));
    }
    if (addedColumns.includes('pets.opened_at')) openPetsFromBeforeEggs(this.db);
    if (addedColumns.includes('local_runs.interrupted_at')) dateInterruptionsFromBeforeTheStamp(this.db, clock());
    adoptFloorCompletions(this.db);
    absorbSinglePlanStatus(this.db);
    backfillWholePlanParts(this.db, clock());
    backfillTaskDispatchKind(this.db);
    repairPartRefGoals(this.db);
    const partialGoalRefs = this.db
      .prepare(
        `SELECT DISTINCT plans.origin_ref AS goal_ref
         FROM plan_parts
         JOIN plans ON plans.id = plan_parts.plan_id
         WHERE plans.status <> 'abandoned'
           AND plan_parts.status NOT IN ('retired', 'merged', 'concluded')
           AND (plan_parts.expected_kind IS NULL OR plan_parts.expected_kind = 'code')`,
      )
      .all() as { goal_ref: string }[];
    dropPartialGoalArrivals(
      this.db,
      partialGoalRefs.map((row) => row.goal_ref),
    );
    const ctx: StoreContext = { db: this.db, now: clock };
    this.tasks = new TaskStore(ctx);
    this.jobs = new JobStore(ctx);
    this.schedules = new JobScheduleStore(ctx);
    this.priority = new PriorityStore(ctx);
    this.pauses = new PauseStore(ctx);
    this.ejections = new EjectionStore(ctx);
    this.profileOverrides = new ProfileOverrideStore(ctx);
    this.pool = new PoolStore(ctx);
    this.remedies = new RemedyStore(ctx);
    this.mcpCalls = new McpCallStore(ctx);
    this.surfaceReach = new SurfaceReachStore(ctx);
    this.humanTasks = new HumanTaskStore(ctx);
    this.plans = new PlanStore(ctx);
    this.validation = new ValidationStore(ctx);
    this.verdicts = new IssueVerdictStore(ctx);
    this.instructions = new InstructionStore(ctx);
    this.scratch = new ScratchStore(ctx);
    this.reviewPacks = new ReviewPackStore(ctx);
    this.rateLimits = new RateLimitStore(ctx);
    this.agents = new AgentStore(ctx);
    this.transcripts = new TranscriptStore(ctx);
    this.escalations = new EscalationStore(ctx);
    this.landings = new StackLandingStore(ctx);
    this.branchReaps = new BranchReapStore(ctx);
    this.environments = new EnvironmentStore(ctx);
    this.watches = new WatchStore(ctx);
    this.remoteValidation = new RemoteValidationStore(ctx);
    this.localRuns = new LocalRunStore(ctx);
    this.localValidations = new LocalValidationStore(ctx);
    this.prWatchSeeds = new PrWatchSeedStore(ctx);
    this.workItemLinks = new WorkItemLinkStore(ctx);
    this.reviewWaits = new ReviewWaitStore(ctx);
    this.prReviews = new PrReviewStore(ctx);
    this.prReviewRoutes = new PrReviewRouteStore(ctx);
    this.prReviewExternals = new PrReviewExternalStore(ctx);
    this.prSplits = new PrSplitStore(ctx);
    this.threadReopens = new PrThreadReopenStore(ctx);
    this.prReplies = new PrReplyStore(ctx);
    this.prArchive = new PrArchiveStore(ctx);
    this.obstacles = new ObstacleStore(ctx);
    this.decisions = new DecisionStore(ctx);
    this.world = new WorldStore(ctx);
    this.errors = new ErrorStore(ctx);
    this.graph = new GraphStore(ctx);
    this.bugFilings = new BugFilingStore(ctx);
    this.floor = new FloorStore(ctx);
    this.tickets = new TicketStore(ctx);
    this.sequences = new SequenceStore(ctx);
    this.upgrades = new UpgradeStore(ctx);
    this.pets = new PetStore(ctx);
  }

  get open(): boolean {
    return this.db.open;
  }

  close(): void {
    this.transcripts.flushAll();
    this.db.close();
  }

  sumUsageCostSince(sinceIso: string): number {
    return this.agents.sumUsageCostSince(sinceIso) + this.localRuns.sumLocalRunCostSince(sinceIso);
  }
  listCostDeltasSince(sinceIso: string): CostDelta[] {
    return [
      ...this.agents.listUsageEventsSince(sinceIso).map((e) => ({ costUsd: e.costUsd, at: e.at })),
      ...this.localRuns.listLocalRunCostDeltasSince(sinceIso),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }

  writeUpObstacle(obstacleId: string, work: { title: string; prompt: string }): Job {
    const write = this.db.transaction((): Job => {
      const job = this.jobs.createJob({ title: work.title, prompt: work.prompt, kind: 'code' });
      this.obstacles.recordObstacleWriteUp(obstacleId, job.id);
      return job;
    });
    return write();
  }
}
