import type { PlaceKey, UsageArrival, UsageSubject, UsageVerb } from './usage/events.js';

// → docs/spec/03-world-model.md

export type CiStatus = 'passing' | 'failing' | 'pending' | 'unknown';

export interface CiCheck {
  name: string;
  status: Exclude<CiStatus, 'unknown'>;
  blocking?: boolean;
  aliases?: string[];
  advisory?: boolean;
  expired?: boolean;
  evidenceRef?: string;
  requeueRef?: string;
}

export type MergeableState = 'dirty' | 'behind' | 'blocked' | 'clean' | 'unknown';

export type PrState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  ciStatus: CiStatus;
  ciChecks?: CiCheck[];
  ciChecksWithheld?: boolean;
  unresolvedComments: PrComment[];
  reviewThreads?: PrReviewThread[];
  approved?: boolean;
  mergeable?: boolean;
  baseBranch?: string;
  mergeableState?: MergeableState;
  merged?: boolean;
  state?: PrState;
  closedAt?: string;
  mergeCommitSha?: string;
  headSha?: string;
  labels?: string[];
  viewerAssignment?: ViewerAssignment;
  author?: string;
  viewerAuthored?: boolean;
  viewerApproved?: boolean;
  changedFiles?: number;
  url?: string;
}

export type ViewerAssignment = 'assignee' | 'reviewer-required' | 'reviewer-optional';

export interface PrComment {
  id: string;
  author: string;
  body: string;
  handled: boolean;
  replies?: PrThreadMessage[];
}

export type PrThreadState = 'open' | 'answered' | 'resolved' | 'reopened';

export interface PrThreadMessage {
  id: string;
  author: string;
  body: string;
  ours: boolean;
}

export interface PrReviewThread {
  id: string;
  author: string;
  body: string;
  state: PrThreadState;
  replies: PrThreadMessage[];
  path?: string;
  line?: number;
  reopenedAt?: string;
  properties?: Readonly<Record<string, string>>;
}

export type PrReviewVerdict = 'clear' | 'findings';

export interface PrReview {
  prNumber: number;
  headSha: string | null;
  verdict: PrReviewVerdict;
  summary: string;
  findings: string[];
  agentId: string | null;
  reviewedAt: string;
  publishedThread: string | null;
}

export interface PrReviewRoute {
  prNumber: number;
  mode: string;
  skipped: boolean;
  reason: string;
  agentId: string | null;
  decidedAt: string;
}

export type PrReviewRouteInput = Omit<PrReviewRoute, 'decidedAt'>;

export type PrSplitVerdictKind = 'split' | 'coherent';

export interface PrSplitVerdict {
  prNumber: number;
  issueNumber: number;
  verdict: PrSplitVerdictKind;
  concepts: string[];
  reason: string;
  files: number;
  agentId: string | null;
  decidedAt: string;
}

export type PrSplitVerdictInput = Omit<PrSplitVerdict, 'decidedAt'>;

export type PrReviewInput = Omit<PrReview, 'reviewedAt' | 'publishedThread'>;

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  labelsAddedByViewer?: string[];
  state: IssueState;
  workItemState?: string;
  issueType?: string;
  areaPath?: string;
  parent?: IssueRelative | null;
  children?: IssueRelative[];
  siblings?: IssueRelative[];
  dependsOn?: IssueRelative[];
  linkedPrNumber: number | null;
  url?: string;
}

export interface IssueRelative {
  number: number;
  title: string;
  issueType: string;
  workItemState: string;
  state: IssueState;
  body?: string;
  url?: string;
}

export interface WorldSnapshot {
  takenAt: string;
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  staleSources?: string[];
}

export type WorldEventKind =
  | 'pr_opened'
  | 'pr_ci'
  | 'pr_approved'
  | 'pr_mergeable'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_comment'
  | 'issue_opened'
  | 'issue_closed'
  | 'issue_linked';

export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  ref: string | null;
  summary: string;
  createdAt: string;
}

export type WorldEventInput = Omit<WorldEvent, 'id' | 'createdAt'>;

export interface PrReplySent {
  prNumber: number;
  threadId: string;
  commentRef: string;
  sentAt: string;
}

export interface ErrorLogEntry {
  id: string;
  source: 'cycle' | 'provider' | 'agent' | 'server' | 'boot';
  message: string;
  detail: string | null;
  createdAt: string;
}

export type ErrorLogInput = Omit<ErrorLogEntry, 'id' | 'createdAt' | 'detail'> & { detail?: string | null };

type TaskKind = 'code' | 'desk';

type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'interrupted' | 'failed';

export interface TaskSummary {
  id: string;
  kind: TaskKind;
  title: string;
  branch: string | null;
  originRef: string | null;
  originTitle: string | null;
  originSummary: string | null;
  dispatchReason: string | null;
  rule?: string | null;
  ciChecks?: string[] | null;
  mcpServers?: ExtraMcpServer[] | null;
  model?: string | null;
  effort?: string | null;
  profile?: string | null;
  profileSource?: string | null;
  status: TaskStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task extends TaskSummary {
  prompt: string;
}

type JobStatus = 'queued' | 'dispatched' | 'cancelled';

export interface Job {
  id: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  branch: string | null;
  status: JobStatus;
  originRef: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSchedule {
  id: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobAttachmentInput {
  name?: string;
  data: string;
}

export interface JobAttachment {
  id: string;
  targetRef: string;
  index: number;
  label: string;
  mime: string;
  bytes: number;
  path: string;
  createdAt: string;
}

export type WorkNodeKind = 'issue' | 'plan' | 'part' | 'pr' | 'concern' | 'job' | 'assess';

export type WorkNodeProvenance = 'observed' | 'inferred';

export interface WorkNode {
  ref: string;
  kind: WorkNodeKind;
  parentRef: string | null;
  baseRef: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance: WorkNodeProvenance | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type WorkItemFilingStatus = 'filing' | 'filed';

export interface WorkItemFiling {
  targetRef: string;
  status: WorkItemFilingStatus;
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BugFiling {
  jobId: string;
  originRef: string;
  status: WorkItemFilingStatus;
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkNodeObservation {
  ref: string;
  kind: WorkNodeKind;
  parentRef?: string | null;
  baseRef?: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance?: WorkNodeProvenance | null;
}

export interface PriorityOverride {
  origin: string;
  rank: number;
}

export interface ProfileOverride {
  origin: string;
  profile: string;
}

export interface GoalPriority {
  originRef: string;
  since: string;
}

export interface GoalPause {
  originRef: string;
  since: string;
}

export type AgentStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'interrupted' | 'failed' | 'crashed';

export type ReadyingStep = 'picked-up' | 'ci-evidence' | 'slot-handover' | 'authorizing';

export interface ReadyingAction {
  id: string;
  cycleId: string;
  title: string;
  originRef: string | null;
  branch: string | null;
  step: ReadyingStep;
  startedAt: string;
}

export interface Agent {
  id: string;
  taskId: string;
  status: AgentStatus;
  cwd: string;
  pid: number | null;
  waitingReason: string | null;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  note: string | null;
  notedAt: string | null;
  resumedAt: string | null;
  resumeAttempts: number;
}

export interface AgentFlag {
  id: string;
  agentId: string;
  kind: string;
  label: string;
  ref: string;
  createdAt: string;
}

export type AgentFlagInput = Pick<AgentFlag, 'kind' | 'label' | 'ref'>;

export interface AgentFile {
  id: string;
  agentId: string;
  path: string;
  tool: string | null;
  promoted: boolean;
  createdAt: string;
}

export type AgentFileInput = Pick<AgentFile, 'path' | 'tool' | 'promoted'>;

export interface GoalFile {
  path: string;
  originRef: string;
  createdAt: string;
}

export interface GoalNeighbour {
  goalRef: string;
  retroSummary: string;
  sharedPaths: string[];
  lastWriteAt: string;
}

export type RemedyKind = 'ci' | 'review';

export type RemedyCause =
  | 'flake'
  | 'environment'
  | 'inherited'
  | 'stale_test'
  | 'missed_gate'
  | 'contract_drift'
  | 'missed_requirement'
  | 'convention'
  | 'approach'
  | 'scope'
  | 'docs'
  | 'clarity'
  | 'defect'
  | 'other';

export type RemedyGuard = 'local_check' | 'documented' | 'undocumented' | 'unpreventable';

export interface Remedy {
  id: string;
  kind: RemedyKind;
  originRef: string;
  prNumber: number;
  cause: RemedyCause;
  guard: RemedyGuard;
  summary: string;
  checks: string[];
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export type RemedyInput = Omit<Remedy, 'id' | 'createdAt' | 'updatedAt'>;

export type HumanTaskStatus = 'open' | 'done' | 'declined';

export type HumanTaskKind = 'ask' | 'close_out' | 'burn' | 'validate' | 'supply' | 'watch';

export interface HumanTask {
  id: string;
  title: string;
  detail: string | null;
  originRef: string | null;
  partId: string | null;
  kind: HumanTaskKind;
  agentId: string | null;
  taskId: string | null;
  status: HumanTaskStatus;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

export type HumanTaskInput = Pick<HumanTask, 'title' | 'detail'>;

export type IssueConclusionVerdict = 'done' | 'more_work';

export type ConclusionAuthor = 'agent' | 'assessor' | 'operator';

export interface IssueConclusion {
  originRef: string;
  verdict: IssueConclusionVerdict;
  note: string;
  by: ConclusionAuthor;
  agentId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueInstruction {
  id: string;
  originRef: string;
  text: string;
  createdAt: string;
  settledAt: string | null;
}

export type IssueRunOutcome = 'judged' | 'abandoned';

export interface TrackerItem {
  number: number;
  title: string;
  labels: string[];
  state: IssueState;
  workItemState: string | null;
  url: string | null;
  createdAt: string;
  changedAt: string;
}

export interface IssueRun {
  originRef: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  linkedPrNumber: number | null;
  workItemState: string | null;
  startedAt: string;
  completedAt: string | null;
  outcome: IssueRunOutcome | null;
  dismissedAt: string | null;
  dismissNote: string | null;
  updatedAt: string;
}

export type DeliveryAuthor = 'assessor' | 'planner' | 'operator';

export interface IssueDelivery {
  originRef: string;
  summary: string;
  detail: string | null;
  by: DeliveryAuthor;
  agentId: string | null;
  taskId: string | null;
  decidedAt: string;
  updatedAt: string;
}

export type GoalAppraisalVerdict = 'workable' | 'unclear';

export type AppraisalAuthor = 'appraiser' | 'operator';

export interface IssueAppraisal {
  originRef: string;
  verdict: GoalAppraisalVerdict;
  summary: string;
  missing: string[];
  goalRef: string;
  by: AppraisalAuthor;
  proposedProfile: string | null;
  profileAnsweredAt: string | null;
  proposedParent: number | null;
  parentSettledAt: string | null;
  proposedAreaPath: string | null;
  areaPathSettledAt: string | null;
  agentId: string | null;
  taskId: string | null;
  commentRef: string | null;
  decidedAt: string;
  updatedAt: string;
}

export interface ScratchEntry {
  id: string;
  padRef: string;
  authorOriginRef: string;
  agentId: string;
  taskId: string;
  topic: string | null;
  note: string;
  decision: PadDecision | null;
  createdAt: string;
}

export interface PadDecision {
  chose: string;
  because: string;
  rejected: { alternative: string; because: string }[];
  paths: string[];
}

export interface ScratchPadSummary {
  padRef: string;
  entries: number;
  updatedAt: string;
}

export interface Retrospective {
  originRef: string;
  summary: string;
  document: string;
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewPack {
  schema: number;
  prNumber: number;
  headSha: string;
  headline: string;
  summary: string;
  estimatedMinutes: number;
  order: string[];
  ideas: ReviewIdea[];
  witnessed: boolean;
  fake: string;
}

export interface ReviewIdea {
  id: string;
  claim: string;
  title: string;
  atom: string | null;
  cue: string | null;
  anchors: ReviewAnchor[];
  claims: ReviewClaim[];
  coverage?: string[];
  attention: ReviewAttention | null;
}

export type ReviewAttention = 'read' | 'decide' | 'skim' | 'split';

export interface ReviewAnchor {
  kind: 'hunk' | 'region';
  range: ReviewRange;
  code: string[];
  gist: string;
  note: ReviewNote | null;
  caption: string | null;
  mark: ReviewAnchorMark | null;
}

export interface ReviewRange {
  path: string;
  start: number;
  end: number;
}

export type ReviewAnchorMark = 'key' | 'false' | 'disputed';

export type ReviewNote = { by: 'witness'; text: string; entryId: string; at: string } | { by: 'author'; text: string };

export interface ReviewClaim {
  text: string;
  provenance: ReviewProvenance;
  verdict: ReviewVerdict | null;
  evidence: string | null;
  finding: ReviewFinding | null;
}

export type ReviewProvenance =
  | { kind: 'witnessed'; entryId: string }
  | { kind: 'inferred' }
  | { kind: 'disputed'; entryId: string };

export type ReviewVerdict = 'true' | 'false' | 'cant_tell';

export interface ReviewFinding {
  headline: string;
  body: string;
  step: number | null;
  counter: { range: ReviewRange; code: string[]; caption: string } | null;
}

export interface ReviewPackRecord {
  pack: ReviewPack;
  writtenAt: string;
}

export interface ReviewPackShare {
  prNumber: number;
  headSha: string;
  requestedAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
  refusal: string | null;
}

export interface ReviewMark {
  prNumber: number;
  hunk: ReviewRange;
  headSha: string;
  attention: ReviewAttention | null;
  read: boolean;
  seen: boolean;
  markedAt: string;
}

export interface FeatureSummary {
  originRef: string;
  standing: string;
  usable: string | null;
  blocked: string | null;
  remaining: string | null;
  standingKey: string;
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureSequenceEdge {
  issue: number;
  dependsOn: number;
  source: 'link' | 'inferred' | 'operator';
  reason: string | null;
}

export interface FeatureSequence {
  originRef: string;
  status: 'proposed' | 'accepted' | 'declined';
  reason: string;
  unsure: string | null;
  standingKey: string;
  edges: FeatureSequenceEdge[];
  members: number[] | null;
  answeredBy: string | null;
  answeredAt: string | null;
  agentId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ShortfallCause = 'plan' | 'part' | 'goal';

export type ShortfallAuthor = 'assessor' | 'operator';

export interface IssueShortfall {
  originRef: string;
  cause: ShortfallCause | null;
  partSlug: string | null;
  summary: string;
  detail: string | null;
  by: ShortfallAuthor;
  agentId: string | null;
  taskId: string | null;
  decidedAt: string;
  updatedAt: string;
}

export type PlanStatus = 'planning' | 'awaiting_approval' | 'active' | 'complete' | 'abandoned';

export interface Plan {
  id: string;
  originRef: string;
  title: string;
  status: PlanStatus;
  diagnosis: string | null;
  approach: string | null;
  reason: string | null;
  risks: string | null;
  outOfScope: string | null;
  alternatives: string | null;
  openQuestions: string | null;
  verification: string | null;
  evidence: PlanEvidence[];
  document: string | null;
  statusCommentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanCaveat {
  id: string;
  label: string;
  detail: string | null;
}

export interface PlanCaveatAnswer {
  id: string;
  planId: string;
  caveatId: string;
  label: string;
  answer: string;
  at: string;
}

export interface PlanNarrative {
  reason: string | null;
  diagnosis: string | null;
  approach: string | null;
  risks: string | null;
  outOfScope: string | null;
  alternatives: string | null;
  openQuestions: string | null;
  verification: string | null;
  document: string | null;
  evidence: PlanEvidence[];
}

export interface PlanRevision {
  id: string;
  planId: string;
  seq: number;
  narrative: PlanNarrative;
  parts: PlanPartInput[];
  at: string;
}

export type PlanAmendmentAuthor = 'agent' | 'operator';

export type PlanAmendmentStatus = 'pending' | 'applied' | 'declined' | 'superseded';

export interface PlanAmendment {
  id: string;
  planId: string;
  originRef: string;
  document: string;
  note: string;
  author: PlanAmendmentAuthor;
  authorRef: string | null;
  status: PlanAmendmentStatus;
  resolution: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface PlanEvidence {
  path: string;
  line: number | null;
  note: string | null;
}

export type ValidationCheckState = 'unrun' | 'passed' | 'failed' | 'waived' | 'deferred';

export type ValidationCheckActor = 'human' | 'fleet';

export type ValidationCheckResultBy = 'operator' | 'agent' | 'desktop';

export interface ValidationCheck {
  originRef: string;
  id: string;
  letter: string;
  seq: number;
  title: string;
  do: string;
  expect: string;
  uses: string[];
  covers: string[];
  fleetCandidate: boolean;
  candidateWhy: string | null;
  actor: ValidationCheckActor;
  handbackNote: string | null;
  state: ValidationCheckState;
  resultNote: string | null;
  resultBy: ValidationCheckResultBy | null;
  resultAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  deferUntil: string | null;
  supersededReason: string | null;
  revision: ValidationRevision | null;
  amendedAt: string | null;
  amendNote: string | null;
  /**
   * The selector a runner offers for this check, compared against the pre-flight's own listing. Null
   * is *no area declared* — a check a person carries out, exactly as every check is today.
   */
  area: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationRevision {
  title: string;
  do: string;
  expect: string;
  state: ValidationCheckState | null;
  note: string | null;
}

export interface ValidationCheckInput {
  id: string;
  seq: number;
  title: string;
  do: string;
  expect: string;
  uses: string[];
  covers: string[];
  fleetCandidate: boolean;
  candidateWhy: string | null;
}

export type ValidationCheckAmendment = Omit<ValidationCheckInput, 'seq'>;

export interface ValidationAmendment {
  checks: ValidationCheckAmendment[];
  withdraw: { id: string; reason: string }[];
  resources: ValidationResourceInput[];
  note: string;
}

export interface ValidationAmendResult {
  added: ValidationCheck[];
  reworded: ValidationCheck[];
  unchanged: string[];
  withdrawn: string[];
  unknown: string[];
}

export interface ValidationResourceInput {
  name: string;
  kind: ValidationResourceKind | null;
  note: string | null;
  provided: boolean;
}

export type ValidationResourceKind = 'fixture' | 'access' | 'reference' | 'data';

export interface ValidationResource {
  originRef: string;
  name: string;
  kind: ValidationResourceKind | null;
  note: string | null;
  provided: boolean;
  humanTaskId: string | null;
}

export interface ValidationVerdict {
  state: 'clear' | 'flagged';
  total: number;
  passed: number;
  failed: number;
  unrun: number;
  deferred: number;
  waived: number;
}

export type PartSize = 's' | 'm' | 'l';

type PlanPartStatus = 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'concluded' | 'blocked' | 'retired';

export type PartOutcomeKind = 'code' | 'report' | 'determination' | 'human';

export interface PlanPart {
  id: string;
  planId: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  touches: string[];
  atoms?: string[];
  rationale: string | null;
  acceptance: string | null;
  acceptanceMet: string[];
  size: PartSize | null;
  expectedKind: PartOutcomeKind | null;
  profile?: string | null;
  coverage?: string | null;
  outcomeKind: PartOutcomeKind | null;
  outcomeRef: string | null;
  outcomeSummary: string | null;
  dependsOn: string[];
  branch: string | null;
  prNumber: number | null;
  status: PlanPartStatus;
  blockedReason: string | null;
  blockedBy: PlanPartBlocker | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PlanPartBlocker = 'collision' | 'declined';

export interface PlanAtomRejection {
  route: string;
  because: string;
}

export interface PlanAtom {
  id: string;
  planId: string;
  slug: string;
  seq: number;
  title: string;
  intent: string;
  touches: string[];
  acceptance: string | null;
  dependsOn: string[];
  rejected: PlanAtomRejection[];
}

export type PlanAtomInput = Omit<PlanAtom, 'id' | 'planId'>;

export type PlanPartInput = Pick<
  PlanPart,
  | 'slug'
  | 'seq'
  | 'title'
  | 'scope'
  | 'touches'
  | 'atoms'
  | 'dependsOn'
  | 'rationale'
  | 'acceptance'
  | 'size'
  | 'expectedKind'
  | 'profile'
  | 'coverage'
>;

export interface AgentUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
}

export interface UsageEvent {
  agentId: string;
  costUsd: number;
  at: string;
}

export interface IssueSpend {
  originRef: string;
  issueNumber: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  agents: number;
  localRuns: number;
}

export interface StallPark {
  agentId: string;
  expiresAt: string;
}

export interface RateLimitWindow {
  usedPercentage: number;
  resetsAt: string | null;
}

export interface AccountRateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  capturedAt: string;
}

export type EscalationType = 'approve_change' | 'answer_question' | 'resolve_ambiguity' | 'review_reply';

export interface AgentAsk {
  question: string;
  kind?: string;
  options?: string[];
  detail?: string;
  questions?: AgentAskQuestion[];
}

export interface AgentAskQuestion {
  question: string;
  detail?: string;
  options?: string[];
}

type EscalationStatus = 'open' | 'answered' | 'dismissed';

export interface EscalationContext {
  taskTitle?: string;
  originRef?: string | null;
  recentOutput?: string;
  questions?: AgentAskQuestion[];
  prNumber?: number;
  commentId?: string | null;
  draft?: string;
  method?: string;
  autoMergeFailed?: boolean;
  planId?: string;
  issueNumber?: number;
  permission?: PermissionRequest;
  [key: string]: unknown;
}

interface PermissionRequest {
  toolName: string;
  summary: string;
}

export interface EscalationSpan {
  createdAt: string;
  answeredAt: string | null;
  originRef: string | null;
  prNumber: number | null;
  open: boolean;
}

export interface Escalation {
  id: string;
  type: EscalationType;
  status: EscalationStatus;
  prompt: string;
  context: EscalationContext;
  agentId: string | null;
  taskId: string | null;
  response: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export type ProposalKind = 'reply_draft' | 'merge' | 'plan' | 'shortfall' | 'plan_amendment';

type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  ref: string;
  status: ProposalStatus;
  action: Action;
  note: string | null;
  decidedBy: 'human' | 'auto_send' | 'stack_landing' | null;
  decidedAt: string | null;
  escalationId: string | null;
  createdAt: string;
}

export type StackLandingStatus = 'standing' | 'landed' | 'stopped' | 'revoked';

export interface StackLanding {
  id: string;
  ref: string;
  rungs: number[];
  status: StackLandingStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

type ActionType =
  | 'dispatch_code_agent'
  | 'dispatch_desk_agent'
  | 'escalate_to_human'
  | 'respond_to_agent'
  | 'reply_on_pr'
  | 'merge_pr'
  | 'propose_plan'
  | 'propose_plan_amendment'
  | 'propose_shortfall'
  | 'update_pr_branch'
  | 'requeue_ci_check'
  | 'set_work_item_state'
  | 'no_op';

export interface Action {
  type: ActionType;
  reason: string;
  rule?: string | null;
  admission?: string | null;
  [key: string]: unknown;
}

export type DecisionOutcome = 'executed' | 'deferred' | 'rejected' | 'skipped';

export interface Decision {
  id: string;
  cycleId: string;
  action: Action;
  outcome: DecisionOutcome;
  detail: string;
  rule: string | null;
  admission: string | null;
  createdAt: string;
}

// → docs/spec/35-ejection.md
export type EjectionOutcome = 'handed_back' | 'requeued' | 'delivered' | 'expired';

export interface Ejection {
  id: string;
  originRef: string;
  branch: string | null;
  worktreePath: string | null;
  agentId: string;
  taskId: string;
  sessionId: string | null;
  reason: string;
  ejectedAt: string;
  lastSeenAt: string | null;
  lastNote: string | null;
  settledAt: string | null;
  outcome: EjectionOutcome | null;
  settleNote: string | null;
}

export type EjectionInput = Omit<
  Ejection,
  'id' | 'ejectedAt' | 'lastSeenAt' | 'lastNote' | 'settledAt' | 'outcome' | 'settleNote'
>;

export type UpgradeState = 'idle' | 'draining' | 'ready' | 'applying';

export interface UpgradeIntent {
  state: UpgradeState;
  targetSha: string | null;
  requestedAt: string | null;
  pausedByDrain: boolean;
}

export type PetSpecies =
  | 'pip'
  | 'mote'
  | 'nib'
  | 'tuft'
  | 'beck'
  | 'berth'
  | 'stoke'
  | 'speck'
  | 'patch'
  | 'warden'
  | 'cinder'
  | 'nocturne'
  | 'chit'
  | 'vellum'
  | 'drift'
  | 'bramble'
  | 'lander'
  | 'quill'
  | 'cairn'
  | 'ingot'
  | 'clarion'
  | 'covenant'
  | 'oracle'
  | 'keystone'
  | 'forge'
  | 'lodestone'
  | 'ouroboros';

export type PetRarity = 'common' | 'uncommon' | 'rare' | 'mythic';

export type PetStage = 'hatchling' | 'juvenile' | 'adult';

export type PetActionKind = 'escalation' | 'human-task' | 'plan' | 'landing' | 'job' | 'claim' | 'finding' | 'upgrade';

export interface Pet {
  id: string;
  species: PetSpecies;
  seed: string;
  name: string | null;
  fed: number;
  originKind: PetActionKind;
  originRef: string;
  hatchedAt: string;
  openedAt: string | null;
  placed: boolean;
  dissolvedAt: string | null;
  builtSha: string | null;
  builtClean: boolean;
  chain: string | null;
}

export interface PetFlaw {
  code: 'unrecorded' | 'misdated' | 'impossible' | 'overfed' | 'broken-chain' | 'unearned';
  note: string;
}

export type PetProvenance = 'official' | 'modified' | 'unknown';

export interface PetAction {
  kind: PetActionKind;
  ref: string;
  at: string;
  petId: string | null;
}

export interface PetWallet {
  earned: number;
  spent: number;
  balance: number;
}

export interface PetReset {
  id: string;
  at: string;
  cleared: number;
}

export interface GoalLanding {
  prNumber: number;
  goalRef: string;
  sha: string;
  recordedAt: string;
  onIntegration: boolean | null;
}

export type EnvironmentReachStatus = 'reached' | 'absent' | 'unknown';

export interface EnvironmentReading {
  sha: string;
  environment: string;
  status: EnvironmentReachStatus;
  detail: string | null;
  observedAt: string;
}

export type EnvironmentHealthState = 'healthy' | 'unhealthy' | 'unknown';

export type EnvironmentHealthTier = 'red' | 'orange';

export interface EnvironmentHealthReading {
  environment: string;
  state: EnvironmentHealthState;
  tier: EnvironmentHealthTier | null;
  reasons: string[];
  detail: string | null;
  observedAt: string;
  changedAt: string;
}

export type GoalReachStatus = 'reached' | 'partial' | 'absent' | 'unknown';

export interface GoalEnvironmentReach {
  environment: string;
  status: GoalReachStatus;
  landed: number;
  total: number;
  unplaced: number;
  at: string | null;
  opens: EnvironmentGate[];
}

export type EnvironmentGate = 'validate' | 'close_out';

export interface GoalArrival {
  goalRef: string;
  environment: string;
  arrivedAt: string;
  announcedAt: string | null;
  watchedAt: string | null;
  sheetedAt: string | null;
}

export type GoalWatchKind = 'signal' | 'measure';

export type WatchReadingVerdict = 'fires' | 'zero' | 'unknown';

export type GoalWatchDeclaration =
  | {
      kind: 'signal';
      id: string;
      title: string;
      query: string;
      presence: string;
      tolerate: number;
      why?: string;
    }
  | {
      kind: 'measure';
      id: string;
      title: string;
      query: string;
      expect: { under?: number; over?: number; noWorseThan?: 'baseline' };
      unit?: string;
      why?: string;
    };

export interface GoalWatchInput {
  id: string;
  seq: number;
  kind: GoalWatchKind;
  title: string;
  query: string;
  presence: string | null;
  tolerate: number;
  expectUnder: number | null;
  expectOver: number | null;
  expectBaseline: boolean;
  unit: string | null;
  why: string | null;
}

export interface GoalWatch extends GoalWatchInput {
  originRef: string;
  dryRunEnvironment: string | null;
  dryRunAt: string | null;
  dryRunVerdict: WatchReadingVerdict | null;
  dryRunPresence: WatchReadingVerdict | null;
  dryRunRows: number | null;
  dryRunDetail: string | null;
  baselineValue: number | null;
  baselineAt: string | null;
  live: boolean;
  proposal: GoalWatchProposal | null;
  authored: GoalWatchAuthor;
}

type GoalWatchAuthor = 'plan' | 'operator';

export interface GoalWatchProposal {
  at: string;
  note: string;
  declaration: GoalWatchInput;
}

export type StateQueryAuthor = 'plan' | 'agent' | 'operator';

export interface StateQueryInput {
  id: string;
  seq: number;
  title: string;
  query: string;
  presence: string;
  why: string | null;
}

export interface StateQuery extends StateQueryInput {
  originRef: string;
  digest: string;
  authored: StateQueryAuthor;
  dryRunEnvironment: string | null;
  dryRunAt: string | null;
  dryRunVerdict: WatchReadingVerdict | null;
  dryRunPresence: WatchReadingVerdict | null;
  dryRunRows: number | null;
  dryRunDetail: string | null;
  dryRunSample: string | null;
}

export type RemoteRowKind = 'check' | 'state' | 'signal' | 'measure';

export type RemoteRowOutcome = 'passed' | 'failed' | 'blocked';

/** One goal's checks, watches and state queries, assembled against one environment. */
export interface RemoteSheet {
  goalRef: string;
  environment: string;
  assembledAt: string;
}

export interface RemoteSheetRow {
  goalRef: string;
  environment: string;
  rowId: string;
  kind: RemoteRowKind;
  seq: number;
  title: string;
  sourceId: string;
  selected: boolean;
  /** Non-null means no reading was taken, and this is what an operator is told instead. */
  blockedReason: string | null;
  awaitingApproval: boolean;
  /**
   * How many tests the pre-flight's listing attributes to this row's area. Null on a row the
   * pre-flight had nothing to ask about, and never derived from a report.
   */
  matched: number | null;
}

/**
 * A point-in-time answer on one sheet row. Never a `WorldEvent` and never a `watch_readings` row —
 * see 36-remote-validation.md.
 */
export interface RemoteReading {
  goalRef: string;
  environment: string;
  rowId: string;
  runId: string | null;
  outcome: RemoteRowOutcome;
  rows: number | null;
  value: number | null;
  detail: string | null;
  /** The commits the run this reading came through straddled. Both null on one taken at assembly. */
  startedSha: string | null;
  endedSha: string | null;
  readAt: string;
}

export type RemoteRunStatus = 'running' | 'ended' | 'abandoned';

/**
 * One press. Kept after it ends, `local_validations`' rule: a run abandoned because the environment
 * went back past the goal's work is the case an operator actually hits, and its reason has to be
 * readable afterwards.
 *
 * `tenant` is the *key* the lock is enforced on and never a `tenantEnv`'s value — see
 * 36-remote-validation.md#tenants.
 */
export interface RemoteRun {
  id: string;
  goalRef: string;
  environment: string;
  tenant: string;
  status: RemoteRunStatus;
  startedSha: string | null;
  endedSha: string | null;
  startedAt: string;
  endedAt: string | null;
  note: string | null;
}

/** When an environment's tenant was last provisioned and last reseeded. */
export interface RemoteTenant {
  environment: string;
  tenant: string;
  ensuredAt: string | null;
  reseededAt: string | null;
}

/**
 * What the lock, the sheet and the gate know about an environment's tenant. It carries the name a
 * surface may draw and **never** a `tenantEnv`'s value, which goes into the spawn env and nowhere
 * else. `stale` is a qualifier on a reading and never a fourth outcome.
 */
export interface TenantStanding {
  /** The lock's key, and what a surface draws. Null where no shape supplied one. */
  tenant: string | null;
  reseededAt: string | null;
  ageMs: number | null;
  freshnessMs: number | null;
  stale: boolean;
  /** Why there is no tenant, naming the command or the variable that would provide one. */
  blockedReason: string | null;
}

/** One operator's "I have read this, and it is safe *here*" — see 36-remote-validation.md. */
export interface StateQueryApproval {
  digest: string;
  environment: string;
  originRef: string;
  queryId: string;
  approvedAt: string;
  rows: number | null;
  detail: string | null;
}

export interface WatchWindow {
  goalRef: string;
  environment: string;
  openedAt: string;
  settlesAt: string;
  settledAt: string | null;
  extendedAt: string | null;
}

export type WatchCheckVerdict = 'clean' | 'regressed' | 'unknown';

export interface WatchReading {
  goalRef: string;
  environment: string;
  checkId: string;
  readAt: string;
  verdict: WatchCheckVerdict;
  rows: number | null;
  value: number | null;
  detail: string | null;
}

export interface EnvironmentGateRelease {
  goalRef: string;
  note: string;
  releasedAt: string;
}

export type LocalRunStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface LocalRun {
  id: string;
  originRef: string;
  ref: string;
  dir: string;
  commit: string | null;
  pid: number | null;
  status: LocalRunStatus;
  url: string | null;
  note: string | null;
  startedAt: string;
  endedAt: string | null;
  interruptedAt: string | null;
  lastSeenAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
}

export type LocalRunUsageDelta = AgentUsage;

export type LocalRunTurn = 'start' | 'stop' | 'refresh' | 'message';

export interface LocalRunPorts {
  checkedAt: string;
  declared: { url: string; host: string; port: number; answering: boolean } | null;
  listening: number[] | null;
}

export interface LocalRunFreshness {
  checkedAt: string;
  behindTip: number | null;
  base: { ref: string; behind: number | null } | null;
}

export interface LocalRunReadings {
  ports: LocalRunPorts | null;
  freshness: LocalRunFreshness | null;
}

export type LocalValidationStatus = 'pending' | 'dispatched' | 'passed' | 'failed' | 'blocked' | 'abandoned';

export interface LocalValidationFinding {
  title: string;
  detail: string;
  severity: 'blocker' | 'defect' | 'nit';
  url: string | null;
  screenshot: string | null;
}

export interface LocalValidation {
  id: string;
  originRef: string;
  runId: string;
  ref: string;
  commit: string | null;
  status: LocalValidationStatus;
  requestedAt: string;
  dispatchedAt: string | null;
  endedAt: string | null;
  taskId: string | null;
  fixTaskId: string | null;
  plan: string | null;
  summary: string | null;
  findings: LocalValidationFinding[];
  visited: string[];
  screenshots: string[];
  note: string | null;
}

export interface ExtraMcpServer {
  key: string;
  command: string;
  args: string[];
}

export interface CostDelta {
  costUsd: number;
  at: string;
}

export type McpChannel = 'fleet' | 'desktop';

export interface McpCall {
  id: string;
  channel: McpChannel;
  tool: string;
  agentId: string | null;
  taskId: string | null;
  originRef: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  args: string | null;
  argsBytes: number;
  argsDropped: boolean;
  createdAt: string;
}

export interface McpCallInput {
  channel: McpChannel;
  tool: string;
  agentId: string | null;
  taskId: string | null;
  originRef: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  args: Record<string, unknown>;
}

export interface SurfaceReach {
  subject: UsageSubject;
  verb: UsageVerb;
  place: PlaceKey;
  at: string;
  arrival: UsageArrival;
}

export type SurfaceReachInput = Omit<SurfaceReach, 'at'>;

type PoolDocumentKind = PoolClockKind | 'pack';

export type PoolClockKind = 'digest';

interface PoolEnvelope {
  pool: number;
  kind: PoolDocumentKind;
  fleetId: string;
  project: string;
  publishedAt: string;
  harnessVersion: string;
}

export interface PoolDigestRow {
  day: string;
  key: string;
  count: number;
  costUsd: number | null;
  partial: boolean;
}

export interface PoolDigestDocument extends PoolEnvelope {
  kind: 'digest';
  byPhase: PoolDigestRow[];
  byCause: PoolDigestRow[];
  byCheck: PoolDigestRow[];
  unaccounted: PoolDigestRow[];
  unmeasured: PoolDigestRow[];
  byUsage: PoolDigestRow[];
  byThroughput: PoolDigestRow[];
  /* Which of `byThroughput`'s measures this fleet's world was scoped tightly enough
     for the pool to sum. Published by the fleet that knows, never guessed by a
     reader. → docs/spec/28-cross-fleet-pool.md */
  poolableThroughput: string[];
  byFault: PoolDigestRow[];
}

export interface PoolPackDocument extends PoolEnvelope {
  kind: 'pack';
  prNumber: number;
  headSha: string;
  writtenAt: string;
  pack: ReviewPack;
}

export type PoolClockDocument = PoolDigestDocument;

export type PoolDocument = PoolClockDocument | PoolPackDocument;

export interface PoolFleetReading {
  fleetId: string;
  project: string | null;
  digestAt: string | null;
  ahead: boolean;
  seenAt: string;
  stale: boolean;
}

export interface PoolPublication {
  kind: PoolClockKind;
  contentHash: string | null;
  publishedAt: string | null;
  dirty: boolean;
  checkedAt: string | null;
}

export type ObstacleKeyKind = 'check' | 'test' | 'path' | 'signature' | 'cmd';

export type ObstacleState = 'sighted' | 'standing' | 'owned' | 'resolved' | 'dormant' | 'muted';

export type ObstacleKind = 'obstacle' | 'note';

export interface ObstacleKey {
  id: string;
  obstacleId: string;
  kind: ObstacleKeyKind;
  value: string;
  binds: boolean;
  confirmations: number;
  createdAt: string;
}

export interface ObstacleSighting {
  id: string;
  obstacleId: string;
  agentId: string | null;
  taskId: string | null;
  goalRef: string | null;
  sessionId: string | null;
  transition: string | null;
  words: string;
  whyNotMine: string | null;
  matchedBy: string;
  createdAt: string;
}

export interface ObstacleStanding {
  obstacle: Obstacle;
  keys: ObstacleKey[];
  voices: number;
  goalRefs: string[];
  words: string[];
}

export interface ObstacleBlock {
  originRef: string;
  obstacleId: string;
  agentId: string | null;
  taskId: string | null;
  note: string;
  createdAt: string;
}

export interface Obstacle {
  id: string;
  what: string;
  kind: ObstacleKind;
  state: ObstacleState;
  ownerRef: string | null;
  until: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  endedBy: ObstacleEnding | null;
}

export type ObstacleEnding = 'condition' | 'landing' | 'expiry' | 'decay' | 'written-down' | 'retired';

export interface ObstacleCondition {
  id: string;
  obstacleId: string;
  kind: 'check-green';
  checkName: string;
  branch: string;
  metAt: string | null;
  createdAt: string;
}

export interface ObstacleWriteUp {
  obstacleId: string;
  jobId: string;
  prRef: string | null;
  outcome: ObstacleWriteUpOutcome | null;
  createdAt: string;
  settledAt: string | null;
}

export type ObstacleWriteUpOutcome = 'landed' | 'abandoned';

export interface ObstacleDeskReading {
  obstacleId: string;
  readAt: string;
  takenAt: string;
  purpose: ObstaclePurpose | null;
  title: string | null;
  body: string | null;
}

export type ObstaclePurpose = 'ticket' | 'docs';
