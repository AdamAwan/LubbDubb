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
  /** 'open' | 'merged' | 'closed' — set on recently-closed PRs; absent means open. */
  state?: string;
  /** When the PR left the open set (ISO). Only on a closed/merged PR. */
  closedAt?: string;
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
  /**
   * Server-computed pickup verdict (mirrors PR `health`): what the harness is
   * doing with this item — or why it's leaving it alone.
   */
  pickup?: { eligible: boolean; status: string; reasons: string[] };
}
export interface Story {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  wafPillars: string[];
  state: string;
  priority: number;
  /** Labels/tags on the story, carrying the watch/ignore tag when the operator toggles it. */
  labels?: string[];
}
export interface WorldSnapshot {
  takenAt: string;
  /** Open PRs, and only those. */
  pullRequests: PullRequest[];
  /**
   * PRs that left the open set within the server's retention window, marked
   * merged vs closed-unmerged. Optional so a cockpit against an older server (or
   * one with the window disabled) simply draws no "recently closed" list.
   */
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  stories: Story[];
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
/** An artifact/link an agent surfaced mid-run via the flag sentinel (mirrors the server's AgentFlag). */
export interface AgentFlag {
  id: string;
  agentId: string;
  kind: string;
  label: string;
  /** A worktree-relative path (served via the artifact route) or an absolute http(s) URL. */
  ref: string;
  createdAt: string;
}
/** A file an agent wrote, captured by the file-events hook (mirrors the server's AgentFile). */
export interface AgentFile {
  id: string;
  agentId: string;
  path: string;
  tool: string | null;
  /** True when this file was also surfaced as an artifact chip (a report, not a code change). */
  promoted: boolean;
  createdAt: string;
}
/**
 * Something an agent noticed outside its own task (mirrors the server's Finding):
 * a duplicate, work blocked on something outside its reach, an out-of-scope
 * discovery. Operator-facing — it becomes work only when promoted from here.
 */
export interface Finding {
  id: string;
  agentId: string;
  taskId: string;
  /** The origin the reporting agent was working when it noticed this. */
  originRef: string | null;
  kind: 'duplicate' | 'blocked' | 'out_of_scope';
  /** The item it is about (`issue:41`), or null when it names nothing tracked. */
  ref: string | null;
  summary: string;
  status: 'open' | 'promoted' | 'dismissed';
  /** The queued job it was promoted into, if it was. */
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
}
/**
 * One issue's delivery plan (mirrors the server's Plan). `single` means the
 * planner said one PR will do and the issue falls through to ordinary pickup;
 * `active`/`complete` mean it was decomposed into the parts below.
 */
export interface Plan {
  id: string;
  /** `issue:12` — the issue this plan hangs off. */
  originRef: string;
  title: string;
  /** 'planning' | 'single' | 'active' | 'complete' | 'abandoned'. */
  status: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
/** One part of a multi-PR plan — a single reviewable PR's worth of work (mirrors the server's PlanPart). */
export interface PlanPart {
  id: string;
  planId: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  /** Sibling slugs this part stacks on (at most one). */
  dependsOn: string[];
  branch: string | null;
  prNumber: number | null;
  /** 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'blocked' | 'retired'. */
  status: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Job {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  branch: string | null;
  /** 'queued' | 'dispatched' | 'cancelled'. */
  status: string;
  taskId: string | null;
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
  /** Cumulative Claude usage from the stream runtime; null when unreported (PTY). */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  /**
   * What the agent last said it was doing (`note_progress`), or null if it never
   * said — in which case the card falls back to the output tail exactly as before.
   */
  note: string | null;
  /** When the note was written. Shown as an age; never read as a health signal. */
  notedAt: string | null;
}

// Account-level Claude usage (issue #60): rolling cost windows self-computed by
// the server from per-turn usage reports, plus the real subscriber limits when
// the PTY status-line capture has seen any (Pro/Max only, else null).
interface RateLimitWindow {
  usedPercentage: number;
  resetsAt: string | null;
}
interface AccountRateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  capturedAt: string;
}
export interface UsageSnapshot {
  windows: { fiveHourCostUsd: number; sevenDayCostUsd: number };
  rateLimits: AccountRateLimits | null;
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

/** One ranked candidate in the dispatcher's pickup plan (mirrors the server's QueueItem). */
export interface QueueItem {
  origin: string;
  /** The dispatcher rule that raised the candidate (a `dispatchRules` key). */
  rule: string;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  /**
   * Above the headroom cut, waiting on a free slot, throttled by the cooldown, or
   * `capped` — held by a per-plan concurrency limit, so a free slot wouldn't help.
   */
  status: 'dispatching' | 'waiting' | 'cooldown' | 'capped';
  reason: string;
}

/**
 * The last cycle's ordered pickup plan — the "Up next" queue. A per-pulse
 * projection the dispatcher recomputes from the world, not a persisted FIFO.
 */
export interface UpcomingPlan {
  cycleId: string;
  /** When the world this plan ranks was observed. */
  at: string;
  items: QueueItem[];
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
  | 'issue_linked'
  | 'story_added'
  | 'story_state';

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
    /** `${labelPrefix}-watch` — the tag the watch toggle sets and that marks an item watched. */
    watchLabel: string;
    /** `${labelPrefix}-ignore` — the tag the ignore toggle sets and that marks an item ignored. */
    ignoreLabel: string;
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
  /**
   * The multi-PR plan graph: one plan per planned issue, and every plan's parts.
   * Optional so a cockpit against an older server (or one with the funnel off)
   * simply draws no plan panel.
   */
  plans?: Plan[];
  planParts?: PlanPart[];
  /** Operator-launched jobs, newest first — the queue (and its recent history). */
  jobs: Job[];
  agents: Agent[];
  /** Artifacts/links agents surfaced mid-run, grouped by agentId in the UI. Optional so an older server degrades gracefully. */
  flags?: AgentFlag[];
  /** Every file agents wrote (file-events hook), grouped by agentId for the drawer's "files changed" list. Optional for older servers. */
  files?: AgentFile[];
  /** What agents noticed outside their own tasks, newest first. Optional for older servers. */
  findings?: Finding[];
  escalations: Escalation[];
  decisions: Decision[];
  /**
   * The dispatcher's "Up next" queue from the last pulse, or null when no cycle
   * has run yet / the active dispatcher doesn't materialise a plan (LLM).
   * Optional so a cockpit against an older server degrades to no panel.
   */
  upcoming?: UpcomingPlan | null;
  worldEvents: WorldEvent[];
  /** Recorded failures, newest first — the Errors panel. */
  errors: ErrorLogEntry[];
  /** Claude usage: rolling cost windows + account rate limits when captured. */
  usage: UsageSnapshot;
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
  | { type: 'agent:flag'; flag: AgentFlag }
  | { type: 'agent:waiting'; agentId: string; taskId: string; reason: string }
  | { type: 'cycle:end'; cycleId: string; rationale: string }
  | { type: 'control:changed'; cap: number; paused: boolean }
  | { type: string; [k: string]: unknown };
