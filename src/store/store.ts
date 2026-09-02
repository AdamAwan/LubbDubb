import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import { systemClock, type Clock, type StoreContext } from './context.js';
import { ensureColumns, rebuildTables, renameTables, runOnce } from './migrate.js';
import { PoolStore, type PoolDigestMirrorRow } from './pool.js';
import { backfillTaskDispatchKind, TaskStore, TASK_COLUMNS } from './tasks.js';
import { JobStore, JOB_COLUMNS } from './jobs.js';
import { JobScheduleStore, JOB_SCHEDULE_COLUMNS } from './schedules.js';
import { PriorityStore } from './priority.js';
import { ProfileOverrideStore } from './profileOverrides.js';
import { corroborationGoal } from '../knowledge/knowledge.js';
import {
  foldedFactId,
  KnowledgeStore,
  KNOWLEDGE_COLUMNS,
  KNOWLEDGE_REBUILDS,
  stampFactsWithProject,
  stampGraduationsBeforeExits,
  type ContradictionOutcome,
  type FactContradictionOutcome,
  type FactCounts,
  type FactAgreementOutcome,
  type FactMergeOutcome,
  type FactProposalOutcome,
  type FactQuery,
} from './knowledge.js';
import { RemedyStore } from './remedies.js';
import { McpCallStore } from './mcpCalls.js';
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
import { WatchStore, WATCH_COLUMNS } from './watches.js';
import { PrWatchSeedStore } from './prWatchSeeds.js';
import { WorkItemLinkStore } from './workItemLinks.js';
import { ReviewWaitStore } from './reviewWaits.js';
import { PrReviewStore } from './prReviews.js';
import { PrReviewRouteStore, PR_REVIEW_ROUTE_COLUMNS } from './prReviewRoutes.js';
import { PrReviewExternalStore } from './prReviewExternals.js';
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
import type {
  AccountRateLimits,
  Agent,
  AgentFile,
  AgentFileInput,
  AgentFlag,
  AgentFlagInput,
  AgentUsage,
  Decision,
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
  FactExit,
  FactReach,
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
  ContradictionRuling,
  GraduationOutcome,
  KnowledgeContradiction,
  KnowledgeCorroboration,
  KnowledgeFact,
  PoolDigestDocument,
  PoolClockKind,
  PoolFleetReading,
  PoolMirroredClaim,
  PoolPublication,
  KnowledgeGraduation,
  KnowledgeSimilarity,
  Remedy,
  RemedyInput,
  RemedyKind,
  McpCall,
  McpCallInput,
  CostDelta,
  LocalRun,
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
  PlanRevision,
  FeatureSummary,
  Retrospective,
  ScratchEntry,
  ScratchPadSummary,
  ReviewMark,
  ReviewPack,
  ReviewPackRecord,
  ReviewPackShare,
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
  ValidationResource,
  WorkNode,
  WorkNodeObservation,
  WorkItemFiling,
  BugFiling,
  WorldEvent,
  WorldEventInput,
  WorldEventKind,
  WorldSnapshot,
} from '../types.js';

/**
 * The single persistence surface. Everything else talks to the store; nothing
 * else touches SQLite. Reads return plain domain objects; writes are synchronous
 * (better-sqlite3) which keeps the harness logic simple and race-free.
 *
 * **The rule is about SQLite access, not about one class** (issue #221). The
 * bodies live in domain modules beside this file — each holding one group of
 * related tables, taking nothing but `{db, now}`, and owning the row mappers and
 * the `ensureColumns` entries for its own tables — and this is the composition
 * root that instantiates them and delegates. Nothing outside `src/store/` gains a
 * `better-sqlite3` import, which `test/storeModules.test.ts` asserts structurally
 * rather than trusting.
 *
 * Method names and signatures are exactly what they have always been, so every
 * call site is unchanged. What a delegation costs is one line; what it buys is
 * that a related set of invariants — the issue-verdict exclusion matrix on
 * {@link IssueVerdictStore} being the clearest — sits in one readable scope instead of
 * hundreds of lines apart, joined only by prose.
 */

export class Store {
  private readonly db: Database.Database;
  private readonly tasksStore: TaskStore;
  private readonly jobs: JobStore;
  private readonly schedules: JobScheduleStore;
  private readonly priority: PriorityStore;
  private readonly profileOverrides: ProfileOverrideStore;
  private readonly knowledge: KnowledgeStore;
  private readonly remedies: RemedyStore;
  private readonly mcpCalls: McpCallStore;
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
  private readonly prWatchSeeds: PrWatchSeedStore;
  private readonly workItemLinks: WorkItemLinkStore;
  private readonly reviewWaitStore: ReviewWaitStore;
  private readonly prReviews: PrReviewStore;
  private readonly prReviewRoutes: PrReviewRouteStore;
  private readonly prReviewExternals: PrReviewExternalStore;
  private readonly decisions: DecisionStore;
  private readonly world: WorldStore;
  private readonly errors: ErrorStore;
  private readonly graph: GraphStore;
  private readonly bugFilings: BugFilingStore;
  private readonly floor: FloorStore;
  private readonly tickets: TicketStore;
  private readonly upgrades: UpgradeStore;
  private readonly pets: PetStore;
  private readonly pool: PoolStore;

  /**
   * @param project The project name this deployment declares (`pool.project`), or
   * undefined where it declares none. It is handed to the knowledge module so every
   * fact is stamped with it as it is written, and it gates the one backfill the
   * pool adds — see {@link stampFactsWithProject}.
   */
  constructor(dbPath: string, clock: Clock = systemClock, project?: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Before the schema, because `CREATE TABLE IF NOT EXISTS` would otherwise stand
    // an empty table up under the new name beside the full one under the old, and
    // leave every row that predates the rename invisible with nothing red.
    renameTables(this.db, ISSUE_VERDICT_RENAMES);
    // Before the schema, and around it: a table whose *key* changed is renamed
    // out of the way so `SCHEMA`'s own definition creates the new shape, then its
    // rows are copied across resolving the old key into the new one. All in one
    // transaction — a crash halfway leaves the old table exactly as it was.
    rebuildTables(this.db, [...VALIDATION_REBUILDS, ...GRAPH_REBUILDS, ...KNOWLEDGE_REBUILDS], () =>
      this.db.exec(SCHEMA),
    );
    // Before any module is constructed, let alone reads: a domain module reading
    // a migrated column on a database created by an older build reads `undefined`.
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
      KNOWLEDGE_COLUMNS,
      ENVIRONMENT_COLUMNS,
      WATCH_COLUMNS,
      PR_REVIEW_ROUTE_COLUMNS,
      SCRATCH_COLUMNS,
      REVIEW_PACK_COLUMNS,
    ]) {
      addedColumns.push(...ensureColumns(this.db, columns));
    }
    // The one migration that has to know a column was *just* added rather than
    // merely being present: `pets.opened_at` null means "still an egg", so every
    // pet from before the shell existed is stamped as already opened, once. Run on
    // every boot instead, it would open the eggs an operator was saving.
    if (addedColumns.includes('pets.opened_at')) openPetsFromBeforeEggs(this.db);
    // The second of the two, and the same shape: a graduation's `exit` is null on
    // every row written before there were three of them, and null there is a value
    // nothing recognises rather than a value that happens to be absent. Every one
    // of those rows was a documentation pull request, which is what it is stamped.
    // Run on every boot instead, it would rewrite the exit of every job and ticket
    // graduation written since.
    if (addedColumns.includes('knowledge_graduations.exit')) stampGraduationsBeforeExits(this.db);
    // The third of the three, and the one whose null is *most* load-bearing:
    // `knowledge_facts.project` null spells "no project", which would exclude every
    // claim the store already holds from ever being published — and every one of
    // them was in fact learned about the deployment's current project. Run on every
    // boot instead, it would relabel every claim written since the day an operator
    // pointed the harness at a second one. A deployment that declares no name stamps
    // nothing, which is the honest answer rather than a guess.
    if (addedColumns.includes('knowledge_facts.project') && project !== undefined) {
      stampFactsWithProject(this.db, project);
    }
    // The fourth, and the same shape again: `local_runs.interrupted_at` null means
    // nobody stamped this row, which a resume reads as "unknown, do not bring it
    // back". Right for a hard crash and wrong for the row this very boot is upgrading
    // over — left live by a fast stop a moment ago — so a live row is dated to now,
    // once. Ungated it would re-date every stale row on every boot and resume it for
    // ever, which is the thing the stamp exists to stop.
    if (addedColumns.includes('local_runs.interrupted_at')) dateInterruptionsFromBeforeTheStamp(this.db, clock());
    // The migrations that are not columns, here for the same reason the pass above
    // is — before any module is constructed, let alone reads. #203's
    // `floor_completions` becomes #234's `issue_runs`, carrying the operator's
    // standing dismissals, which is what stops every cleared card coming back; and
    // the two halves of the retired `single` plan shape are put back together —
    // the status is absorbed into `active`, and the plan that carried no parts
    // because "one pull request" *meant* no parts gets the one part it always was.
    // Ordered: the backfill reads the status, so it must see the absorbed one.
    adoptFloorCompletions(this.db);
    absorbSinglePlanStatus(this.db);
    backfillWholePlanParts(this.db, clock());
    // What kind of work each historical task was, so the by-task-type and
    // by-check spend tables can speak about the runs that predate the columns.
    // The one place a dispatch reason is ever parsed — see the function.
    backfillTaskDispatchKind(this.db);
    // The environment rows a part-ref goal was filed under. The attribution walk
    // stopped on any `issue:`-prefixed ref, which a part is, so a planned goal's
    // landings were labelled with the part that opened the pull request — a ref
    // nothing else asks about. The landings are relabelled and the arrivals
    // discarded for the desk to re-derive; see the function for why those are
    // opposite answers.
    repairPartRefGoals(this.db);
    // The old reach denominator counted only landed work, so a partial planned
    // goal could be recorded as arrived. Discard those claims; the fixed desk
    // re-derives the real arrival once every owed part is confirmed.
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
    // Every claim an agent ever filed and every lesson an operator ever wrote,
    // carried into the one store that now holds all three — once per database, and
    // gated on a name because both ways of getting that wrong are silent. See
    // `foldClaimStores`.
    foldClaimStores(this.db, clock());
    // And the pet ledger's side of the same move: what an operator did about a
    // claim used to be a `finding` action and is now a `claim` one, which is a
    // different key — so without this every triaged finding and every promoted
    // lesson in the deployment's history would look like an operator action nobody
    // had ever been paid for. See `spendRuledClaims`.
    spendRuledClaims(this.db, clock());
    // And the graduations the first fold lost to a `NOT NULL` no `ALTER TABLE`
    // could relax — a second pass, under a second id, because the first is
    // stamped done and an id is never edited in place. See
    // `refoldFindingGraduations`.
    refoldFindingGraduations(this.db, clock());
    const ctx: StoreContext = { db: this.db, now: clock };
    this.tasksStore = new TaskStore(ctx);
    this.jobs = new JobStore(ctx);
    this.schedules = new JobScheduleStore(ctx);
    this.priority = new PriorityStore(ctx);
    this.profileOverrides = new ProfileOverrideStore(ctx);
    this.knowledge = new KnowledgeStore(ctx, project ?? null);
    this.pool = new PoolStore(ctx);
    this.remedies = new RemedyStore(ctx);
    this.mcpCalls = new McpCallStore(ctx);
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
    this.prWatchSeeds = new PrWatchSeedStore(ctx);
    this.workItemLinks = new WorkItemLinkStore(ctx);
    this.reviewWaitStore = new ReviewWaitStore(ctx);
    this.prReviews = new PrReviewStore(ctx);
    this.prReviewRoutes = new PrReviewRouteStore(ctx);
    this.prReviewExternals = new PrReviewExternalStore(ctx);
    this.decisions = new DecisionStore(ctx);
    this.world = new WorldStore(ctx);
    this.errors = new ErrorStore(ctx);
    this.graph = new GraphStore(ctx);
    this.bugFilings = new BugFilingStore(ctx);
    this.floor = new FloorStore(ctx);
    this.tickets = new TicketStore(ctx);
    this.upgrades = new UpgradeStore(ctx);
    this.pets = new PetStore(ctx);
  }

  /**
   * Is the handle still open? Asked by anything that fires on a timer rather than
   * on a call — a cycle that arrives after the store was closed throws from inside
   * a `void` call, where there is nothing left to record it with.
   */
  get open(): boolean {
    return this.db.open;
  }

  close(): void {
    // Persist anything still buffered before the handle goes away.
    this.transcripts.flushAll();
    this.db.close();
  }

  // -- Tasks ---------------------------------------------------------------

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

  // -- Jobs (operator-launched queue) --------------------------------------

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

  // -- Job schedules (recurring briefs) ---------------------------------

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

  // -- Priority overrides (operator "Up next" re-ordering, issue #128) -------

  setPriorityOverrides(origins: string[]): void {
    this.priority.setPriorityOverrides(origins);
  }
  listPriorityOverrides(): PriorityOverride[] {
    return this.priority.listPriorityOverrides();
  }
  reconcilePriorityOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    this.priority.reconcilePriorityOverrides(trackedOrigins, ttlMs);
  }

  // -- Profile overrides (operator "run this queued row on X") --

  setProfileOverride(origin: string, profile: string | null): void {
    this.profileOverrides.setProfileOverride(origin, profile);
  }
  listProfileOverrides(): ProfileOverride[] {
    return this.profileOverrides.listProfileOverrides();
  }
  reconcileProfileOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    this.profileOverrides.reconcileProfileOverrides(trackedOrigins, ttlMs);
  }

  // -- Goal priority (the operator's "this goal first, and everything under it") --

  setGoalPriority(originRef: string, priority: boolean): void {
    this.priority.setGoalPriority(originRef, priority);
  }
  listGoalPriorities(): GoalPriority[] {
    return this.priority.listGoalPriorities();
  }

  // -- Findings (what an agent noticed outside its own task) ----------------

  // -- Lessons (what working one goal taught, kept for the next) -------------

  // -- Knowledge (what the fleet knows about this repository) -----------------

  proposeFact(...args: Parameters<KnowledgeStore['proposeFact']>): FactProposalOutcome {
    return this.knowledge.proposeFact(...args);
  }
  agreeWithFact(...args: Parameters<KnowledgeStore['agreeWithFact']>): FactAgreementOutcome {
    return this.knowledge.agreeWithFact(...args);
  }
  recordSimilarities(...args: Parameters<KnowledgeStore['recordSimilarities']>): void {
    this.knowledge.recordSimilarities(...args);
  }
  listSimilarities(): KnowledgeSimilarity[] {
    return this.knowledge.listSimilarities();
  }
  mergeFacts(...args: Parameters<KnowledgeStore['mergeFacts']>): FactMergeOutcome {
    return this.knowledge.mergeFacts(...args);
  }
  getFact(id: string): KnowledgeFact | null {
    return this.knowledge.getFact(id);
  }
  listFacts(limit?: number): KnowledgeFact[] {
    return this.knowledge.listFacts(limit);
  }
  listFactsForGoal(goalRef: string, limit?: number): KnowledgeFact[] {
    return this.knowledge.listFactsForGoal(goalRef, limit);
  }
  factLabels(ids: string[]): Map<string, string> {
    return this.knowledge.factLabels(ids);
  }
  listCorroborations(factId: string): KnowledgeCorroboration[] {
    return this.knowledge.listCorroborations(factId);
  }
  factCounts(): Map<string, FactCounts> {
    return this.knowledge.factCounts();
  }
  contradictFact(...args: Parameters<KnowledgeStore['contradictFact']>): FactContradictionOutcome {
    return this.knowledge.contradictFact(...args);
  }
  listContradictions(factId: string): KnowledgeContradiction[] {
    return this.knowledge.listContradictions(factId);
  }
  resolveContradiction(id: string, input: ContradictionRuling): ContradictionOutcome {
    return this.knowledge.resolveContradiction(id, input);
  }
  askFacts(query: FactQuery): KnowledgeFact[] {
    return this.knowledge.askFacts(query);
  }
  recordFactAsks(...args: Parameters<KnowledgeStore['recordFactAsks']>): void {
    this.knowledge.recordFactAsks(...args);
  }
  setFactReach(id: string, reach: FactReach): KnowledgeFact | null {
    return this.knowledge.setFactReach(id, reach);
  }
  listResolvableNotices(): KnowledgeFact[] {
    return this.knowledge.listResolvableNotices();
  }
  resolveNotice(id: string): KnowledgeFact | null {
    return this.knowledge.resolveNotice(id);
  }

  /**
   * Open the work that takes a claim somewhere, and record that it was opened —
   * **one transaction over two modules**.
   *
   * Here rather than in either of them because it is a cross-domain write and this
   * is the caller that holds both: `jobs.ts` owns the queue and `knowledge.ts` owns
   * the facts, and a store module reaching a sibling's tables is what
   * `test/storeModules.test.ts` refuses.
   *
   * One transaction because both half-landings are silent. A job with no
   * graduation naming it is work that lands and takes nothing out of any prompt —
   * the fleet goes on paying for a sentence somebody else is already carrying. A
   * graduation naming no job is a claim the page shows as on its way somewhere
   * nothing is taking it.
   *
   * **One method for all three exits, and that is the whole of this change.** A
   * documentation pull request and a promoted finding were two implementations of
   * one act, and the weaker one was silent: it stamped a status and never learned
   * what became of the job. Now both write the same row, and the same sweep reads
   * it.
   *
   * The job carries **`originRef: fact.aboutRef`** — the world item the claim is
   * *about*, and never the goal it was first observed on. The graph adopts a job by
   * its origin, so attributing this one to the observer's goal would file the work
   * under somebody else's issue, which is the defect `findingJobRequest` already
   * refused by carrying a finding's `ref` rather than its `originRef`. A claim
   * about nothing tracked has a null `aboutRef`, and a job with no origin stands in
   * for nothing — which is exactly true of it.
   */
  exitFact(fact: KnowledgeFact, exit: FactExit, work: { title: string; prompt: string }): FactExited {
    const write = this.db.transaction((): FactExited => {
      const job = this.jobs.createJob({
        title: work.title,
        prompt: work.prompt,
        // A `ticket` exit touches no repository — the agent writes a title and a
        // body and hands them to `link_ticket` — so cutting a worktree and a
        // branch for it would be pure cost. The other two write files in a tree:
        // a documentation change has to be pushed to open a pull request from, and
        // a job is the work itself.
        kind: exit.exit === 'ticket' ? 'desk' : 'code',
        originRef: fact.aboutRef,
      });
      return { job, graduation: this.knowledge.recordGraduation(fact.id, job.id, exit) };
    });
    return write();
  }
  findGraduationByJobId(jobId: string): KnowledgeGraduation | null {
    return this.knowledge.findGraduationByJobId(jobId);
  }
  linkGraduationTicket(id: string, ticketRef: string): KnowledgeGraduation | null {
    return this.knowledge.linkGraduationTicket(id, ticketRef);
  }
  listGraduations(limit?: number): KnowledgeGraduation[] {
    return this.knowledge.listGraduations(limit);
  }
  openGraduations(): KnowledgeGraduation[] {
    return this.knowledge.openGraduations();
  }
  getGraduation(id: string): KnowledgeGraduation | null {
    return this.knowledge.getGraduation(id);
  }
  noteGraduationPr(id: string, prRef: string): void {
    this.knowledge.noteGraduationPr(id, prRef);
  }
  settleGraduation(id: string, outcome: GraduationOutcome): KnowledgeGraduation | null {
    return this.knowledge.settleGraduation(id, outcome);
  }

  // -- Remedies (why the fleet came back to a PR, and what settled it) --------

  recordRemedy(input: RemedyInput): Remedy {
    return this.remedies.recordRemedy(input);
  }
  listRemediesSince(since: string): Remedy[] {
    return this.remedies.listRemediesSince(since);
  }
  listRecentRemedies(kind: RemedyKind, limit: number): Remedy[] {
    return this.remedies.listRecentRemedies(kind, limit);
  }

  // -- The cross-fleet pool (docs/spec/28-cross-fleet-pool.md) ----------------

  listPublishableFacts(): KnowledgeFact[] {
    return this.knowledge.listPublishableFacts();
  }
  setFactKeepLocal(id: string, keepLocal: boolean): KnowledgeFact | null {
    return this.knowledge.setFactKeepLocal(id, keepLocal);
  }
  replacePoolFleetClaims(fleetId: string, claims: readonly PoolMirroredClaim[]): void {
    this.pool.replaceFleetClaims(fleetId, claims);
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
  listMirroredClaims(): PoolMirroredClaim[] {
    return this.pool.listMirroredClaims();
  }
  mirroredClaimsForFact(factId: string): PoolMirroredClaim[] {
    return this.pool.mirroredClaimsForFact(factId);
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

  // -- MCP calls (which tools the fleet reaches for, and which it never does) -

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

  // -- Human tasks (work only a person can do) -------------------------------

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

  // -- Plans (the multi-PR issue funnel) -----------------------------------

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

  // -- Validation (how anyone checks the goal was met) -----------------------

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

  // -- Issue verdicts (conclusion / delivery / shortfall / appraisal) ------------

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

  // -- Operator instructions on a goal ---------------------------------------

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

  // -- Scratch pads and retrospectives (a goal's written record) ------------

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

  // -- Review packs (a change restated for a person, and what they did to it) --

  recordReviewPack(pack: ReviewPack): ReviewPackRecord {
    return this.reviewPacks.recordReviewPack(pack);
  }
  getCurrentReviewPack(prNumber: number): ReviewPackRecord | null {
    return this.reviewPacks.getCurrentReviewPack(prNumber);
  }
  listReviewPacks(prNumber: number): ReviewPackRecord[] {
    return this.reviewPacks.listReviewPacks(prNumber);
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

  // -- The account's Claude usage windows ------------------------------------

  recordRateLimits(limits: AccountRateLimits): void {
    this.rateLimits.recordRateLimits(limits);
  }
  readRateLimits(): AccountRateLimits | null {
    return this.rateLimits.readRateLimits();
  }
  listRateLimitReadingsSince(since: string): AccountRateLimits[] {
    return this.rateLimits.listRateLimitReadingsSince(since);
  }

  // -- The harness's own build ----------------------------------------------

  readUpgradeIntent(): UpgradeIntent {
    return this.upgrades.readUpgradeIntent();
  }
  writeUpgradeIntent(intent: UpgradeIntent): UpgradeIntent {
    return this.upgrades.writeUpgradeIntent(intent);
  }

  // -- Agents (plus usage, flags and files) ---------------------------------

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
  /**
   * What this deployment has spent since `sinceIso` — **every** source of it.
   *
   * Two tables hold dated cost deltas: `usage_events` for the fleet's agents, and
   * `local_run_cost_deltas` for the sessions holding the machine's dev environment
   * up. Both are money on the same account, so both belong in the one figure the
   * gauges draw and the pets' beats are earned from — and this addition is the one
   * place they are added. A third source of spend is added here, or it is money the
   * cockpit states nowhere while claiming to state all of it.
   */
  sumUsageCostSince(sinceIso: string): number {
    return this.agents.sumUsageCostSince(sinceIso) + this.localRuns.sumLocalRunCostSince(sinceIso);
  }
  /**
   * The agents' dated deltas alone, for the reader that needs to know **whose**.
   *
   * Deliberately not the merged list: the reliability breakdown joins these to agents
   * by id to price a pull request's CI, and a local run's delta is a row it can never
   * match. {@link Store.listCostDeltasSince} is the one to reach for when the question
   * is "what went out, and when".
   */
  listUsageEventsSince(sinceIso: string): UsageEvent[] {
    return this.agents.listUsageEventsSince(sinceIso);
  }
  /** Every dated delta, whatever spent it, oldest first — the spend timeline's input. */
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

  // -- Transcripts ---------------------------------------------------------

  appendTranscript(agentId: string, chunk: string): void {
    this.transcripts.appendTranscript(agentId, chunk);
  }
  flushTranscript(agentId: string): void {
    this.transcripts.flushTranscript(agentId);
  }
  getTranscript(agentId: string): string {
    return this.transcripts.getTranscript(agentId);
  }

  // -- Escalations and proposals -------------------------------------------

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

  // -- Stack landings (a standing authorization over a whole chain) ----------

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

  // -- Branch reaps (merged branches already cleaned up) --------------------

  recordBranchReap(prNumber: number, branch: string): void {
    this.branchReaps.recordBranchReap(prNumber, branch);
  }
  reapedPrs(): ReadonlySet<number> {
    return this.branchReaps.reapedPrs();
  }

  // -- Environments (where a goal's landed work has got to) -----------------

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

  // -- The post-deploy watch (what a goal declared production would have to show) --
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

  // -- The local run (the machine's one dev environment) --------------------

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
  markLocalRunSeen(id: string): void {
    this.localRuns.markLocalRunSeen(id);
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

  // -- PR watch seeds (the harness's own PRs, already tagged) ---------------

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

  // -- Review waits (how long a PR has sat on a reviewer) -------------------

  foldReviewWaits(waiting: readonly number[]): void {
    this.reviewWaitStore.foldReviewWaits(waiting);
  }
  reviewWaits(): ReadonlyMap<number, string> {
    return this.reviewWaitStore.reviewWaits();
  }

  // -- Fleet reviews (the harness's own read of a diff) ---------------------

  recordPrReview(input: PrReviewInput): PrReview {
    return this.prReviews.recordPrReview(input);
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
  recordPrReviewedElsewhere(prNumber: number, detail: string): void {
    this.prReviewExternals.recordPrReviewedElsewhere(prNumber, detail);
  }
  prsReviewedElsewhere(): ReadonlySet<number> {
    return this.prReviewExternals.prsReviewedElsewhere();
  }

  // -- Decisions (audit) ---------------------------------------------------

  recordDecision(input: Omit<Decision, 'id' | 'createdAt' | 'rule' | 'admission'>): Decision {
    return this.decisions.recordDecision(input);
  }
  listDecisions(limit?: number): Decision[] {
    return this.decisions.listDecisions(limit);
  }
  listDecisionsForGoal(goalRef: string, limit?: number): Decision[] {
    return this.decisions.listDecisionsForGoal(goalRef, limit);
  }

  // -- World change history and connector persistence -----------------------

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

  // -- Error log -----------------------------------------------------------

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

  // -- Work graph, filings and ignores --------------------------------------

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

  // -- Bugs raised against a story ------------------------------------------

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

  // -- Runs at a goal -------------------------------------------------------

  recordIssueRun(input: Parameters<FloorStore['recordIssueRun']>[0]): void {
    this.floor.recordIssueRun(input);
  }
  dismissIssueRun(originRef: string, note: string | null = null): boolean {
    return this.floor.dismissIssueRun(originRef, note);
  }
  listIssueRuns(): IssueRun[] {
    return this.floor.listIssueRuns();
  }

  // -- The ticket mirror ----------------------------------------------------

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
  // -- Pets -----------------------------------------------------------------

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

/**
 * What sending a claim out produced: the job an agent will work, and the row that
 * links the two.
 *
 * Both, because the caller needs both — the route hands the job back so the
 * cockpit can watch it in Up next, and the graduation is what the page draws the
 * pull request or the ticket from once there is one.
 */
interface FactExited {
  job: Job;
  graduation: KnowledgeGraduation;
}

/**
 * The name of the one-shot that folds `findings` and `lessons` into
 * `knowledge_facts`, and **never edited in place**.
 *
 * `VIVARIUM_RESET`'s rule, pointed the other way (CLAUDE.md, "Persistence"). That
 * constant names one clearance, so renaming it declares a *second* clearance that
 * runs on every database that already had the first. This names one fold, and
 * renaming it would re-fold every claim an operator has since ruled on — the
 * dismissed ones back as proposals, the promoted ones beside themselves — on the
 * boot after the build lands, with nothing red. A further pass is a further id.
 */
const KNOWLEDGE_FOLD = 'findings-and-lessons-into-knowledge-facts';

/**
 * Carry every `findings` and `lessons` row across into `knowledge_facts`, **once
 * per database**.
 *
 * ## Why it is gated on a name and not on a count
 *
 * The two failures are exact opposites and **both are silent**. A fold that runs
 * on every boot re-creates the rows an operator has since ruled on: a claim they
 * dismissed comes back as a proposal, a claim they retired comes back beside its
 * own retirement, and the page fills from underneath with decisions that were
 * already made. A fold that never runs loses every claim the deployment holds, on
 * the boot the operator takes the build — and a knowledge page that is simply
 * empty looks exactly like a deployment nobody has raised anything on yet.
 * Neither errors. So the gate is {@link runOnce} on a named id.
 *
 * It also cannot be gated on "did `ensureColumns` add a column", which is the
 * other one-shot gate this file uses. That test is true on exactly the boot a
 * column arrives, and this fold has no column of its own to arrive with: the
 * columns it writes into (`about_ref`, `where_at`) landed with the unified intake,
 * one release before the stores merged.
 *
 * ## Here rather than in a domain module
 *
 * It reads two domains' tables and writes a third's, which is the cross-domain
 * join `test/storeModules.test.ts` refuses inside a module and CLAUDE.md sends to
 * the composition root. This is that root.
 *
 * ## What it does not do
 *
 * **It copies, and deletes nothing.** The `findings` and `lessons` rows stay
 * exactly where they are, unread. A fold that got a row wrong is recoverable
 * while its source is still on disk and is not once the source is dropped, and
 * two dozen kilobytes of dead rows is a cheap price for that.
 */
function foldClaimStores(db: Database.Database, at: string): void {
  runOnce(db, KNOWLEDGE_FOLD, at, () => foldFindings(db) + foldLessons(db));
}

/**
 * The name of the one-shot that stamps every claim already ruled on as spent in
 * the pet ledger, and **never edited in place** for {@link KNOWLEDGE_FOLD}'s
 * reason.
 */
const CLAIMS_SPENT = 'ruled-claims-into-pet-actions';

/**
 * Record every claim an operator has **already** ruled on as a pet action that
 * paid nothing — once per database.
 *
 * ## What it is for
 *
 * A pet comes from an operator *acting*, and one of the acts is ruling on a claim
 * an agent raised. That used to be `finding:<finding id>` and is now
 * `claim:<fact id>`, because the three claim stores became one — and `pet_actions`
 * is keyed on exactly that pair. So on the boot a deployment takes this build,
 * every finding it ever triaged and every lesson it ever promoted arrives as a key
 * the scan has never seen, and the vivarium pays out for a year of decisions in one
 * afternoon.
 *
 * Nothing errors, and a burst of creatures looks exactly like the feature working —
 * which is the whole reason this is a gated migration rather than something the
 * scan could be trusted to notice.
 *
 * ## Why it writes rows rather than moving the watermark
 *
 * `pet_actions` already has a word for this: a row with a null `pet_id` is an
 * action that was seen and rolled nothing. The vivarium's own start would catch
 * only the rows older than it, and an operator who has been running this for a
 * month has a month of rulings inside that window. Writing the keys is the only
 * thing that answers "seen already" for exactly the set that was.
 *
 * `INSERT OR IGNORE`, so a claim the scan somehow reached first keeps whatever it
 * rolled — a stamp here must never overwrite a pet.
 */
function spendRuledClaims(db: Database.Database, at: string): void {
  runOnce(db, CLAIMS_SPENT, at, () => {
    const rows = db.prepare(`SELECT id, ruled_at FROM knowledge_facts WHERE ruled_at IS NOT NULL`).all() as {
      id: string;
      ruled_at: string;
    }[];
    const insert = db.prepare(`INSERT OR IGNORE INTO pet_actions (kind, ref, at, pet_id) VALUES ('claim', ?, ?, NULL)`);
    for (const row of rows) insert.run(row.id, row.ruled_at);
    return rows.length;
  });
}

/**
 * Every finding becomes a fact, its evidence becomes the corroboration behind it,
 * and what an operator did about it becomes a graduation.
 *
 * ## The kind does not become a column
 *
 * `FindingKind` was a prediction of **what an operator would do** — close a
 * duplicate, unblock the work, decide whether it becomes a job, open a docs pull
 * request — which is the operator's knowledge and not the reporting agent's. The
 * unified intake removed that question from the agent (`raise` takes no kind), so
 * nothing writes one any more, and a column only a migration ever fills is a
 * column that means *this row predates the intake* wearing a name that says
 * otherwise. The other reading — that it survives as an **operator-set label** —
 * is a real one and is argued in `docs/spec/27-knowledge.md`; what settles it here
 * is that no operator has ever set one, so a fold that made the column would be
 * inventing a labelling nobody did.
 *
 * The word is not lost. It goes into the corroboration's **words**, which is where
 * everything else about how an observation arrived already lives, and where an
 * operator reads it beside the evidence rather than as a chip claiming a taxonomy
 * the harness no longer keeps.
 *
 * ## A pre-split row keeps its blob
 *
 * A finding filed before `summary`/`where`/`detail` were three fields holds a
 * whole report in `summary` and null in the other two. It becomes a fact whose
 * claim is that whole report, **unsplit**: no content migration guesses at where
 * the seams were, which is the stance `docs/spec/13-jobs-and-tickets.md` took the
 * day the fields were split and which is if anything stronger here, since a claim
 * is matched against other claims by its text. The card clamps it, so an old row
 * reads as a slightly tall card rather than as a lie about its own structure.
 *
 * ## `SELECT *`, deliberately
 *
 * `where_at`, `detail` and `ticket_ref` are `ALTER TABLE` columns, so a database
 * old enough may not have them at all. Naming them in the `SELECT` would throw on
 * exactly the databases this exists for; `SELECT *` binds by name in the reader
 * below and reads a missing column as absent, which is what it is. (The warning
 * against `SELECT *` in `migrate.ts` is about a *copy* that binds by position —
 * a different hazard, and not this one.)
 */
function foldFindings(db: Database.Database): number {
  if (!hasTable(db, 'findings')) return 0;
  const rows = db.prepare(`SELECT * FROM findings ORDER BY created_at ASC, rowid ASC`).all() as FoldedFinding[];
  const fact = db.prepare(
    `INSERT OR IGNORE INTO knowledge_facts
       (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, resolves_when,
        about_ref, where_at, created_at, updated_at)
     VALUES (?, ?, 'fleet', 'standing', NULL, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const voice = db.prepare(
    `INSERT OR IGNORE INTO knowledge_corroborations
       (id, fact_id, agent_id, task_id, goal_ref, session_id, words, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  for (const row of rows) {
    const id = foldedFactId(row.id);
    const ruled = row.status === 'open' ? null : row.updated_at;
    fact.run(
      id,
      row.summary,
      findingReach(row.status),
      row.origin_ref,
      ruled,
      row.ref,
      row.where_at ?? null,
      row.created_at,
      row.updated_at,
    );
    voice.run(
      `knc_${row.id}`,
      id,
      row.agent_id,
      row.task_id,
      corroborationGoal(row.origin_ref),
      findingWords(row),
      row.created_at,
    );
  }
  foldFindingGraduations(db);
  return rows.length;
}

/**
 * The graduation half of {@link foldFindings}, on its own — every finding whose
 * operator already chose an exit, as the row that now records one.
 *
 * A `promoted` or `filing` finding gets an **open** graduation, which is the whole
 * point of the merge: the finding stores stamped a status and never learned what
 * became of the job, and an open row is what the sweep reads. No job means no
 * graduation, and the pair cannot arise — `resolveFinding` took the job's id on
 * every arm that left `open`. If one somehow exists, the fact still takes the
 * reach the operator's verdict earned it, and there is simply nothing to draw
 * beside it.
 *
 * Its own function because it has to run **twice** on the databases #506 is about:
 * once inside the fold, and once again under {@link REFOLD_GRADUATIONS} for the
 * deployments whose first run wrote nothing. `INSERT OR IGNORE` keyed on
 * `kng_<finding id>` is what makes the second pass safe — it cannot double-write,
 * and it cannot disturb a graduation recorded since.
 */
function foldFindingGraduations(db: Database.Database): number {
  if (!hasTable(db, 'findings')) return 0;
  const rows = db.prepare(`SELECT * FROM findings ORDER BY created_at ASC, rowid ASC`).all() as FoldedFinding[];
  const exit = db.prepare(
    `INSERT OR IGNORE INTO knowledge_graduations
       (id, fact_id, exit, job_id, target, bar, pr_ref, ticket_ref, outcome, settled_at, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
  );
  let written = 0;
  for (const row of rows) {
    const kind = findingExit(row.status);
    if (kind === null || row.job_id === null) continue;
    const landed = row.status === 'filed';
    written += exit.run(
      `kng_${row.id}`,
      foldedFactId(row.id),
      kind,
      row.job_id,
      row.ticket_ref ?? null,
      landed ? 'landed' : null,
      landed ? row.updated_at : null,
      row.updated_at,
    ).changes;
  }
  return written;
}

/**
 * The name of the one-shot that re-runs the graduation half of the fold, and
 * **never edited in place** for {@link KNOWLEDGE_FOLD}'s reason — least of all by
 * renaming that one, which would re-fold every claim an operator has since ruled
 * on.
 */
const REFOLD_GRADUATIONS = 'refold-finding-graduations';

/**
 * Put back the graduations the first fold silently dropped — once per database.
 *
 * On every database created in `f07ddda`'s window, `knowledge_graduations.target`
 * is still `NOT NULL` (see `KNOWLEDGE_REBUILDS`), and the fold's `INSERT OR
 * IGNORE` — there for the primary-key collision with the lessons mirror —
 * swallowed the constraint failure on every one of these rows. `runOnce` then
 * stamped the fold as done, so the loss was permanent: facts sitting at reach
 * `graduated` with nothing beside them saying where they went, and no open
 * graduation for the sweep to attribute a pull request or a ticket back to.
 *
 * The `findings` rows are still on disk, because the fold copies and deletes
 * nothing — which is precisely the recoverability that decision paid for.
 *
 * Ordering: the rebuild pass runs at the top of the constructor, so by the time
 * this runs `target` is nullable and the insert can land.
 */
function refoldFindingGraduations(db: Database.Database, at: string): void {
  runOnce(db, REFOLD_GRADUATIONS, at, () => foldFindingGraduations(db));
}

/**
 * Every lesson becomes a fact — and the promoted ones **already are one**.
 *
 * `KnowledgeStore.adoptLessons` has been mirroring a promoted lesson in as an
 * injected fleet claim under an id derived from the lesson's since delivery moved,
 * so the fold cannot insert those again: it would either collide on the primary
 * key or, worse, write a second copy under a second id and put one sentence in the
 * block twice. It uses **the same derivation** and `INSERT OR IGNORE`, so an
 * already-mirrored row is left exactly as it stands, with whatever an operator has
 * since done to it.
 *
 * That is also why a retired lesson can land here as a fact still at `injected`.
 * The mirror only ever un-mirrored a row nobody had touched; one that had been
 * corroborated or amended stayed, because at that point it is a fact in its own
 * right and the lessons panel is not where it is governed. `INSERT OR IGNORE`
 * keeps that answer rather than overwriting it with a status the lessons table
 * still holds.
 *
 * The status map has one row worth reading twice: a retired lesson becomes
 * `retired` and **never** `rejected`. The two words meant opposite things in the
 * two stores — `lessons` called its prune "retired" and said outright that a
 * lesson retired in error is simply written again, while `knowledge_facts` bars a
 * rejected claim by name — so folding a prune into a bar would refuse, by name and
 * forever, every claim an operator had merely tidied.
 */
function foldLessons(db: Database.Database): number {
  if (!hasTable(db, 'lessons')) return 0;
  const rows = db.prepare(`SELECT * FROM lessons ORDER BY created_at ASC, rowid ASC`).all() as FoldedLesson[];
  const fact = db.prepare(
    `INSERT OR IGNORE INTO knowledge_facts
       (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, resolves_when,
        about_ref, where_at, created_at, updated_at)
     VALUES (?, ?, 'fleet', 'standing', NULL, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
  );
  const voice = db.prepare(
    `INSERT OR IGNORE INTO knowledge_corroborations
       (id, fact_id, agent_id, task_id, goal_ref, session_id, words, created_at)
     VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?)`,
  );
  for (const row of rows) {
    const id = foldedFactId(row.id);
    fact.run(
      id,
      row.text,
      row.status === 'promoted' ? 'injected' : row.status === 'retired' ? 'retired' : 'proposal',
      row.origin_ref,
      row.status === 'proposed' ? null : row.updated_at,
      row.created_at,
      row.updated_at,
    );
    voice.run(
      `knc_${row.id}`,
      id,
      corroborationGoal(row.origin_ref),
      'Written down as a lesson about working this repository, before the knowledge base held them.',
      row.created_at,
    );
  }
  return rows.length;
}

/**
 * Where a finding's status puts the claim.
 *
 * The two that are not obvious are the two worth stating. `dismissed` becomes
 * `rejected` because that is what dismissing meant in `findings`: the store
 * already refused to fold a fresh report into a dismissed row, which is the
 * rejection bar under another name. And a `promoted` or `filing` finding stays a
 * **`proposal`** — an operator queueing work for a claim is not a ruling about how
 * far the claim carries, and a finding reached no agent at any status, so
 * anything else would put a sentence in front of the fleet that nobody vouched
 * for. What the operator did is the graduation row beside it.
 */
function findingReach(status: string): string {
  if (status === 'dismissed') return 'rejected';
  if (status === 'filed') return 'graduated';
  return 'proposal';
}

/** Which exit an operator's verdict on a finding was, or null when they took none. */
function findingExit(status: string): string | null {
  if (status === 'promoted') return 'job';
  if (status === 'filing' || status === 'filed') return 'ticket';
  return null;
}

/**
 * The observation behind a folded finding, in the terms an operator reads the
 * others in: what the agent actually saw, and how it arrived.
 *
 * The kind leads, because it is the one thing about a folded row that is not true
 * of anything raised since — it is a word the harness stopped asking for — and
 * because on a row with no `detail` it is the only thing there is to say beyond
 * the claim. A corroboration with no words at all would be a voice in the count
 * with nothing behind it, which is exactly what the corroborations table is a
 * table rather than a counter to avoid.
 */
function findingWords(row: FoldedFinding): string {
  const how = `Reported as a "${row.kind}" finding, before the claim stores merged.`;
  return row.detail ? `${how}\n\n${row.detail}` : how;
}

/** Whether this database has a table at all — a fresh one has neither of the folded two. */
function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) !== undefined;
}

/**
 * A `findings` row as the fold reads it — every column optional past the ones that
 * shipped in the original `CREATE`, because a database old enough predates the
 * three-field split and the ticket ref alike.
 */
interface FoldedFinding {
  id: string;
  agent_id: string;
  task_id: string;
  origin_ref: string | null;
  kind: string;
  ref: string | null;
  summary: string;
  status: string;
  job_id: string | null;
  where_at: string | null | undefined;
  detail: string | null | undefined;
  ticket_ref: string | null | undefined;
  created_at: string;
  updated_at: string;
}

/** A `lessons` row as the fold reads it. The table never gained a column. */
interface FoldedLesson {
  id: string;
  text: string;
  origin_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
