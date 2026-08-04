import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';
import { systemClock, type Clock, type StoreContext } from './context.js';
import { ensureColumns } from './migrate.js';
import { TaskStore, TASK_COLUMNS } from './tasks.js';
import { JobStore } from './jobs.js';
import { PriorityStore } from './priority.js';
import { FindingStore, FINDING_COLUMNS } from './findings.js';
import { PlanStore, PLAN_COLUMNS } from './plans.js';
import { IssueVerdictStore } from './issueVerdicts.js';
import { ScratchStore } from './scratch.js';
import { AgentStore, AGENT_COLUMNS } from './agents.js';
import { TranscriptStore } from './transcripts.js';
import { EscalationStore } from './escalations.js';
import { DecisionStore, DECISION_COLUMNS } from './decisions.js';
import { WorldStore } from './world.js';
import { ErrorStore } from './errors.js';
import { GraphStore } from './graph.js';
import { adoptFloorCompletions, FloorStore } from './floor.js';
import type {
  Agent,
  AgentFile,
  AgentFileInput,
  AgentFlag,
  AgentFlagInput,
  AgentUsage,
  Decision,
  IssueAssay,
  ErrorLogEntry,
  ErrorLogInput,
  Escalation,
  Finding,
  FindingInput,
  FindingStatus,
  IssueRun,
  IssueConclusion,
  IssueDelivery,
  IssueShortfall,
  Job,
  Plan,
  PlanPart,
  PlanPartInput,
  Retrospective,
  ScratchEntry,
  ScratchPadSummary,
  PlanStatus,
  PriorityOverride,
  Proposal,
  Task,
  WorkNode,
  WorkNodeObservation,
  WorkItemFiling,
  WorldEvent,
  WorldEventInput,
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
  private readonly priority: PriorityStore;
  private readonly findings: FindingStore;
  private readonly plans: PlanStore;
  private readonly verdicts: IssueVerdictStore;
  private readonly scratch: ScratchStore;
  private readonly agents: AgentStore;
  private readonly transcripts: TranscriptStore;
  private readonly escalations: EscalationStore;
  private readonly decisions: DecisionStore;
  private readonly world: WorldStore;
  private readonly errors: ErrorStore;
  private readonly graph: GraphStore;
  private readonly floor: FloorStore;

  constructor(dbPath: string, clock: Clock = systemClock) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Before any module is constructed, let alone reads: a domain module reading
    // a migrated column on a database created by an older build reads `undefined`.
    for (const columns of [TASK_COLUMNS, AGENT_COLUMNS, DECISION_COLUMNS, FINDING_COLUMNS, PLAN_COLUMNS]) {
      ensureColumns(this.db, columns);
    }
    // The one migration that is not a column: #203's `floor_completions` becomes
    // #234's `issue_runs`. Here for the same reason the pass above is — before any
    // module is constructed, let alone reads — and it carries the operator's
    // standing dismissals, which is what stops every cleared card coming back.
    adoptFloorCompletions(this.db);
    const ctx: StoreContext = { db: this.db, now: clock };
    this.tasksStore = new TaskStore(ctx);
    this.jobs = new JobStore(ctx);
    this.priority = new PriorityStore(ctx);
    this.findings = new FindingStore(ctx);
    this.plans = new PlanStore(ctx);
    this.verdicts = new IssueVerdictStore(ctx);
    this.scratch = new ScratchStore(ctx);
    this.agents = new AgentStore(ctx);
    this.transcripts = new TranscriptStore(ctx);
    this.escalations = new EscalationStore(ctx);
    this.decisions = new DecisionStore(ctx);
    this.world = new WorldStore(ctx);
    this.errors = new ErrorStore(ctx);
    this.graph = new GraphStore(ctx);
    this.floor = new FloorStore(ctx);
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
  listTasks(): Task[] {
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
  listQueuedJobs(): Job[] {
    return this.jobs.listQueuedJobs();
  }
  markJobDispatched(id: string, taskId: string): void {
    this.jobs.markJobDispatched(id, taskId);
  }
  cancelJob(id: string): Job | null {
    return this.jobs.cancelJob(id);
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
  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.plans.markPartDispatched(id, taskId, branch);
  }
  concludePlanPart(id: string, outcome: Parameters<PlanStore['concludePlanPart']>[1]): PlanPart | null {
    return this.plans.concludePlanPart(id, outcome);
  }
  setPlanStatus(id: string, status: PlanStatus, reason?: string): Plan | null {
    return this.plans.setPlanStatus(id, status, reason);
  }
  setPlanDiscussing(id: string, discussing: boolean): Plan | null {
    return this.plans.setPlanDiscussing(id, discussing);
  }
  setPlanStatusComment(id: string, ref: string): Plan | null {
    return this.plans.setPlanStatusComment(id, ref);
  }
  rollUpPlanStatus(planId: string): Plan | null {
    return this.plans.rollUpPlanStatus(planId);
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
    return this.agents.sumUsageCostSince(sinceIso);
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
  getWorldBaseline(): WorldSnapshot | null {
    return this.world.getWorldBaseline();
  }
  setWorldBaseline(world: WorldSnapshot): void {
    this.world.setWorldBaseline(world);
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
  findWorkItemFilingByJobId(jobId: string): WorkItemFiling | null {
    return this.graph.findWorkItemFilingByJobId(jobId);
  }
  linkWorkItemFiling(jobId: string, ticketRef: string): WorkItemFiling | null {
    return this.graph.linkWorkItemFiling(jobId, ticketRef);
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

  // -- Runs at a goal -------------------------------------------------------

  recordIssueRun(input: Parameters<FloorStore['recordIssueRun']>[0]): void {
    this.floor.recordIssueRun(input);
  }
  dismissIssueRun(originRef: string): boolean {
    return this.floor.dismissIssueRun(originRef);
  }
  listIssueRuns(): IssueRun[] {
    return this.floor.listIssueRuns();
  }
}
