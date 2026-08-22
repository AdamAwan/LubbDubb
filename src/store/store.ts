import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import { systemClock, type Clock, type StoreContext } from './context.js';
import { ensureColumns, rebuildTables } from './migrate.js';
import { backfillTaskDispatchKind, TaskStore, TASK_COLUMNS } from './tasks.js';
import { JobStore, JOB_COLUMNS } from './jobs.js';
import { JobScheduleStore, JOB_SCHEDULE_COLUMNS } from './schedules.js';
import { PriorityStore } from './priority.js';
import { ProfileOverrideStore } from './profileOverrides.js';
import { FindingStore, FINDING_COLUMNS } from './findings.js';
import { LessonStore } from './lessons.js';
import {
  KnowledgeStore,
  KNOWLEDGE_COLUMNS,
  type ContradictionOutcome,
  type FactContradictionOutcome,
  type FactCounts,
  type FactProposalOutcome,
  type FactQuery,
} from './knowledge.js';
import { RemedyStore } from './remedies.js';
import { HumanTaskStore, HUMAN_TASK_COLUMNS } from './humanTasks.js';
import { absorbSinglePlanStatus, backfillWholePlanParts, PlanStore, PLAN_COLUMNS } from './plans.js';
import { ValidationStore, VALIDATION_COLUMNS, VALIDATION_REBUILDS } from './validation.js';
import { IssueVerdictStore, ISSUE_VERDICT_COLUMNS } from './issueVerdicts.js';
import { ScratchStore } from './scratch.js';
import { UpgradeStore } from './upgrades.js';
import { openPetsFromBeforeEggs, PetStore, PET_COLUMNS } from './pets.js';
import { InstructionStore } from './instructions.js';
import { AgentStore, AGENT_COLUMNS } from './agents.js';
import { TranscriptStore } from './transcripts.js';
import { EscalationStore } from './escalations.js';
import { StackLandingStore } from './landings.js';
import { BranchReapStore } from './branchReaps.js';
import { EnvironmentStore, repairPartRefGoals } from './environments.js';
import { LocalRunStore, LOCAL_RUN_COLUMNS } from './localRuns.js';
import { PrWatchSeedStore } from './prWatchSeeds.js';
import { WorkItemLinkStore } from './workItemLinks.js';
import { ReviewWaitStore } from './reviewWaits.js';
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
  Agent,
  AgentFile,
  AgentFileInput,
  AgentFlag,
  AgentFlagInput,
  AgentUsage,
  Decision,
  EnvironmentReachStatus,
  EnvironmentGateRelease,
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
  IssueAssay,
  ErrorLogEntry,
  ErrorLogInput,
  Escalation,
  EscalationSpan,
  FactCommitment,
  FactReach,
  Finding,
  FindingInput,
  FindingStatus,
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
  KnowledgeGraduation,
  Lesson,
  LessonInput,
  Remedy,
  RemedyInput,
  RemedyKind,
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
  Retrospective,
  ScratchEntry,
  ScratchPadSummary,
  GoalPriority,
  PlanStatus,
  PriorityOverride,
  ProfileOverride,
  Proposal,
  StackLanding,
  StackLandingStatus,
  Task,
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
/**
 * How many lessons the knowledge adoption reads. Far above any real deployment's
 * count — the point is that it is not `listLessons`' display default, which would
 * silently leave the oldest promoted lessons behind on a long-lived store.
 */
const ADOPTION_LIMIT = 10_000;

export class Store {
  private readonly db: Database.Database;
  private readonly tasksStore: TaskStore;
  private readonly jobs: JobStore;
  private readonly schedules: JobScheduleStore;
  private readonly priority: PriorityStore;
  private readonly profileOverrides: ProfileOverrideStore;
  private readonly findings: FindingStore;
  private readonly lessons: LessonStore;
  private readonly knowledge: KnowledgeStore;
  private readonly remedies: RemedyStore;
  private readonly humanTasks: HumanTaskStore;
  private readonly plans: PlanStore;
  private readonly validation: ValidationStore;
  private readonly verdicts: IssueVerdictStore;
  private readonly instructions: InstructionStore;
  private readonly scratch: ScratchStore;
  private readonly agents: AgentStore;
  private readonly transcripts: TranscriptStore;
  private readonly escalations: EscalationStore;
  private readonly landings: StackLandingStore;
  private readonly branchReaps: BranchReapStore;
  private readonly environments: EnvironmentStore;
  private readonly localRuns: LocalRunStore;
  private readonly prWatchSeeds: PrWatchSeedStore;
  private readonly workItemLinks: WorkItemLinkStore;
  private readonly reviewWaitStore: ReviewWaitStore;
  private readonly decisions: DecisionStore;
  private readonly world: WorldStore;
  private readonly errors: ErrorStore;
  private readonly graph: GraphStore;
  private readonly bugFilings: BugFilingStore;
  private readonly floor: FloorStore;
  private readonly tickets: TicketStore;
  private readonly upgrades: UpgradeStore;
  private readonly pets: PetStore;

  constructor(dbPath: string, clock: Clock = systemClock) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Before the schema, and around it: a table whose *key* changed is renamed
    // out of the way so `SCHEMA`'s own definition creates the new shape, then its
    // rows are copied across resolving the old key into the new one. All in one
    // transaction — a crash halfway leaves the old table exactly as it was.
    rebuildTables(this.db, [...VALIDATION_REBUILDS, ...GRAPH_REBUILDS], () => this.db.exec(SCHEMA));
    // Before any module is constructed, let alone reads: a domain module reading
    // a migrated column on a database created by an older build reads `undefined`.
    const addedColumns: string[] = [];
    for (const columns of [
      TASK_COLUMNS,
      AGENT_COLUMNS,
      DECISION_COLUMNS,
      FINDING_COLUMNS,
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
    ]) {
      addedColumns.push(...ensureColumns(this.db, columns));
    }
    // The one migration that has to know a column was *just* added rather than
    // merely being present: `pets.opened_at` null means "still an egg", so every
    // pet from before the shell existed is stamped as already opened, once. Run on
    // every boot instead, it would open the eggs an operator was saving.
    if (addedColumns.includes('pets.opened_at')) openPetsFromBeforeEggs(this.db);
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
    const ctx: StoreContext = { db: this.db, now: clock };
    this.tasksStore = new TaskStore(ctx);
    this.jobs = new JobStore(ctx);
    this.schedules = new JobScheduleStore(ctx);
    this.priority = new PriorityStore(ctx);
    this.profileOverrides = new ProfileOverrideStore(ctx);
    this.findings = new FindingStore(ctx);
    this.lessons = new LessonStore(ctx);
    this.knowledge = new KnowledgeStore(ctx);
    this.remedies = new RemedyStore(ctx);
    this.humanTasks = new HumanTaskStore(ctx);
    this.plans = new PlanStore(ctx);
    this.validation = new ValidationStore(ctx);
    this.verdicts = new IssueVerdictStore(ctx);
    this.instructions = new InstructionStore(ctx);
    this.scratch = new ScratchStore(ctx);
    this.agents = new AgentStore(ctx);
    this.transcripts = new TranscriptStore(ctx);
    this.escalations = new EscalationStore(ctx);
    this.landings = new StackLandingStore(ctx);
    this.branchReaps = new BranchReapStore(ctx);
    this.environments = new EnvironmentStore(ctx);
    this.localRuns = new LocalRunStore(ctx);
    this.prWatchSeeds = new PrWatchSeedStore(ctx);
    this.workItemLinks = new WorkItemLinkStore(ctx);
    this.reviewWaitStore = new ReviewWaitStore(ctx);
    this.decisions = new DecisionStore(ctx);
    this.world = new WorldStore(ctx);
    this.errors = new ErrorStore(ctx);
    this.graph = new GraphStore(ctx);
    this.bugFilings = new BugFilingStore(ctx);
    this.floor = new FloorStore(ctx);
    this.tickets = new TicketStore(ctx);
    this.upgrades = new UpgradeStore(ctx);
    this.pets = new PetStore(ctx);
    // Last, and after every module rather than beside the migrations above,
    // because it is a *cross-domain* copy rather than a schema repair: the
    // promoted lessons are facts, and `lessons.ts` owns its table while
    // `knowledge.ts` owns its own. This is the caller that holds both, which is
    // the only place a read across two domains belongs. Idempotent and re-run on
    // every boot — see `KnowledgeStore.adoptLessons` for why once is not enough.
    this.knowledge.adoptLessons(this.lessons.listLessons(ADOPTION_LIMIT));
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

  // -- Job schedules (recurring blueprints) ---------------------------------

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

  recordFinding(
    agentId: string,
    taskId: string,
    originRef: string | null,
    input: FindingInput,
  ): { finding: Finding; created: boolean } {
    return this.findings.recordFinding(agentId, taskId, originRef, input);
  }
  getFinding(id: string): Finding | null {
    return this.findings.getFinding(id);
  }
  listFindings(limit?: number): Finding[] {
    return this.findings.listFindings(limit);
  }
  findingLabels(ids: string[]): Map<string, string> {
    return this.findings.findingLabels(ids);
  }
  resolveFinding(
    id: string,
    status: Exclude<FindingStatus, 'open' | 'filed'>,
    jobId: string | null = null,
  ): Finding | null {
    return this.findings.resolveFinding(id, status, jobId);
  }
  findFindingByJobId(jobId: string): Finding | null {
    return this.findings.findFindingByJobId(jobId);
  }
  linkFindingTicket(id: string, ticketRef: string): Finding | null {
    return this.findings.linkFindingTicket(id, ticketRef);
  }

  // -- Lessons (what working one goal taught, kept for the next) -------------

  proposeLesson(input: LessonInput): Lesson {
    return this.lessons.proposeLesson(input);
  }
  getLesson(id: string): Lesson | null {
    return this.lessons.getLesson(id);
  }
  listLessons(limit?: number): Lesson[] {
    return this.lessons.listLessons(limit);
  }
  /**
   * Vouch for a lesson — and mirror it in, here rather than only at the next boot.
   *
   * Since delivery moved (issue #27 phase 3) the system prompt carries **one**
   * block and it is the knowledge base's, so a promoted lesson reaches agents as
   * the fact it is adopted into. Adopting only on boot would mean a lesson vouched
   * for now reached nobody until the harness was restarted — which is the failure
   * `adoptLessons` runs every boot to avoid, pointed at the other clock. The
   * cross-domain read belongs here for its reason: this is the caller that holds
   * both tables.
   */
  promoteLesson(id: string): Lesson | null {
    const lesson = this.lessons.promoteLesson(id);
    if (lesson) this.knowledge.adoptLessons([lesson]);
    return lesson;
  }
  /** Prune one, and un-mirror the fact it was adopted into while nothing has touched it. */
  retireLesson(id: string): Lesson | null {
    const lesson = this.lessons.retireLesson(id);
    if (lesson) this.knowledge.adoptLessons([lesson]);
    return lesson;
  }

  // -- Knowledge (what the fleet knows about this repository) -----------------

  proposeFact(...args: Parameters<KnowledgeStore['proposeFact']>): FactProposalOutcome {
    return this.knowledge.proposeFact(...args);
  }
  getFact(id: string): KnowledgeFact | null {
    return this.knowledge.getFact(id);
  }
  listFacts(limit?: number): KnowledgeFact[] {
    return this.knowledge.listFacts(limit);
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
   * Open the documentation work for a claim, and record that it was opened —
   * **one transaction over two modules**.
   *
   * Here rather than in either of them because it is a cross-domain write and this
   * is the caller that holds both, exactly as `adoptLessons` is: `jobs.ts` owns the
   * queue and `knowledge.ts` owns the facts, and a store module reaching a
   * sibling's tables is what `test/storeModules.test.ts` refuses.
   *
   * One transaction because both half-landings are silent. A job with no
   * graduation naming it is a documentation pull request that lands and takes
   * nothing out of any prompt — the fleet goes on paying for a sentence the
   * repository now states. A graduation naming no job is a claim the page shows as
   * on its way to a repository nothing is writing it into.
   *
   * The job carries **no origin**. `originRef` names the work a job stands in for,
   * and the graph adopts a job by it — so attributing this one to the goal the
   * claim was first seen on would file a documentation pull request under
   * somebody else's issue, which is the mistake `src/mcp/findings.ts` names when it
   * passes a finding's `ref` and never its `originRef`. A claim about the
   * repository stands in for no tracked work, and a job with no origin stands in
   * for nothing — which is exactly true here.
   */
  commitFact(fact: KnowledgeFact, commitment: FactCommitment, work: { title: string; prompt: string }): FactCommitted {
    const write = this.db.transaction((): FactCommitted => {
      // Code and not desk: writing a documentation change and opening a pull
      // request for it means files in a tree, so it wants a worktree and a branch —
      // the same reason `POST /api/findings/:id/promote` defaults a `docs`
      // promotion to a code job.
      const job = this.jobs.createJob({ title: work.title, prompt: work.prompt, kind: 'code', originRef: null });
      return { job, graduation: this.knowledge.recordGraduation(fact.id, job.id, commitment) };
    });
    return write();
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

  // -- Issue verdicts (conclusion / delivery / shortfall / assay) ------------

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
  recordAssay(input: Parameters<IssueVerdictStore['recordAssay']>[0]): IssueAssay {
    return this.verdicts.recordAssay(input);
  }
  getAssay(originRef: string): IssueAssay | null {
    return this.verdicts.getAssay(originRef);
  }
  listAssays(): IssueAssay[] {
    return this.verdicts.listAssays();
  }
  answerAssayProfile(originRef: string, goalRef: string): boolean {
    return this.verdicts.answerAssayProfile(originRef, goalRef);
  }
  setAssayComment(originRef: string, commentRef: string): void {
    this.verdicts.setAssayComment(originRef, commentRef);
  }
  clearAssay(originRef: string): boolean {
    return this.verdicts.clearAssay(originRef);
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
  listAllFiles(): AgentFile[] {
    return this.agents.listAllFiles();
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
  recordGoalArrival(input: { goalRef: string; environment: string; arrivedAt: string }): void {
    this.environments.recordGoalArrival(input);
  }
  listGoalArrivals(): GoalArrival[] {
    return this.environments.listGoalArrivals();
  }
  markArrivalAnnounced(goalRef: string, environment: string): void {
    this.environments.markArrivalAnnounced(goalRef, environment);
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

  // -- The local run (the machine's one dev environment) --------------------

  beginLocalRun(input: { originRef: string; ref: string; dir: string; url: string | null }): LocalRun {
    return this.localRuns.beginLocalRun(input);
  }
  markLocalRunPid(id: string, pid: number | null): void {
    this.localRuns.markLocalRunPid(id, pid);
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
  endStaleLocalRuns(note: string): number {
    return this.localRuns.endStaleLocalRuns(note);
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

  // -- Decisions (audit) ---------------------------------------------------

  recordDecision(input: Omit<Decision, 'id' | 'createdAt' | 'rule' | 'admission'>): Decision {
    return this.decisions.recordDecision(input);
  }
  listDecisions(limit?: number): Decision[] {
    return this.decisions.listDecisions(limit);
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
  patchTicketLabels(patch: TicketLabelPatch): void {
    this.tickets.patchTicketLabels(patch);
  }

  patchTicketState(patch: { number: number; state: string }): void {
    this.tickets.patchTicketState(patch);
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
 * What committing a claim produced: the documentation job an agent will work, and
 * the row that links the two.
 *
 * Both, because the caller needs both — the route hands the job back so the
 * cockpit can watch it in Up next, and the graduation is what the page draws the
 * pull request from once there is one.
 */
interface FactCommitted {
  job: Job;
  graduation: KnowledgeGraduation;
}
