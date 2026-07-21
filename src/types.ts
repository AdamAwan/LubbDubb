/**
 * Shared domain types for the LubbDubb harness.
 *
 * These are the vocabulary the whole system speaks: the world snapshot the
 * connector produces, the tasks/agents/escalations the harness tracks, and the
 * bounded action plan the dispatcher emits.
 */

// ---------------------------------------------------------------------------
// World snapshot (produced by a Connector)
// ---------------------------------------------------------------------------

export type CiStatus = 'passing' | 'failing' | 'pending' | 'unknown';

/** GitHub's `mergeable_state`, normalised to the values the harness reacts to. */
export type MergeableState = 'dirty' | 'behind' | 'blocked' | 'clean' | 'unknown';

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  ciStatus: CiStatus;
  /** Unresolved review comments waiting on the author. */
  unresolvedComments: PrComment[];
  /**
   * Merge-readiness signals, tracked by the PR-monitoring connector so the
   * harness can drive a PR the last mile to merged. All absent = unknown/false.
   */
  approved?: boolean;
  /** No conflicts / branch behind — GitHub reports it mergeable. */
  mergeable?: boolean;
  /** The base branch this PR targets (e.g. "main") — needed to pull the base in. */
  baseBranch?: string;
  /**
   * GitHub's `mergeable_state`, normalised. Distinguishes a real conflict
   * ('dirty') from merely-behind-base ('behind', a safe update) and required
   * checks/reviews not met ('blocked'). Absent/unrecognised => 'unknown'.
   */
  mergeableState?: MergeableState;
  /** Already merged; once true the harness stops acting on it. */
  merged?: boolean;
  url?: string;
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  /** True once the harness has handled (drafted a reply / fixed) this comment. */
  handled: boolean;
}

export type IssueState = 'open' | 'closed';

/**
 * A tracker issue (GitHub Issues in v1) the harness may pick up and resolve into
 * a pull request. Distinct from a {@link Story}: an issue is a bug/feature report
 * that becomes a PR, not a backlog item to groom.
 */
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: IssueState;
  /** The PR opened to resolve this issue, once one exists. Null until linked. */
  linkedPrNumber: number | null;
  url?: string;
}

export type StoryState = 'ready' | 'in_progress' | 'blocked' | 'done';

export interface Story {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  /** WAF pillars documented on the work item (Azure DevOps convention). */
  wafPillars: string[];
  state: StoryState;
  /** Higher = more important. */
  priority: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string; // ISO
  /** Docs/links the user was asked to read before the meeting. */
  prepDocs: string[];
  prepDone: boolean;
}

/** The full picture of the outside world at one instant. */
export interface WorldSnapshot {
  takenAt: string; // ISO
  pullRequests: PullRequest[];
  issues: Issue[];
  stories: Story[];
  calendar: CalendarEvent[];
}

// ---------------------------------------------------------------------------
// Harness-internal state
// ---------------------------------------------------------------------------

export type TaskKind = 'code' | 'desk';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting' // agent parked, needs human/whitelisted input
  | 'done'
  | 'interrupted' // agent died (e.g. server restart)
  | 'failed';

export interface Task {
  id: string;
  kind: TaskKind;
  /** Human-readable summary of what this task is for. */
  title: string;
  /** The prompt handed to the agent. */
  prompt: string;
  /** For code tasks: the git branch whose worktree we operate in. */
  branch: string | null;
  /** Free-form link back to the world object that spawned this (e.g. "pr:42"). */
  originRef: string | null;
  status: TaskStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'interrupted' | 'failed';

export interface Agent {
  id: string;
  taskId: string;
  status: AgentStatus;
  cwd: string;
  /** OS pid while alive; null once dead. */
  pid: number | null;
  /** Why the agent is waiting, when status === 'waiting'. */
  waitingReason: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type EscalationType = 'approve_change' | 'answer_question' | 'resolve_ambiguity' | 'review_reply';

export type EscalationStatus = 'open' | 'answered' | 'dismissed';

export interface Escalation {
  id: string;
  type: EscalationType;
  status: EscalationStatus;
  /** What the human needs to weigh in on. */
  prompt: string;
  /** Task/agent/PR this concerns. */
  context: Record<string, unknown>;
  /** If tied to a live parked agent, its answer is typed into that session. */
  agentId: string | null;
  taskId: string | null;
  response: string | null;
  createdAt: string;
  answeredAt: string | null;
}

// ---------------------------------------------------------------------------
// Dispatcher output — the bounded action vocabulary
// ---------------------------------------------------------------------------

export type ActionType =
  | 'dispatch_code_agent'
  | 'dispatch_desk_agent'
  | 'escalate_to_human'
  | 'respond_to_agent'
  | 'reply_on_pr'
  | 'merge_pr'
  | 'no_op';

/** One decision from the dispatcher. Every action carries a reason for the audit log. */
export interface Action {
  type: ActionType;
  reason: string;
  /** Payload shape depends on `type`; validated by zod at the boundary. */
  [key: string]: unknown;
}

export type DecisionOutcome = 'executed' | 'deferred' | 'rejected' | 'skipped';

export interface Decision {
  id: string;
  cycleId: string;
  action: Action;
  outcome: DecisionOutcome;
  detail: string;
  createdAt: string;
}
