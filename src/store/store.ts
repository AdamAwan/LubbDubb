import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import { systemClock, type Clock, type StoreContext } from './context.js';
import { dropRetiredTables, ensureColumns, rebuildTables, renameTables } from './migrate.js';
import { POOL_RETIRED_TABLES, PoolStore, type PoolDigestMirrorRow } from './pool.js';
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
import { ReviewPackStore, REVIEW_PACK_COLUMNS, type ReviewPackHead } from './reviewPacks.js';
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
import { ObstacleStore, OBSTACLE_COLUMNS, type ObstacleOutcome } from './obstacles.js';
import type { PrThreadReopen } from '../prThreads.js';
import { DecisionStore, DECISION_COLUMNS } from './decisions.js';
import { WorldStore, type WorldLabelPatch } from './world.js';
import { ErrorStore } from './errors.js';
import { GraphStore, GRAPH_REBUILDS } from './graph.js';
import { BugFilingStore } from './bugFilings.js';
import { adoptFloorCompletions, FloorStore, FLOOR_COLUMNS } from './floor.js';
import {
  TicketStore,
  TICKET_COLUMNS,
  type LiveTicketFacts,
  type MirroredTicket,
  type TicketClosure,
  type TicketLabelPatch,
  type TrackerSweepMark,
} from './tickets.js';
import { SequenceStore, SEQUENCE_COLUMNS } from './sequences.js';
import type {
  AccountRateLimits,
  Agent,
  AgentFile,
  AgentFileInput,
  AgentFlag,
  AgentFlagInput,
  AgentUsage,
  Decision,
  Ejection,
  EnvironmentReachStatus,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  EnvironmentHealthState,
  EnvironmentHealthTier,
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
  GoalWatch,
  GoalWatchInput,
  IssueAppraisal,
  ErrorLogEntry,
  ErrorLogInput,
  Escalation,
  EscalationSpan,
  GoalFile,
  GoalNeighbour,
  HumanTask,
  HumanTaskKind,
  HumanTaskStatus,
  IssueRun,
  IssueConclusion,
  IssueInstruction,
  IssueDelivery,
  IssueShortfall,
  Job,
  JobAttachment,
  JobSchedule,
  PoolDigestDocument,
  PoolClockKind,
  PoolFleetReading,
  PoolPublication,
  Remedy,
  RemedyInput,
  RemedyKind,
  McpCall,
  McpCallInput,
  SurfaceReach,
  SurfaceReachInput,
  CostDelta,
  LocalRun,
  LocalValidation,
  LocalValidationFinding,
  LocalRunStatus,
  LocalRunUsageDelta,
  Pet,
  PetAction,
  PetActionKind,
  PetReset,
  PetSpecies,
  Plan,
  PlanPart,
  PlanPartInput,
  PullRequest,
  PlanAmendment,
  PlanCaveatAnswer,
  PlanRevision,
  FeatureSequence,
  FeatureSummary,
  Retrospective,
  ScratchEntry,
  ScratchPadSummary,
  ReviewMark,
  ReviewPack,
  ReviewPackRecord,
  ReviewPackShare,
  GoalPause,
  GoalPriority,
  PlanStatus,
  PriorityOverride,
  ProfileOverride,
  Proposal,
  StackLanding,
  StackLandingStatus,
  Task,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchWindow,
  TrackerItem,
  UpgradeIntent,
  TaskSummary,
  UsageEvent,
  ValidationAmendment,
  ValidationAmendResult,
  ValidationCheck,
  ValidationCheckActor,
  ValidationCheckResultBy,
  ValidationCheckState,
  PrReview,
  PrReviewInput,
  PrReviewRoute,
  PrReviewRouteInput,
  PrSplitVerdict,
  PrSplitVerdictInput,
  ValidationResource,
  WorkNode,
  WorkNodeObservation,
  WorkItemFiling,
  BugFiling,
  Obstacle,
  ObstacleBlock,
  ObstacleCondition,
  ObstacleDeskReading,
  ObstacleEnding,
  ObstacleKey,
  ObstacleSighting,
  ObstacleStanding,
  ObstacleWriteUp,
  ObstacleWriteUpOutcome,
  WorldEvent,
  WorldEventInput,
  WorldEventKind,
  WorldSnapshot,
} from '../types.js';

// → docs/spec/14-persistence.md

export class Store {
  private readonly db: Database.Database;
  private readonly tasksStore: TaskStore;
  private readonly jobs: JobStore;
  private readonly schedules: JobScheduleStore;
  private readonly priority: PriorityStore;
  private readonly pauses: PauseStore;
  private readonly ejections: EjectionStore;
  private readonly profileOverrides: ProfileOverrideStore;
  private readonly remedies: RemedyStore;
  private readonly mcpCalls: McpCallStore;
  private readonly surfaceReach: SurfaceReachStore;
  private readonly humanTasks: HumanTaskStore;
  private readonly plans: PlanStore;
  private readonly validation: ValidationStore;
  private readonly verdicts: IssueVerdictStore;
  private readonly instructions: InstructionStore;
  private readonly scratch: ScratchStore;
  private readonly reviewPacks: ReviewPackStore;
  private readonly rateLimits: RateLimitStore;
  private readonly agents: AgentStore;
  private readonly transcripts: TranscriptStore;
  private readonly escalations: EscalationStore;
  private readonly landings: StackLandingStore;
  private readonly branchReaps: BranchReapStore;
  private readonly environments: EnvironmentStore;
  private readonly watches: WatchStore;
  private readonly localRuns: LocalRunStore;
  private readonly localValidations: LocalValidationStore;
  private readonly prWatchSeeds: PrWatchSeedStore;
  private readonly workItemLinks: WorkItemLinkStore;
  private readonly reviewWaitStore: ReviewWaitStore;
  private readonly prReviews: PrReviewStore;
  private readonly prReviewRoutes: PrReviewRouteStore;
  private readonly prReviewExternals: PrReviewExternalStore;
  private readonly prSplits: PrSplitStore;
  private readonly threadReopens: PrThreadReopenStore;
  private readonly prReplies: PrReplyStore;
  private readonly prArchive: PrArchiveStore;
  private readonly obstacles: ObstacleStore;
  private readonly decisions: DecisionStore;
  private readonly world: WorldStore;
  private readonly errors: ErrorStore;
  private readonly graph: GraphStore;
  private readonly bugFilings: BugFilingStore;
  private readonly floor: FloorStore;
  private readonly tickets: TicketStore;
  private readonly sequences: SequenceStore;
  private readonly upgrades: UpgradeStore;
  private readonly pets: PetStore;
  private readonly pool: PoolStore;

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
    this.tasksStore = new TaskStore(ctx);
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
    this.localRuns = new LocalRunStore(ctx);
    this.localValidations = new LocalValidationStore(ctx);
    this.prWatchSeeds = new PrWatchSeedStore(ctx);
    this.workItemLinks = new WorkItemLinkStore(ctx);
    this.reviewWaitStore = new ReviewWaitStore(ctx);
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

  createTask(...args: Parameters<TaskStore['createTask']>): Task {
    return this.tasksStore.createTask(...args);
  }
  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'agentId' | 'branch'>>): void {
    this.tasksStore.updateTask(id, patch);
  }
  getTask(id: string): Task | null {
    return this.tasksStore.getTask(id);
  }
  listTasks(): TaskSummary[] {
    return this.tasksStore.listTasks();
  }

  listGoalTasks(goalRef: string, prRefs: readonly string[]): TaskSummary[] {
    return this.tasksStore.listGoalTasks(goalRef, prRefs);
  }
  countTasksNamingTools(since: string, names: readonly string[]): Map<string, number> {
    return this.tasksStore.countTasksNamingTools(since, names);
  }
  listOutstandingTasks(): Task[] {
    return this.tasksStore.listOutstandingTasks();
  }
  findActiveTaskByOrigin(originRef: string): Task | null {
    return this.tasksStore.findActiveTaskByOrigin(originRef);
  }
  findActiveTaskByBranch(branch: string): Task | null {
    return this.tasksStore.findActiveTaskByBranch(branch);
  }

  createJob(input: Parameters<JobStore['createJob']>[0]): Job {
    return this.jobs.createJob(input);
  }
  getJob(id: string): Job | null {
    return this.jobs.getJob(id);
  }
  listJobs(limit?: number): Job[] {
    return this.jobs.listJobs(limit);
  }
  jobLabels(ids: string[]): Map<string, string> {
    return this.jobs.jobLabels(ids);
  }
  listQueuedJobs(): Job[] {
    return this.jobs.listQueuedJobs();
  }
  listStandingJobs(): Job[] {
    return this.jobs.listStandingJobs();
  }
  findStandingJobByOrigin(originRef: string): Job | null {
    return this.jobs.findStandingJobByOrigin(originRef);
  }
  markJobDispatched(id: string, taskId: string): void {
    this.jobs.markJobDispatched(id, taskId);
  }
  cancelJob(id: string): Job | null {
    return this.jobs.cancelJob(id);
  }
  addAttachments(targetRef: string, files: Parameters<JobStore['addAttachments']>[1]): JobAttachment[] {
    return this.jobs.addAttachments(targetRef, files);
  }
  listAttachments(targetRef: string): JobAttachment[] {
    return this.jobs.listAttachments(targetRef);
  }
  getAttachment(id: string): JobAttachment | null {
    return this.jobs.getAttachment(id);
  }
  listAllAttachments(): JobAttachment[] {
    return this.jobs.listAllAttachments();
  }
  deleteAttachments(targetRef: string): void {
    this.jobs.deleteAttachments(targetRef);
  }

  createJobSchedule(input: Parameters<JobScheduleStore['createJobSchedule']>[0]): JobSchedule {
    return this.schedules.createJobSchedule(input);
  }
  getJobSchedule(id: string): JobSchedule | null {
    return this.schedules.getJobSchedule(id);
  }
  listJobSchedules(): JobSchedule[] {
    return this.schedules.listJobSchedules();
  }
  updateJobSchedule(id: string, patch: Parameters<JobScheduleStore['updateJobSchedule']>[1]): JobSchedule | null {
    return this.schedules.updateJobSchedule(id, patch);
  }
  recordJobScheduleRun(id: string, run: Parameters<JobScheduleStore['recordJobScheduleRun']>[1]): void {
    this.schedules.recordJobScheduleRun(id, run);
  }
  deleteJobSchedule(id: string): boolean {
    return this.schedules.deleteJobSchedule(id);
  }

  setPriorityOverrides(origins: string[]): void {
    this.priority.setPriorityOverrides(origins);
  }
  listPriorityOverrides(): PriorityOverride[] {
    return this.priority.listPriorityOverrides();
  }
  reconcilePriorityOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    this.priority.reconcilePriorityOverrides(trackedOrigins, ttlMs);
  }

  setProfileOverride(origin: string, profile: string | null): void {
    this.profileOverrides.setProfileOverride(origin, profile);
  }
  listProfileOverrides(): ProfileOverride[] {
    return this.profileOverrides.listProfileOverrides();
  }
  reconcileProfileOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    this.profileOverrides.reconcileProfileOverrides(trackedOrigins, ttlMs);
  }

  setGoalPriority(originRef: string, priority: boolean): void {
    this.priority.setGoalPriority(originRef, priority);
  }
  listGoalPriorities(): GoalPriority[] {
    return this.priority.listGoalPriorities();
  }

  setGoalPause(originRef: string, paused: boolean): void {
    this.pauses.setGoalPause(originRef, paused);
  }
  listGoalPauses(): GoalPause[] {
    return this.pauses.listGoalPauses();
  }

  recordEjection(...args: Parameters<EjectionStore['recordEjection']>): Ejection {
    return this.ejections.recordEjection(...args);
  }
  getEjection(id: string): Ejection | null {
    return this.ejections.getEjection(id);
  }
  listEjections(limit?: number): Ejection[] {
    return this.ejections.listEjections(limit);
  }
  liveEjections(): Ejection[] {
    return this.ejections.liveEjections();
  }
  liveEjectionForOrigin(originRef: string): Ejection | null {
    return this.ejections.liveEjectionForOrigin(originRef);
  }
  ejectionOnBranch(branch: string): Ejection | null {
    return this.ejections.ejectionOnBranch(branch);
  }
  noteEjection(id: string, note: string | null): void {
    this.ejections.noteEjection(id, note);
  }
  settleEjection(...args: Parameters<EjectionStore['settleEjection']>): Ejection | null {
    return this.ejections.settleEjection(...args);
  }

  recordRemedy(input: RemedyInput): Remedy {
    return this.remedies.recordRemedy(input);
  }
  listRemediesSince(since: string): Remedy[] {
    return this.remedies.listRemediesSince(since);
  }
  listRecentRemedies(kind: RemedyKind, limit: number): Remedy[] {
    return this.remedies.listRecentRemedies(kind, limit);
  }

  replacePoolFleetDigest(fleetId: string, project: string, document: PoolDigestDocument): void {
    this.pool.replaceFleetDigest(fleetId, project, document);
  }
  recordPoolFleetReading(reading: Omit<PoolFleetReading, 'seenAt'>): void {
    this.pool.recordFleetReading(reading);
  }
  listPoolFleets(): PoolFleetReading[] {
    return this.pool.listPoolFleets();
  }
  listPoolDigestRows(project: string | null): PoolDigestMirrorRow[] {
    return this.pool.listDigestRows(project);
  }
  getPoolPublication(kind: PoolClockKind): PoolPublication {
    return this.pool.getPublication(kind);
  }
  markPoolDirty(kind: PoolClockKind): void {
    this.pool.markPoolDirty(kind);
  }
  recordPoolPublish(kind: PoolClockKind, contentHash: string): void {
    this.pool.recordPoolPublish(kind, contentHash);
  }
  recordPoolChecked(kind: PoolClockKind): void {
    this.pool.recordPoolChecked(kind);
  }

  recordMcpCall(input: McpCallInput, retainArgsDays: number): McpCall {
    return this.mcpCalls.recordMcpCall(input, retainArgsDays);
  }
  compactMcpCallArgs(retainDays: number, force = false): number {
    return this.mcpCalls.compactMcpCallArgs(retainDays, force);
  }
  listMcpCallsSince(since: string): McpCall[] {
    return this.mcpCalls.listMcpCallsSince(since);
  }
  countMcpCallsByAgent(): Map<string, number> {
    return this.mcpCalls.countMcpCallsByAgent();
  }
  lastMcpCallByTool(): Map<string, string> {
    return this.mcpCalls.lastMcpCallByTool();
  }

  recordSurfaceReach(rows: readonly SurfaceReachInput[]): number {
    return this.surfaceReach.recordSurfaceReach(rows);
  }
  listSurfaceReachSince(since: string): SurfaceReach[] {
    return this.surfaceReach.listSurfaceReachSince(since);
  }
  linkedSubjectsEverReached(): Set<string> {
    return this.surfaceReach.linkedSubjectsEverReached();
  }
  pruneSurfaceReach(force = false): number {
    return this.surfaceReach.pruneSurfaceReach(force);
  }

  recordHumanTask(input: Parameters<HumanTaskStore['recordHumanTask']>[0]): { task: HumanTask; created: boolean } {
    return this.humanTasks.recordHumanTask(input);
  }
  getHumanTask(id: string): HumanTask | null {
    return this.humanTasks.getHumanTask(id);
  }
  listHumanTasks(limit?: number): HumanTask[] {
    return this.humanTasks.listHumanTasks(limit);
  }
  listAllHumanTasks(): HumanTask[] {
    return this.humanTasks.listAllHumanTasks();
  }
  humanTaskLabels(ids: string[]): Map<string, string> {
    return this.humanTasks.humanTaskLabels(ids);
  }
  listHumanTasksForParts(partIds: string[]): HumanTask[] {
    return this.humanTasks.listHumanTasksForParts(partIds);
  }
  listHumanTasksOfKind(kind: HumanTaskKind): HumanTask[] {
    return this.humanTasks.listHumanTasksOfKind(kind);
  }
  reopenHumanTask(id: string, detail: string): HumanTask | null {
    return this.humanTasks.reopenHumanTask(id, detail);
  }

  settleHumanTask(id: string, status: Exclude<HumanTaskStatus, 'open'>, resolution: string | null): HumanTask | null {
    return this.humanTasks.settleHumanTask(id, status, resolution);
  }
  dismissHumanTask(id: string): HumanTask | null {
    return this.humanTasks.dismissHumanTask(id);
  }

  upsertPlan(input: Parameters<PlanStore['upsertPlan']>[0]): Plan {
    return this.plans.upsertPlan(input);
  }
  getPlan(id: string): Plan | null {
    return this.plans.getPlan(id);
  }
  getPlanByOrigin(originRef: string): Plan | null {
    return this.plans.getPlanByOrigin(originRef);
  }
  planLabels(ids: string[]): Map<string, string> {
    return this.plans.planLabels(ids);
  }
  listPlans(): Plan[] {
    return this.plans.listPlans();
  }
  upsertPlanParts(planId: string, parts: PlanPartInput[]): PlanPart[] {
    return this.plans.upsertPlanParts(planId, parts);
  }
  listPlanParts(planId: string): PlanPart[] {
    return this.plans.listPlanParts(planId);
  }
  listAllPlanParts(): PlanPart[] {
    return this.plans.listAllPlanParts();
  }
  updatePlanPart(id: string, patch: Parameters<PlanStore['updatePlanPart']>[1]): PlanPart | null {
    return this.plans.updatePlanPart(id, patch);
  }
  setPartProfile(id: string, profile: string | null): PlanPart | null {
    return this.plans.setPartProfile(id, profile);
  }
  setPartAcceptanceMet(id: string, criteria: string[]): PlanPart | null {
    return this.plans.setPartAcceptanceMet(id, criteria);
  }
  recordPlanRevision(planId: string, input: Parameters<PlanStore['recordPlanRevision']>[1]): PlanRevision {
    return this.plans.recordPlanRevision(planId, input);
  }
  listPlanRevisions(planId: string): PlanRevision[] {
    return this.plans.listPlanRevisions(planId);
  }
  recordPlanCaveatAnswers(
    planId: string,
    answers: Parameters<PlanStore['recordPlanCaveatAnswers']>[1],
  ): PlanCaveatAnswer[] {
    return this.plans.recordPlanCaveatAnswers(planId, answers);
  }
  listPlanCaveatAnswers(planId: string): PlanCaveatAnswer[] {
    return this.plans.listPlanCaveatAnswers(planId);
  }
  listAllPlanCaveatAnswers(): PlanCaveatAnswer[] {
    return this.plans.listAllPlanCaveatAnswers();
  }
  recordPlanAmendment(input: Parameters<PlanStore['recordPlanAmendment']>[0]): PlanAmendment {
    return this.plans.recordPlanAmendment(input);
  }
  getPlanAmendment(id: string): PlanAmendment | null {
    return this.plans.getPlanAmendment(id);
  }
  listPlanAmendments(planId: string): PlanAmendment[] {
    return this.plans.listPlanAmendments(planId);
  }
  listPendingPlanAmendments(): PlanAmendment[] {
    return this.plans.listPendingPlanAmendments();
  }
  settlePlanAmendment(
    id: string,
    status: Parameters<PlanStore['settlePlanAmendment']>[1],
    resolution: string,
  ): PlanAmendment | null {
    return this.plans.settlePlanAmendment(id, status, resolution);
  }
  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.plans.markPartDispatched(id, taskId, branch);
  }
  concludeHumanPart(id: string, summary: string): PlanPart | null {
    return this.plans.concludeHumanPart(id, summary);
  }
  concludePlanPart(id: string, outcome: Parameters<PlanStore['concludePlanPart']>[1]): PlanPart | null {
    return this.plans.concludePlanPart(id, outcome);
  }
  setPlanStatus(id: string, status: PlanStatus, reason?: string): Plan | null {
    return this.plans.setPlanStatus(id, status, reason);
  }
  setPlanStatusComment(id: string, ref: string): Plan | null {
    return this.plans.setPlanStatusComment(id, ref);
  }
  rollUpPlanStatus(planId: string): Plan | null {
    return this.plans.rollUpPlanStatus(planId);
  }

  ingestValidation(planId: string, input: Parameters<ValidationStore['ingestValidation']>[1]): ValidationCheck[] {
    return this.validation.ingestValidation(planId, input);
  }
  amendValidation(planId: string, amendment: ValidationAmendment): ValidationAmendResult {
    return this.validation.amendValidation(planId, amendment);
  }
  linkValidationResourceTask(planId: string, name: string, humanTaskId: string): void {
    this.validation.linkValidationResourceTask(planId, name, humanTaskId);
  }
  getValidationCheck(planId: string, checkId: string): ValidationCheck | null {
    return this.validation.getValidationCheck(planId, checkId);
  }
  setValidationActor(planId: string, checkId: string, actor: ValidationCheckActor): ValidationCheck | null {
    return this.validation.setValidationActor(planId, checkId, actor);
  }
  recordValidationHandback(planId: string, checkId: string, note: string): ValidationCheck | null {
    return this.validation.recordValidationHandback(planId, checkId, note);
  }
  claimValidationCheck(
    planId: string,
    checkId: string,
    holder: string,
    staleBefore: string,
  ): ReturnType<ValidationStore['claimValidationCheck']> {
    return this.validation.claimValidationCheck(planId, checkId, holder, staleBefore);
  }
  releaseValidationClaim(planId: string, checkId: string): ValidationCheck | null {
    return this.validation.releaseValidationClaim(planId, checkId);
  }
  listValidationChecks(planId: string): ValidationCheck[] {
    return this.validation.listValidationChecks(planId);
  }
  listAllValidationChecks(): ValidationCheck[] {
    return this.validation.listAllValidationChecks();
  }
  listValidationResources(planId: string): ValidationResource[] {
    return this.validation.listValidationResources(planId);
  }
  listAllValidationResources(): ValidationResource[] {
    return this.validation.listAllValidationResources();
  }
  recordValidationResult(
    planId: string,
    checkId: string,
    input: {
      state: ValidationCheckState;
      note: string | null;
      by: ValidationCheckResultBy | null;
      until?: string | null;
    },
  ): ValidationCheck | null {
    return this.validation.recordValidationResult(planId, checkId, input);
  }

  recordIssueConclusion(input: Parameters<IssueVerdictStore['recordIssueConclusion']>[0]): IssueConclusion {
    return this.verdicts.recordIssueConclusion(input);
  }
  getIssueConclusion(originRef: string): IssueConclusion | null {
    return this.verdicts.getIssueConclusion(originRef);
  }
  listIssueConclusions(): IssueConclusion[] {
    return this.verdicts.listIssueConclusions();
  }
  clearIssueConclusion(originRef: string): boolean {
    return this.verdicts.clearIssueConclusion(originRef);
  }

  addIssueInstruction(input: { originRef: string; text: string }): IssueInstruction {
    return this.instructions.addIssueInstruction(input);
  }
  listStandingInstructions(originRef: string): IssueInstruction[] {
    return this.instructions.listStandingInstructions(originRef);
  }
  listAllStandingInstructions(): IssueInstruction[] {
    return this.instructions.listAllStandingInstructions();
  }
  settleInstructions(originRef: string): number {
    return this.instructions.settleInstructions(originRef);
  }
  withdrawInstruction(id: string): boolean {
    return this.instructions.withdrawInstruction(id);
  }

  recordDelivery(input: Parameters<IssueVerdictStore['recordDelivery']>[0]): IssueDelivery {
    return this.verdicts.recordDelivery(input);
  }
  getDelivery(originRef: string): IssueDelivery | null {
    return this.verdicts.getDelivery(originRef);
  }
  listDeliveries(): IssueDelivery[] {
    return this.verdicts.listDeliveries();
  }
  clearDelivery(originRef: string): boolean {
    return this.verdicts.clearDelivery(originRef);
  }
  recordShortfall(input: Parameters<IssueVerdictStore['recordShortfall']>[0]): IssueShortfall {
    return this.verdicts.recordShortfall(input);
  }
  getShortfall(originRef: string): IssueShortfall | null {
    return this.verdicts.getShortfall(originRef);
  }
  listShortfalls(): IssueShortfall[] {
    return this.verdicts.listShortfalls();
  }
  clearShortfall(originRef: string): boolean {
    return this.verdicts.clearShortfall(originRef);
  }
  recordAppraisal(input: Parameters<IssueVerdictStore['recordAppraisal']>[0]): IssueAppraisal {
    return this.verdicts.recordAppraisal(input);
  }
  getAppraisal(originRef: string): IssueAppraisal | null {
    return this.verdicts.getAppraisal(originRef);
  }
  listAppraisals(): IssueAppraisal[] {
    return this.verdicts.listAppraisals();
  }
  answerAppraisalProfile(originRef: string, goalRef: string): boolean {
    return this.verdicts.answerAppraisalProfile(originRef, goalRef);
  }
  settleAppraisalPlacement(originRef: string, goalRef: string, field: 'parent' | 'areaPath'): boolean {
    return this.verdicts.settleAppraisalPlacement(originRef, goalRef, field);
  }
  setAppraisalComment(originRef: string, commentRef: string): void {
    this.verdicts.setAppraisalComment(originRef, commentRef);
  }
  clearAppraisal(originRef: string): boolean {
    return this.verdicts.clearAppraisal(originRef);
  }

  appendScratchEntry(input: Parameters<ScratchStore['appendScratchEntry']>[0]): ScratchEntry {
    return this.scratch.appendScratchEntry(input);
  }
  listScratchEntries(padRef: string): ScratchEntry[] {
    return this.scratch.listScratchEntries(padRef);
  }
  listScratchPadSummaries(): ScratchPadSummary[] {
    return this.scratch.listScratchPadSummaries();
  }
  recordRetrospective(input: Parameters<ScratchStore['recordRetrospective']>[0]): Retrospective {
    return this.scratch.recordRetrospective(input);
  }
  getRetrospective(originRef: string): Retrospective | null {
    return this.scratch.getRetrospective(originRef);
  }
  listRetrospectiveOrigins(): string[] {
    return this.scratch.listRetrospectiveOrigins();
  }

  recordReviewPack(pack: ReviewPack): ReviewPackRecord {
    return this.reviewPacks.recordReviewPack(pack);
  }
  getCurrentReviewPack(prNumber: number): ReviewPackRecord | null {
    return this.reviewPacks.getCurrentReviewPack(prNumber);
  }
  listReviewPacks(prNumber: number): ReviewPackRecord[] {
    return this.reviewPacks.listReviewPacks(prNumber);
  }

  listReviewPackHeads(): ReviewPackHead[] {
    return this.reviewPacks.listReviewPackHeads();
  }
  listCurrentReviewPacks(): ReviewPackRecord[] {
    return this.reviewPacks.listCurrentReviewPacks();
  }
  getReviewPackAt(prNumber: number, headSha: string): ReviewPackRecord | null {
    return this.reviewPacks.getReviewPackAt(prNumber, headSha);
  }
  recordReviewPackShare(input: Parameters<ReviewPackStore['recordReviewPackShare']>[0]): ReviewPackShare {
    return this.reviewPacks.recordReviewPackShare(input);
  }
  recordReviewPackShared(prNumber: number): void {
    this.reviewPacks.recordReviewPackShared(prNumber);
  }
  recordReviewPackShareRefusal(prNumber: number, refusal: string): void {
    this.reviewPacks.recordReviewPackShareRefusal(prNumber, refusal);
  }
  getReviewPackShare(prNumber: number): ReviewPackShare | null {
    return this.reviewPacks.getReviewPackShare(prNumber);
  }
  listReviewPackShares(): ReviewPackShare[] {
    return this.reviewPacks.listReviewPackShares();
  }
  deleteReviewPackShare(prNumber: number): void {
    this.reviewPacks.deleteReviewPackShare(prNumber);
  }
  withdrawReviewPackShare(prNumber: number): ReviewPackShare | null {
    return this.reviewPacks.withdrawReviewPackShare(prNumber);
  }
  markReviewIdeaRead(input: Parameters<ReviewPackStore['markReviewIdeaRead']>[0]): ReviewMark[] {
    return this.reviewPacks.markReviewIdeaRead(input);
  }
  overrideReviewAttention(input: Parameters<ReviewPackStore['overrideReviewAttention']>[0]): ReviewMark[] {
    return this.reviewPacks.overrideReviewAttention(input);
  }
  markReviewFindingSeen(input: Parameters<ReviewPackStore['markReviewFindingSeen']>[0]): ReviewMark[] {
    return this.reviewPacks.markReviewFindingSeen(input);
  }
  listReviewMarks(prNumber: number): ReviewMark[] {
    return this.reviewPacks.listReviewMarks(prNumber);
  }
  listAllReviewMarks(): ReviewMark[] {
    return this.reviewPacks.listAllReviewMarks();
  }

  recordRateLimits(limits: AccountRateLimits): void {
    this.rateLimits.recordRateLimits(limits);
  }
  readRateLimits(): AccountRateLimits | null {
    return this.rateLimits.readRateLimits();
  }
  listRateLimitReadingsSince(since: string): AccountRateLimits[] {
    return this.rateLimits.listRateLimitReadingsSince(since);
  }

  readUpgradeIntent(): UpgradeIntent {
    return this.upgrades.readUpgradeIntent();
  }
  writeUpgradeIntent(intent: UpgradeIntent): UpgradeIntent {
    return this.upgrades.writeUpgradeIntent(intent);
  }

  createAgent(input: Parameters<AgentStore['createAgent']>[0]): Agent {
    return this.agents.createAgent(input);
  }
  updateAgent(id: string, patch: Partial<Pick<Agent, 'status' | 'pid' | 'waitingReason' | 'endedAt'>>): void {
    this.agents.updateAgent(id, patch);
  }
  setAgentResumed(id: string, at: string | null): void {
    this.agents.setAgentResumed(id, at);
  }
  countAgentResumeAttempt(id: string): number {
    return this.agents.countAgentResumeAttempt(id);
  }
  getAgent(id: string): Agent | null {
    return this.agents.getAgent(id);
  }
  listAgents(): Agent[] {
    return this.agents.listAgents();
  }
  recordAgentUsage(id: string, usage: AgentUsage): void {
    this.agents.recordAgentUsage(id, usage);
  }
  recordAgentNote(id: string, note: string): string {
    return this.agents.recordAgentNote(id, note);
  }
  sumUsageCostSince(sinceIso: string): number {
    return this.agents.sumUsageCostSince(sinceIso) + this.localRuns.sumLocalRunCostSince(sinceIso);
  }
  listUsageEventsSince(sinceIso: string): UsageEvent[] {
    return this.agents.listUsageEventsSince(sinceIso);
  }
  listCostDeltasSince(sinceIso: string): CostDelta[] {
    return [
      ...this.agents.listUsageEventsSince(sinceIso).map((e) => ({ costUsd: e.costUsd, at: e.at })),
      ...this.localRuns.listLocalRunCostDeltasSince(sinceIso),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }
  listAgentsForTasks(taskIds: readonly string[]): Agent[] {
    return this.agents.listAgentsForTasks(taskIds);
  }

  listAgentsByStatus(...statuses: Agent['status'][]): Agent[] {
    return this.agents.listAgentsByStatus(...statuses);
  }
  countLiveAgents(): number {
    return this.agents.countLiveAgents();
  }
  recordFlag(agentId: string, input: AgentFlagInput): AgentFlag {
    return this.agents.recordFlag(agentId, input);
  }
  getFlag(id: string): AgentFlag | null {
    return this.agents.getFlag(id);
  }
  listFlags(agentId: string): AgentFlag[] {
    return this.agents.listFlags(agentId);
  }
  listAllFlags(): AgentFlag[] {
    return this.agents.listAllFlags();
  }
  recordFile(agentId: string, input: AgentFileInput): AgentFile {
    return this.agents.recordFile(agentId, input);
  }
  listFiles(agentId: string): AgentFile[] {
    return this.agents.listFiles(agentId);
  }
  listFilesForAgents(agentIds: readonly string[]): AgentFile[] {
    return this.agents.listFilesForAgents(agentIds);
  }
  listGoalFiles(goalRef: string): GoalFile[] {
    return this.agents.listGoalFiles(goalRef);
  }
  listGoalNeighbours(goalRef: string, paths: string[]): GoalNeighbour[] {
    return this.agents.listGoalNeighbours(goalRef, paths);
  }

  appendTranscript(agentId: string, chunk: string): void {
    this.transcripts.appendTranscript(agentId, chunk);
  }
  flushTranscript(agentId: string): void {
    this.transcripts.flushTranscript(agentId);
  }
  getTranscript(agentId: string): string {
    return this.transcripts.getTranscript(agentId);
  }

  createEscalation(input: Omit<Escalation, 'id' | 'status' | 'response' | 'createdAt' | 'answeredAt'>): Escalation {
    return this.escalations.createEscalation(input);
  }
  answerEscalation(id: string, response: string): Escalation {
    return this.escalations.answerEscalation(id, response);
  }
  dismissEscalation(id: string, context: Record<string, unknown>): Escalation {
    return this.escalations.dismissEscalation(id, context);
  }
  getEscalation(id: string): Escalation | null {
    return this.escalations.getEscalation(id);
  }
  listEscalations(): Escalation[] {
    return this.escalations.listEscalations();
  }
  listEscalationSpans(): EscalationSpan[] {
    return this.escalations.listEscalationSpans();
  }
  escalationLabels(ids: string[]): Map<string, string> {
    return this.escalations.escalationLabels(ids);
  }
  listOpenEscalations(): Escalation[] {
    return this.escalations.listOpenEscalations();
  }
  createProposal(input: Omit<Proposal, 'id' | 'status' | 'note' | 'decidedBy' | 'decidedAt' | 'createdAt'>): Proposal {
    return this.escalations.createProposal(input);
  }
  decideProposal(
    id: string,
    status: Extract<Proposal['status'], 'accepted' | 'rejected'>,
    note: string | null,
    decidedBy: NonNullable<Proposal['decidedBy']>,
  ): Proposal | null {
    return this.escalations.decideProposal(id, status, note, decidedBy);
  }
  getProposal(id: string): Proposal | null {
    return this.escalations.getProposal(id);
  }
  listProposals(): Proposal[] {
    return this.escalations.listProposals();
  }

  recordStackLanding(ref: string, rungs: number[]): StackLanding {
    return this.landings.recordStackLanding(ref, rungs);
  }
  getStackLanding(id: string): StackLanding | null {
    return this.landings.getStackLanding(id);
  }
  listStackLandings(limit?: number): StackLanding[] {
    return this.landings.listStackLandings(limit);
  }
  landingLabels(ids: string[]): Map<string, string> {
    return this.landings.landingLabels(ids);
  }
  listStandingLandings(): StackLanding[] {
    return this.landings.listStandingLandings();
  }
  standingLandingForPr(prNumber: number): StackLanding | null {
    return this.landings.standingLandingForPr(prNumber);
  }
  settleStackLanding(
    id: string,
    status: Exclude<StackLandingStatus, 'standing'>,
    reason: string | null,
  ): StackLanding | null {
    return this.landings.settleStackLanding(id, status, reason);
  }

  recordBranchReap(prNumber: number, branch: string): void {
    this.branchReaps.recordBranchReap(prNumber, branch);
  }
  reapedPrs(): ReadonlySet<number> {
    return this.branchReaps.reapedPrs();
  }

  recordGoalLanding(input: { prNumber: number; goalRef: string; sha: string }): void {
    this.environments.recordGoalLanding(input);
  }
  listGoalLandings(): GoalLanding[] {
    return this.environments.listGoalLandings();
  }
  landedPrs(): ReadonlySet<number> {
    return this.environments.landedPrs();
  }
  recordEnvironmentReach(input: {
    sha: string;
    environment: string;
    status: EnvironmentReachStatus;
    detail: string | null;
  }): void {
    this.environments.recordEnvironmentReach(input);
  }
  listEnvironmentReach(): EnvironmentReading[] {
    return this.environments.listEnvironmentReach();
  }
  recordEnvironmentHealth(input: {
    environment: string;
    state: EnvironmentHealthState;
    tier: EnvironmentHealthTier | null;
    reasons: string[];
    detail: string | null;
  }): void {
    this.environments.recordEnvironmentHealth(input);
  }
  listEnvironmentHealth(): EnvironmentHealthReading[] {
    return this.environments.listEnvironmentHealth();
  }
  recordGoalArrival(input: { goalRef: string; environment: string; arrivedAt: string }): void {
    this.environments.recordGoalArrival(input);
  }
  listGoalArrivals(): GoalArrival[] {
    return this.environments.listGoalArrivals();
  }
  markArrivalAnnounced(goalRef: string, environment: string): void {
    this.environments.markArrivalAnnounced(goalRef, environment);
  }
  markArrivalWatched(goalRef: string, environment: string): void {
    this.environments.markArrivalWatched(goalRef, environment);
  }
  releaseEnvironmentGate(goalRef: string, note: string): EnvironmentGateRelease {
    return this.environments.releaseEnvironmentGate(goalRef, note);
  }
  clearEnvironmentGateRelease(goalRef: string): void {
    this.environments.clearEnvironmentGateRelease(goalRef);
  }
  listEnvironmentGateReleases(): EnvironmentGateRelease[] {
    return this.environments.listEnvironmentGateReleases();
  }

  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    this.watches.ingestGoalWatch(originRef, checks);
  }
  recordWatchDryRun(
    originRef: string,
    checkId: string,
    reading: {
      environment: string;
      verdict: WatchReadingVerdict;
      presence: WatchReadingVerdict | null;
      rows: number | null;
      detail: string | null;
      value: number | null;
    },
  ): void {
    this.watches.recordWatchDryRun(originRef, checkId, reading);
  }
  listGoalWatches(): GoalWatch[] {
    return this.watches.listGoalWatches();
  }
  listProposedGoalWatches(): GoalWatch[] {
    return this.watches.listProposedGoalWatches();
  }
  proposeGoalWatch(originRef: string, checks: readonly GoalWatchInput[], note: string): { proposed: string[] } {
    return this.watches.proposeGoalWatch(originRef, checks, note);
  }
  ruleOnWatchProposal(originRef: string, checkId: string, accept: boolean): GoalWatch | null {
    return this.watches.ruleOnWatchProposal(originRef, checkId, accept);
  }
  saveOperatorWatch(originRef: string, check: Omit<GoalWatchInput, 'seq'>): GoalWatch {
    return this.watches.saveOperatorWatch(originRef, check);
  }
  deleteGoalWatch(originRef: string, checkId: string): boolean {
    return this.watches.deleteGoalWatch(originRef, checkId);
  }
  openWatchWindow(input: { goalRef: string; environment: string; openedAt: string; settlesAt: string }): void {
    this.watches.openWatchWindow(input);
  }
  settleWatchWindow(goalRef: string, environment: string): void {
    this.watches.settleWatchWindow(goalRef, environment);
  }
  extendWatchWindow(goalRef: string, environment: string, settlesAt: string): WatchWindow | null {
    return this.watches.extendWatchWindow(goalRef, environment, settlesAt);
  }
  listWatchWindows(): WatchWindow[] {
    return this.watches.listWatchWindows();
  }
  recordWatchReading(input: {
    goalRef: string;
    environment: string;
    checkId: string;
    verdict: WatchCheckVerdict;
    rows: number | null;
    value: number | null;
    detail: string | null;
  }): void {
    this.watches.recordWatchReading(input);
  }
  listWatchReadings(): WatchReading[] {
    return this.watches.listWatchReadings();
  }

  beginLocalRun(input: { originRef: string; ref: string; dir: string; commit: string; url: string | null }): LocalRun {
    return this.localRuns.beginLocalRun(input);
  }
  markLocalRunPid(id: string, pid: number | null): void {
    this.localRuns.markLocalRunPid(id, pid);
  }
  setLocalRunCommit(id: string, commit: string): void {
    this.localRuns.setLocalRunCommit(id, commit);
  }
  markLocalRunInterrupted(id: string, at: string | null): void {
    this.localRuns.markLocalRunInterrupted(id, at);
  }
  markLocalRunSeen(id: string, at: string): void {
    this.localRuns.markLocalRunSeen(id, at);
  }
  setLocalRunStatus(id: string, status: LocalRunStatus, note?: string): void {
    this.localRuns.setLocalRunStatus(id, status, note);
  }
  liveLocalRun(): LocalRun | null {
    return this.localRuns.liveLocalRun();
  }
  currentLocalRun(): LocalRun | null {
    return this.localRuns.currentLocalRun();
  }
  listLocalRuns(): LocalRun[] {
    return this.localRuns.listLocalRuns();
  }
  addLocalRunUsage(id: string, delta: LocalRunUsageDelta): void {
    this.localRuns.addLocalRunUsage(id, delta);
  }

  createLocalValidation(input: {
    originRef: string;
    runId: string;
    ref: string;
    commit: string | null;
  }): LocalValidation {
    return this.localValidations.createLocalValidation(input);
  }
  getLocalValidation(id: string): LocalValidation | null {
    return this.localValidations.getLocalValidation(id);
  }
  latestLocalValidation(originRef: string): LocalValidation | null {
    return this.localValidations.latestLocalValidation(originRef);
  }
  listLatestLocalValidations(): LocalValidation[] {
    return this.localValidations.listLatestLocalValidations();
  }
  listOpenLocalValidations(): LocalValidation[] {
    return this.localValidations.listOpenLocalValidations();
  }
  listLocalValidationsAwaitingFix(): LocalValidation[] {
    return this.localValidations.listLocalValidationsAwaitingFix();
  }
  markLocalValidationDispatched(id: string, taskId: string): void {
    this.localValidations.markLocalValidationDispatched(id, taskId);
  }
  markLocalValidationFix(id: string, taskId: string): void {
    this.localValidations.markLocalValidationFix(id, taskId);
  }
  setLocalValidationPlan(id: string, plan: string): void {
    this.localValidations.setLocalValidationPlan(id, plan);
  }
  recordLocalValidationReport(
    id: string,
    result: {
      status: 'passed' | 'failed' | 'blocked';
      summary: string;
      findings: LocalValidationFinding[];
      visited: string[];
      screenshots: string[];
      note: string | null;
    },
  ): LocalValidation | null {
    return this.localValidations.recordLocalValidationReport(id, result);
  }
  abandonLocalValidation(id: string, note: string): LocalValidation | null {
    return this.localValidations.abandonLocalValidation(id, note);
  }

  recordPrWatchSeed(prNumber: number, branch: string): void {
    this.prWatchSeeds.recordPrWatchSeed(prNumber, branch);
  }
  seededPrs(): ReadonlySet<number> {
    return this.prWatchSeeds.seededPrs();
  }

  recordWorkItemLink(prNumber: number, workItem: number): void {
    this.workItemLinks.recordWorkItemLink(prNumber, workItem);
  }
  linkedWorkItemPrs(): ReadonlySet<number> {
    return this.workItemLinks.linkedWorkItemPrs();
  }

  foldReviewWaits(waiting: readonly number[]): void {
    this.reviewWaitStore.foldReviewWaits(waiting);
  }
  reviewWaits(): ReadonlyMap<number, string> {
    return this.reviewWaitStore.reviewWaits();
  }

  recordPrReview(input: PrReviewInput): PrReview {
    return this.prReviews.recordPrReview(input);
  }
  recordPrReviewPublished(prNumber: number, threadId: string): void {
    this.prReviews.recordPrReviewPublished(prNumber, threadId);
  }
  listPrReviews(): PrReview[] {
    return this.prReviews.listPrReviews();
  }
  recordPrReviewRoute(input: PrReviewRouteInput): PrReviewRoute {
    return this.prReviewRoutes.recordPrReviewRoute(input);
  }
  listPrReviewRoutes(): PrReviewRoute[] {
    return this.prReviewRoutes.listPrReviewRoutes();
  }
  recordPrSplitVerdict(input: PrSplitVerdictInput): PrSplitVerdict {
    return this.prSplits.recordPrSplitVerdict(input);
  }
  listPrSplitVerdicts(): PrSplitVerdict[] {
    return this.prSplits.listPrSplitVerdicts();
  }
  recordPrReviewedElsewhere(prNumber: number, detail: string): void {
    this.prReviewExternals.recordPrReviewedElsewhere(prNumber, detail);
  }
  prsReviewedElsewhere(): ReadonlySet<number> {
    return this.prReviewExternals.prsReviewedElsewhere();
  }
  setPrThreadReopened(prNumber: number, threadId: string, reopened: boolean): void {
    this.threadReopens.setPrThreadReopened(prNumber, threadId, reopened);
  }
  prThreadReopens(): PrThreadReopen[] {
    return this.threadReopens.prThreadReopens();
  }
  recordPrReplySent(prNumber: number, threadId: string, commentRef: string): void {
    this.prReplies.recordPrReplySent(prNumber, threadId, commentRef);
  }
  recordObstacleSighting(...args: Parameters<ObstacleStore['recordObstacleSighting']>): ObstacleOutcome {
    return this.obstacles.recordObstacleSighting(...args);
  }

  getObstacle(id: string): Obstacle | null {
    return this.obstacles.getObstacle(id);
  }

  listObstacles(): Obstacle[] {
    return this.obstacles.listObstacles();
  }

  listObstacleKeys(obstacleId: string): ObstacleKey[] {
    return this.obstacles.listObstacleKeys(obstacleId);
  }

  listObstacleSightings(obstacleId: string): ObstacleSighting[] {
    return this.obstacles.listObstacleSightings(obstacleId);
  }

  claimObstacleNotice(obstacleId: string, agentId: string, reason: string): boolean {
    return this.obstacles.claimObstacleNotice(obstacleId, agentId, reason);
  }

  obstaclesNoticedBy(agentId: string): Set<string> {
    return this.obstacles.obstaclesNoticedBy(agentId);
  }

  obstacleNoticesSent(): number {
    return this.obstacles.obstacleNoticesSent();
  }

  obstacleBoard(): ObstacleStanding[] {
    return this.obstacles.obstacleBoard();
  }

  obstacleInbox(): ObstacleStanding[] {
    return this.obstacles.obstacleInbox();
  }

  obstacleReading(obstacleId: string): ObstacleDeskReading | null {
    return this.obstacles.obstacleReading(obstacleId);
  }

  recordObstacleReading(...args: Parameters<ObstacleStore['recordObstacleReading']>): void {
    this.obstacles.recordObstacleReading(...args);
  }

  addObstacleKeys(...args: Parameters<ObstacleStore['addObstacleKeys']>): ReturnType<ObstacleStore['addObstacleKeys']> {
    return this.obstacles.addObstacleKeys(...args);
  }

  suggestObstacleMerge(...args: Parameters<ObstacleStore['suggestObstacleMerge']>): void {
    this.obstacles.suggestObstacleMerge(...args);
  }

  listObstacleSuggestions(obstacleId: string): ReturnType<ObstacleStore['listObstacleSuggestions']> {
    return this.obstacles.listObstacleSuggestions(obstacleId);
  }

  setObstacleKind(...args: Parameters<ObstacleStore['setObstacleKind']>): boolean {
    return this.obstacles.setObstacleKind(...args);
  }

  muteObstacle(id: string, muted: boolean): boolean {
    return this.obstacles.muteObstacle(id, muted);
  }

  claimObstacle(id: string): boolean {
    return this.obstacles.claimObstacle(id);
  }

  setObstacleOwner(id: string, ownerRef: string): void {
    this.obstacles.setObstacleOwner(id, ownerRef);
  }

  releaseObstacle(id: string): void {
    this.obstacles.releaseObstacle(id);
  }

  recordObstacleBlock(...args: Parameters<ObstacleStore['recordObstacleBlock']>): ObstacleBlock {
    return this.obstacles.recordObstacleBlock(...args);
  }

  listObstacleBlocks(): ObstacleBlock[] {
    return this.obstacles.listObstacleBlocks();
  }

  clearObstacleBlock(originRef: string): void {
    this.obstacles.clearObstacleBlock(originRef);
  }

  endObstacle(id: string, state: 'resolved' | 'dormant', endedBy: ObstacleEnding): boolean {
    return this.obstacles.endObstacle(id, state, endedBy);
  }

  watchObstacleCondition(...args: Parameters<ObstacleStore['watchObstacleCondition']>): void {
    this.obstacles.watchObstacleCondition(...args);
  }

  listObstacleConditions(obstacleId: string): ObstacleCondition[] {
    return this.obstacles.listObstacleConditions(obstacleId);
  }

  setObstacleConditionMet(id: string, met: boolean): void {
    this.obstacles.setObstacleConditionMet(id, met);
  }

  writeUpObstacle(obstacleId: string, work: { title: string; prompt: string }): Job {
    const write = this.db.transaction((): Job => {
      const job = this.jobs.createJob({ title: work.title, prompt: work.prompt, kind: 'code' });
      this.obstacles.recordObstacleWriteUp(obstacleId, job.id);
      return job;
    });
    return write();
  }

  obstaclesWrittenUp(): Set<string> {
    return this.obstacles.obstaclesWrittenUp();
  }

  openObstacleWriteUps(): ObstacleWriteUp[] {
    return this.obstacles.openObstacleWriteUps();
  }

  noteObstacleWriteUpPr(obstacleId: string, prRef: string): void {
    this.obstacles.noteObstacleWriteUpPr(obstacleId, prRef);
  }

  settleObstacleWriteUp(obstacleId: string, outcome: ObstacleWriteUpOutcome): boolean {
    return this.obstacles.settleObstacleWriteUp(obstacleId, outcome);
  }

  prReplyRefs(prNumber: number): ReadonlySet<string> {
    return this.prReplies.prReplyRefs(prNumber);
  }

  archiveClosedPrs(prs: readonly PullRequest[]): void {
    this.prArchive.archiveClosedPrs(prs);
  }

  listArchivedPrs(): PullRequest[] {
    return this.prArchive.listArchivedPrs();
  }

  recordDecision(input: Omit<Decision, 'id' | 'createdAt' | 'rule' | 'admission'>): Decision {
    return this.decisions.recordDecision(input);
  }
  listDecisions(limit?: number): Decision[] {
    return this.decisions.listDecisions(limit);
  }
  listDecisionsForGoal(goalRef: string, limit?: number): Decision[] {
    return this.decisions.listDecisionsForGoal(goalRef, limit);
  }

  recordWorldEvents(inputs: WorldEventInput[]): WorldEvent[] {
    return this.world.recordWorldEvents(inputs);
  }
  listWorldEvents(limit?: number): WorldEvent[] {
    return this.world.listWorldEvents(limit);
  }
  listWorldEventsSince(since: string, refs: string[]): WorldEvent[] {
    return this.world.listWorldEventsSince(since, refs);
  }
  listWorldEventsOfKindsSince(since: string, kinds: readonly WorldEventKind[]): WorldEvent[] {
    return this.world.listWorldEventsOfKindsSince(since, kinds);
  }
  getWorldBaseline(): WorldSnapshot | null {
    return this.world.getWorldBaseline();
  }
  setWorldBaseline(world: WorldSnapshot): void {
    this.world.setWorldBaseline(world);
  }
  patchWorldLabels(patch: WorldLabelPatch): void {
    this.world.patchWorldLabels(patch);
  }

  patchWorldState(patch: { number: number; state: string }): void {
    this.world.patchWorldState(patch);
  }
  getConnectorState(key: string): string | null {
    return this.world.getConnectorState(key);
  }
  setConnectorState(key: string, value: string): void {
    this.world.setConnectorState(key, value);
  }

  recordError(input: ErrorLogInput): ErrorLogEntry {
    return this.errors.recordError(input);
  }
  listErrors(limit?: number): ErrorLogEntry[] {
    return this.errors.listErrors(limit);
  }
  listErrorsSince(since: string): ErrorLogEntry[] {
    return this.errors.listErrorsSince(since);
  }
  clearErrors(): number {
    return this.errors.clearErrors();
  }

  recordWorkGraph(observations: WorkNodeObservation[]): void {
    this.graph.recordWorkGraph(observations);
  }
  listWorkRoots(): WorkNode[] {
    return this.graph.listWorkRoots();
  }
  listWorkSubtree(rootRef: string): WorkNode[] {
    return this.graph.listWorkSubtree(rootRef);
  }
  listWorkNodes(): WorkNode[] {
    return this.graph.listWorkNodes();
  }
  mergedPrs(): ReadonlySet<number> {
    return this.graph.mergedPrs();
  }
  createWorkItemFiling(input: Parameters<GraphStore['createWorkItemFiling']>[0]): WorkItemFiling | null {
    return this.graph.createWorkItemFiling(input);
  }
  listWorkItemFilings(): WorkItemFiling[] {
    return this.graph.listWorkItemFilings();
  }
  linkWorkItemFiling(targetRef: string, ticketRef: string): WorkItemFiling | null {
    return this.graph.linkWorkItemFiling(targetRef, ticketRef);
  }
  dropWorkItemFiling(targetRef: string): void {
    this.graph.dropWorkItemFiling(targetRef);
  }
  ignoreWorkItem(targetRef: string): void {
    this.graph.ignoreWorkItem(targetRef);
  }
  unignoreWorkItem(targetRef: string): void {
    this.graph.unignoreWorkItem(targetRef);
  }
  listWorkItemIgnores(): string[] {
    return this.graph.listWorkItemIgnores();
  }

  createBugFiling(input: Parameters<BugFilingStore['createBugFiling']>[0]): BugFiling {
    return this.bugFilings.createBugFiling(input);
  }
  listBugFilings(): BugFiling[] {
    return this.bugFilings.listBugFilings();
  }
  findBugFilingByJobId(jobId: string): BugFiling | null {
    return this.bugFilings.findBugFilingByJobId(jobId);
  }
  linkBugFiling(jobId: string, ticketRef: string): BugFiling | null {
    return this.bugFilings.linkBugFiling(jobId, ticketRef);
  }

  recordIssueRun(input: Parameters<FloorStore['recordIssueRun']>[0]): void {
    this.floor.recordIssueRun(input);
  }
  dismissIssueRun(originRef: string, note: string | null = null): boolean {
    return this.floor.dismissIssueRun(originRef, note);
  }
  listIssueRuns(): IssueRun[] {
    return this.floor.listIssueRuns();
  }

  ensureTrackerSweep(backfillMs: number): TrackerSweepMark {
    return this.tickets.ensureTrackerSweep(backfillMs);
  }
  readTrackerSweep(): TrackerSweepMark | null {
    return this.tickets.readTrackerSweep();
  }
  recordSweep(askedFrom: string, items: readonly TrackerItem[], live?: readonly LiveTicketFacts[]): void {
    this.tickets.recordSweep(askedFrom, items, live);
  }
  ensureFeatureColors(numbers: readonly number[]): Map<number, number> {
    return this.tickets.ensureFeatureColors(numbers);
  }
  listTicketsClosedSince(since: string): TicketClosure[] {
    return this.tickets.listTicketsClosedSince(since);
  }
  listTrackerItems(): MirroredTicket[] {
    return this.tickets.listTrackerItems();
  }
  readTrackerItems(numbers: readonly number[]): MirroredTicket[] {
    return this.tickets.readTrackerItems(numbers);
  }
  patchTicketLabels(patch: TicketLabelPatch): void {
    this.tickets.patchTicketLabels(patch);
  }

  patchTicketState(patch: { number: number; state: string }): void {
    this.tickets.patchTicketState(patch);
  }
  recordFeatureSummary(input: Parameters<TicketStore['recordFeatureSummary']>[0]): FeatureSummary {
    return this.tickets.recordFeatureSummary(input);
  }
  getFeatureSummary(originRef: string): FeatureSummary | null {
    return this.tickets.getFeatureSummary(originRef);
  }
  listFeatureSummaries(): FeatureSummary[] {
    return this.tickets.listFeatureSummaries();
  }

  recordFeatureSequence(input: Parameters<SequenceStore['recordFeatureSequence']>[0]): FeatureSequence {
    return this.sequences.recordFeatureSequence(input);
  }
  answerFeatureSequence(...args: Parameters<SequenceStore['answerFeatureSequence']>): FeatureSequence | null {
    return this.sequences.answerFeatureSequence(...args);
  }
  getFeatureSequence(originRef: string): FeatureSequence | null {
    return this.sequences.getFeatureSequence(originRef);
  }
  listFeatureSequences(): FeatureSequence[] {
    return this.sequences.listFeatureSequences();
  }

  listPets(): Pet[] {
    return this.pets.listPets();
  }
  getPet(id: string): Pet | null {
    return this.pets.getPet(id);
  }
  hatchPet(...args: Parameters<PetStore['hatchPet']>): Pet {
    return this.pets.hatchPet(...args);
  }
  placedCount(): number {
    return this.pets.placedCount();
  }
  recordPetAction(action: PetAction): void {
    this.pets.recordPetAction(action);
  }
  petActionKeys(): Set<string> {
    return this.pets.petActionKeys();
  }
  petActionIndex(): Map<string, { at: string; petId: string | null }> {
    return this.pets.petActionIndex();
  }
  petActionLog(): PetAction[] {
    return this.pets.petActionLog();
  }
  petChainLog(): ReturnType<PetStore['petChainLog']> {
    return this.pets.petChainLog();
  }
  petPaidTotals(): Map<string, number> {
    return this.pets.petPaidTotals();
  }
  petActionsSinceHatch(since: string): Map<PetActionKind, number> {
    return this.pets.petActionsSinceHatch(since);
  }
  petRolledSince(since: string): boolean {
    return this.pets.petRolledSince(since);
  }
  vivariumStart(): string | null {
    return this.pets.vivariumStart();
  }
  beginVivarium(): string {
    return this.pets.beginVivarium();
  }
  feedPet(id: string, beats: number): Pet | null {
    return this.pets.feedPet(id, beats);
  }
  openPet(id: string): Pet | null {
    return this.pets.openPet(id);
  }
  renamePet(id: string, name: string | null): Pet | null {
    return this.pets.renamePet(id, name);
  }
  placePet(id: string, placed: boolean): Pet | null {
    return this.pets.placePet(id, placed);
  }
  petBeatsSpent(): number {
    return this.pets.petBeatsSpent();
  }
  petBlendCredits(): number {
    return this.pets.petBlendCredits();
  }
  livePetsOfSpecies(species: PetSpecies): number {
    return this.pets.livePetsOfSpecies(species);
  }
  blendPet(id: string, beats: number): Pet | null {
    return this.pets.blendPet(id, beats);
  }
  petResetAt(id: string): string | null {
    return this.pets.petResetAt(id);
  }
  petEpoch(): string | null {
    return this.pets.petEpoch();
  }
  clearVivarium(id: string): PetReset {
    return this.pets.clearVivarium(id);
  }
}
