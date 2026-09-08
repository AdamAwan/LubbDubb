import type {
  GoalWatchDeclaration,
  EjectionOutcome,
  FilingTargetProbe,
  InsightsWindow,
  IssueFiled,
  RecoveryVerdict,
  UpgradeAction,
  SnoozeTarget,
  WorkNodeView,
  CaveatAnswerInput,
} from '../types.js';
import type { Place } from './place.js';

// → docs/spec/17-cockpit.md#the-address-bar

export type ValidationAct =
  | { kind: 'result'; result: 'passed' | 'failed'; note: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'waive'; reason: string }
  | { kind: 'reset' }
  | { kind: 'handover'; to: 'fleet' | 'human' };

export type ConfigTab = 'values' | 'raw' | 'ci' | 'prompts' | 'mcp' | 'notifications' | 'theme';

export type ConsolePanel =
  | 'faults'
  | 'launch'
  | 'build'
  | 'pets'
  | 'localRun'
  | 'setup'
  | 'record'
  | 'upnext'
  | 'signals'
  | 'environments'
  | { ask: string }
  | null;

export type ConsoleTab = 'overview' | 'tickets' | 'obstacles' | 'features' | 'insights' | 'pets' | 'config';

export type InsightsView =
  | 'economics'
  | 'allowance'
  | 'reliability'
  | 'throughput'
  | 'causes'
  | 'trend'
  | 'mcp'
  | 'review'
  | 'usage';

/* Whose numbers a reading is over. Every tab answers for this fleet; four of them
   the pool can answer too. → docs/spec/17-cockpit.md#just-me-or-the-pool */
export type InsightsScope = 'mine' | 'pool';

export interface CockpitActions {
  refresh(): Promise<void>;
  pulse(): Promise<void>;
  clearErrors(): Promise<void>;

  select(agentId: string | null): void;

  killAgent(agentId: string): Promise<void>;
  completeAgent(agentId: string): Promise<void>;
  interruptAgent(agentId: string): Promise<void>;
  respondAgent(agentId: string, text: string): Promise<void>;
  resumeAgent(agentId: string): Promise<void>;
  extendStall(agentId: string): Promise<void>;
  ejectAgent(agentId: string, reason: string): Promise<void>;
  settleEjection(id: string, outcome: EjectionOutcome, note?: string): Promise<void>;

  answerEscalation(id: string, text: string): Promise<void>;
  answerQuestions(id: string, answers: (string | null)[]): Promise<void>;
  dismissEscalation(id: string, note?: string): Promise<void>;
  decideProposal(
    id: string,
    verdict: 'accept' | 'reject',
    note?: string,
    acknowledged?: string[],
    answers?: CaveatAnswerInput[],
  ): Promise<void>;
  backOutProposal(id: string, verdict: 'close' | 'hold', note?: string): Promise<void>;
  overruleShortfall(issueNumber: number, proposalId: string, text: string): Promise<void>;
  releaseEnvironmentGate(issueNumber: number, released: boolean, note?: string): Promise<void>;
  decidePermission(id: string, allow: boolean, note?: string): Promise<void>;
  decideRecovery(taskId: string, verdict: RecoveryVerdict): Promise<void>;

  replan(planId: string): Promise<void>;
  ruleWatchProposal(issueNumber: number, checkId: string, accept: boolean): Promise<void>;
  saveWatchCheck(issueNumber: number, check: GoalWatchDeclaration): Promise<string[]>;
  deleteWatchCheck(issueNumber: number, checkId: string): Promise<void>;
  extendWatch(issueNumber: number, environment: string): Promise<void>;
  setValidation(issueNumber: number, checkId: string, act: ValidationAct): Promise<void>;
  viewPlan(planId: string | null): void;
  regroupPlanView(on: boolean): void;
  viewRetro(issueRef: string | null): void;
  hatchEgg(id: string | null): void;
  viewScratchpad(issueRef: string | null): void;
  viewReviewPack(prNumber: number | null): void;
  openReviewIdea(id: string | null): void;
  openConfig(where: { configTab?: ConfigTab; configGroup?: string | null }): void;
  openInsights(where: {
    insightsView?: InsightsView;
    insightsScope?: InsightsScope;
    insightsWindow?: InsightsWindow;
    poolProject?: string | null;
  }): void;
  selectGoal(ref: string | null): void;
  selectPr(prNumber: number | null): void;
  reopenThread(prNumber: number, threadId: string, reopened: boolean): Promise<void>;
  openPanel(panel: ConsolePanel): void;
  applyConfigFix(checkId: string, set: Record<string, unknown>): Promise<void>;
  undoConfigFix(checkId: string): Promise<void>;
  dismissConfigFix(checkId: string): void;
  upgrade(action: UpgradeAction, opts?: { interrupt?: boolean }): Promise<void>;
  checkBuild(): Promise<void>;
  pullProject(): Promise<void>;
  snoozeUpdate(target: SnoozeTarget): Promise<void>;
  startLocalRun(issueNumber: number, ref?: string): Promise<void>;
  stopLocalRun(): Promise<void>;
  messageLocalRun(text: string): Promise<void>;
  refreshLocalRun(): Promise<void>;
  localRunOutput(): Promise<string[]>;
  validateLocally(issueNumber: number, opts?: { swap?: boolean; refresh?: boolean }): Promise<void>;
  cancelLocalValidation(issueNumber: number): Promise<void>;
  openTab(tab: ConsoleTab): void;
  setTicketQuery(
    next: Partial<
      Pick<
        Place,
        | 'ticketWatch'
        | 'ticketTracking'
        | 'ticketState'
        | 'ticketFeature'
        | 'ticketGroup'
        | 'ticketOrder'
        | 'ticketView'
        | 'ticketColumns'
      >
    >,
  ): void;
  setFeatureQuery(next: Partial<Pick<Place, 'featureCard' | 'featureSort' | 'featurePrs'>>): void;
  collapseFeature(issueNumber: number, collapsed: boolean): void;
  openGoalSection(section: string, open: boolean): void;
  reorderUpNext(origins: string[]): Promise<void>;
  setUpNextProfile(origin: string, profile: string | null): Promise<void>;

  openPet(id: string): Promise<void>;
  feedPet(id: string, beats: number): Promise<void>;
  renamePet(id: string, name: string): Promise<void>;
  placePet(id: string, placed: boolean): Promise<void>;
  blendPet(id: string): Promise<void>;

  setObstacleQuery(next: Partial<Pick<Place, 'obstacle' | 'obstacleEnded'>>): void;

  muteObstacle(id: string, muted: boolean): Promise<void>;
  ownObstacle(id: string, ownerRef: string): Promise<void>;
  retireObstacle(id: string): Promise<void>;
  writeDownObstacle(id: string): Promise<void>;

  completeHumanTask(id: string, note?: string): Promise<void>;
  declineHumanTask(id: string, note: string): Promise<void>;
  closeHumanTaskTicket(id: string, note?: string): Promise<void>;
  dismissHumanTask(id: string): Promise<void>;

  setPrWatched(prNumber: number, watched: boolean): Promise<void>;
  setStackLanding(ref: string, landing: boolean): Promise<void>;
  setIssueWatched(issueNumber: number, watched: boolean): Promise<void>;
  setIssueState(issueNumber: number, state: string): Promise<void>;
  setGoalPriority(issueNumber: number, priority: boolean): Promise<void>;
  setIssueProfile(issueNumber: number, profile: string | null): Promise<void>;
  setIssueParent(issueNumber: number, parent: number | null): Promise<void>;
  setIssueAreaPath(issueNumber: number, areaPath: string | null): Promise<void>;
  setPartProfile(planId: string, slug: string, profile: string | null): Promise<void>;
  restartPart(planId: string, slug: string): Promise<void>;
  regroupPlan(
    planId: string,
    groups: { slug: string; atoms: string[]; title?: string; scope?: string }[],
  ): Promise<void>;
  setIssueConclusion(issueNumber: number, verdict: 'done' | 'more_work' | null): Promise<void>;
  setIssueAppraisal(issueNumber: number, verdict: 'workable' | 'unclear' | null): Promise<void>;

  addInstruction(issueNumber: number, text: string): Promise<void>;

  withdrawInstruction(issueNumber: number, id: string): Promise<void>;

  raiseBug(issueNumber: number, summary: string, title?: string): Promise<void>;

  probeFilingTarget(): Promise<FilingTargetProbe>;

  raiseIssue(title: string, body: string, watch: boolean): Promise<IssueFiled>;

  dismissRun(issueNumber: number, note?: string): Promise<void>;

  fetchWorkSubtree(ref: string): Promise<{ nodes: WorkNodeView[] }>;
}
