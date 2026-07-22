// Mirrors the server's domain types (kept deliberately small — just what the UI renders).

export interface PrComment {
  id: string;
  author: string;
  body: string;
  handled: boolean;
}
export interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  ciStatus: string;
  unresolvedComments: PrComment[];
  approved?: boolean;
  mergeable?: boolean;
  baseBranch?: string;
  mergeableState?: string;
  merged?: boolean;
  /** Labels/tags on the PR; carries the exclusion tag when the operator ignores it. */
  labels?: string[];
  /** Server-computed health: why the PR is stuck (empty reasons = healthy). */
  health?: { blocked: boolean; reasons: string[] };
}
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  linkedPrNumber: number | null;
}
export interface Story {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  wafPillars: string[];
  state: string;
  priority: number;
}
export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  prepDocs: string[];
  prepDone: boolean;
}
export interface WorldSnapshot {
  takenAt: string;
  pullRequests: PullRequest[];
  issues: Issue[];
  stories: Story[];
  calendar: CalendarEvent[];
}

// The Claude-bridged desk briefing (mirrors the server's DeskBriefing — the web
// bundle keeps its own copy and never imports server code). Read-only in the UI.
export interface BriefingMeeting {
  id: string;
  subject: string;
  start: string;
  end: string;
  isOnline: boolean;
  joinUrl?: string;
  webLink?: string;
  organizer?: string;
  attendeeCount?: number;
  responseRequested?: boolean;
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
  relevance: 'mine' | 'area';
}
export interface BriefingMail {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  isUnread: boolean;
  isFlagged: boolean;
  webLink?: string;
  preview?: string;
  relevance: 'mine' | 'area';
  area?: string;
}
export interface BriefingPing {
  id: string;
  source: 'teams';
  chatOrChannel: string;
  from: string;
  sentAt: string;
  preview?: string;
  webLink?: string;
  relevance: 'mine' | 'area';
}
export interface DeskBriefing {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  owner: { email: string; name?: string };
  areas: string[];
  meetings: BriefingMeeting[];
  mail: BriefingMail[];
  pings: BriefingPing[];
}

export interface Task {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  branch: string | null;
  originRef: string | null;
  originTitle: string | null;
  originSummary: string | null;
  dispatchReason: string | null;
  status: string;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Agent {
  id: string;
  taskId: string;
  status: string;
  cwd: string;
  pid: number | null;
  waitingReason: string | null;
  startedAt: string;
  endedAt: string | null;
}
// Extra context the server attaches so an escalation can be answered in-place.
// Mirrors the server's EscalationContext; every key is optional.
export interface EscalationContext {
  taskTitle?: string;
  originRef?: string | null;
  recentOutput?: string;
  prNumber?: number;
  commentId?: string | null;
  draft?: string;
  confidence?: number;
  method?: string;
  autoSendFailed?: boolean;
  autoMergeFailed?: boolean;
  [key: string]: unknown;
}
export interface Escalation {
  id: string;
  type: string;
  status: string;
  prompt: string;
  context: EscalationContext;
  agentId: string | null;
  taskId: string | null;
  response: string | null;
  createdAt: string;
  answeredAt: string | null;
}
export interface Decision {
  id: string;
  cycleId: string;
  action: { type: string; reason?: string };
  outcome: string;
  detail: string;
  /** The dispatcher rule that produced the action (a `dispatchRules` key), or null. */
  rule: string | null;
  createdAt: string;
}

/** One entry of the rule dispatcher's rule book (mirrors the server's DispatchRule). */
export interface DispatchRule {
  number: string;
  name: string;
  description: string;
}

export type WorldEventKind =
  | 'pr_opened'
  | 'pr_ci'
  | 'pr_approved'
  | 'pr_mergeable'
  | 'pr_merged'
  | 'pr_comment'
  | 'issue_opened'
  | 'issue_closed'
  | 'issue_linked'
  | 'story_added'
  | 'story_state'
  | 'meeting_added'
  | 'meeting_prep';

export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  ref: string | null;
  summary: string;
  createdAt: string;
}

/** One recorded failure (cycle exception, provider outage, agent crash, route 500). */
export interface ErrorLogEntry {
  id: string;
  source: 'cycle' | 'provider' | 'agent' | 'server' | 'boot';
  message: string;
  detail: string | null;
  createdAt: string;
}

export interface AppState {
  config: {
    heartbeatIntervalMs: number;
    maxConcurrentAgents: number;
    dispatcher: string;
    steeringPriorities: string[];
    /** The PR exclusion tag: the label the ignore/watch toggle sets, and marks ignored PRs. */
    prExclusionLabel: string;
    /** Whether the world accepts injected events (a `fake` provider is configured) — gates the inject panel. */
    injectable: boolean;
  };
  /** Live, mutable dispatch controls — the current cap and pause state. */
  control: {
    cap: number;
    paused: boolean;
  };
  world: WorldSnapshot;
  tasks: Task[];
  agents: Agent[];
  escalations: Escalation[];
  decisions: Decision[];
  worldEvents: WorldEvent[];
  /** Recorded failures, newest first — the Errors panel. */
  errors: ErrorLogEntry[];
  /** The Claude-bridged desk briefing, or null until a bridge has posted one. */
  briefing: DeskBriefing | null;
  /**
   * External reference → web URL, built entirely by the source-control provider
   * (never string-built here). Keyed by how a ref appears in the UI: `#42` for an
   * issue/PR number, or a branch name. Missing key ⇒ render as plain text.
   */
  refUrls: Record<string, string>;
  /**
   * The rule dispatcher's rule book, keyed by the rule id a decision carries.
   * The Decision log looks `decision.rule` up here to expand a row into the
   * rule that fired; a missing key ⇒ no rule identity to show.
   */
  dispatchRules: Record<string, DispatchRule>;
}

export type ServerEvent =
  | { type: 'dirty' }
  | { type: 'agent:output'; agentId: string; delta: string }
  | { type: 'agent:waiting'; agentId: string; taskId: string; reason: string }
  | { type: 'cycle:end'; cycleId: string; rationale: string }
  | { type: 'control:changed'; cap: number; paused: boolean }
  | { type: string; [k: string]: unknown };
