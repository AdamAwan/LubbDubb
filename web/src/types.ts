// Mirrors the server's domain types (kept deliberately small — just what the UI renders).

interface PrComment {
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
  /**
   * Server-computed attention verdict, beside `health` rather than inside it:
   * health says *can this merge*, attention says *whose turn is it*.
   * `done`|`ignored`|`you`|`harness`|`elsewhere`|`settled`|`stalled`.
   */
  attention?: { status: string; reasons: string[] };
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
  /**
   * Whether anyone has said this issue is finished — beside `pickup`, not inside
   * it. Pickup says what the harness would do next cycle; this says whether the
   * work is concluded, which is what stops a merged ticket being re-picked.
   * `done`|`more_work`|`undeclared`, with `by` naming the plan derivation, the
   * declaring agent or the operator.
   */
  conclusion?: {
    verdict: 'done' | 'more_work' | 'undeclared';
    by: 'agent' | 'operator' | 'plan' | null;
    note: string;
    at: string | null;
  };
}
interface Story {
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
/** One agent's part in a file overlap (mirrors the server's OverlapWriter). */
interface OverlapWriter {
  agentId: string;
  taskId: string;
  originRef: string | null;
  originTitle: string | null;
  branch: string | null;
  status: string;
  at: string;
}
/**
 * A path two agents wrote while both were running (mirrors the server's FileOverlap).
 * Derived from the file-events rows, not from anything an agent had to declare.
 */
export interface FileOverlap {
  path: string;
  writers: OverlapWriter[];
  /** Both on one branch, hence one worktree — one file on disk, two live processes. */
  sameWorktree: boolean;
  /** Still happening: two or more of the writers are live. */
  live: boolean;
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
  /** `filing` is a filing agent in flight; `filed` carries {@link Finding.ticketRef}. */
  status: 'open' | 'promoted' | 'dismissed' | 'filing' | 'filed';
  /** The queued job it became — the one working it, or the one filing it. */
  jobId: string | null;
  /** The tracker item it was filed as (`issue:314`), once the filing agent reported it. */
  ticketRef: string | null;
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
  /** 'planning' | 'single' | 'awaiting_approval' | 'active' | 'complete' | 'abandoned'. */
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
/**
 * One node of the durable work graph (mirrors the server's `WorkNode`). Unlike
 * everything else here it does not ride `/api/state` — the graph never forgets, so
 * shipping the forest on every poll would be the wrong shape. It arrives from
 * `/api/work` and `/api/work/:ref` instead, which is why no `AppState` key names it.
 */
export interface WorkNodeView {
  ref: string;
  kind: 'issue' | 'plan' | 'part' | 'pr' | 'concern' | 'job' | 'assess';
  /** Work lineage: a PR's parent is the part that produced it. Null on a root. */
  parentRef: string | null;
  /** PR nodes only: the PR this one is stacked on. A cross-link, never the parent. */
  baseRef: string | null;
  title: string;
  status: string;
  terminal: boolean;
  /** How a terminal PR state was learned — `inferred` means absence was read as a merge. */
  provenance: 'observed' | 'inferred' | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Work the harness did that nothing external accounts for — an operator job that
 * produced commits with no issue anywhere behind it. Because completion is read
 * from the tracker and never computed, an item the tracker has never heard of has
 * no terminal state available to it at all.
 *
 * `prCount` is evidence beside the verdict, never part of it: requiring a PR
 * would mean only ever recording work already visible.
 */
export interface UnrecordedWorkView {
  ref: string;
  title: string;
  prCount: number;
  firstSeenAt: string;
  /** A filing already in flight, if one is. Null means the button is live. */
  filing: 'filing' | 'filed' | null;
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
  /**
   * When a *parked* agent was last seen making a tool call — i.e. it carried on
   * working instead of waiting, so any alert still open against it is probably
   * stale. Null when that has not happened since its current park. The status stays
   * `waiting` deliberately; this is the evidence that it is out of date.
   */
  resumedAt: string | null;
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
interface EscalationContext {
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
  /** Set when this is a live permission request (issue #130): the blocked tool call. */
  permission?: { toolName: string; summary: string };
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
/**
 * An act the harness proposed and a human accepts or rejects (mirrors the
 * server's Proposal). Accepting performs the act; rejecting records why and stops
 * the rule that proposed it from asking again.
 */
export interface Proposal {
  id: string;
  /** 'reply_draft' | 'merge' | 'plan'. */
  kind: string;
  /** The act's subject, e.g. `pr:42:merge` or `issue:12:plan`. */
  ref: string;
  /** 'pending' | 'accepted' | 'rejected'. */
  status: string;
  action: { type: string; reason?: string; [key: string]: unknown };
  note: string | null;
  /** 'human' | 'auto_send' | null — who settled it. */
  decidedBy: string | null;
  decidedAt: string | null;
  escalationId: string | null;
  createdAt: string;
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
   * Above the headroom cut, waiting on a free slot, throttled by the cooldown,
   * `capped` — held by a per-plan concurrency limit, so a free slot wouldn't help
   * — or `unapproved`, held because the plan it belongs to is a decomposition you
   * have not accepted yet.
   */
  status: 'dispatching' | 'waiting' | 'cooldown' | 'capped' | 'unapproved';
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

/** What an operator can do with an agent that did not survive the last run. */
export type RecoveryVerdict = 'restore' | 'requeue' | 'remove';

/** One agent orphaned by a crash or a shutdown, awaiting a verdict. */
export interface CrashedAgent {
  agentId: string;
  taskId: string;
  title: string;
  kind: string;
  originRef: string | null;
  branch: string | null;
  cwd: string;
  /** `crashed` — the process fell over; `interrupted` — it was shut down cleanly. */
  died: 'crashed' | 'interrupted';
  /** The question it was parked on when it went, if it was parked on one. */
  waitingReason: string | null;
  /** Its last `note_progress` line — the best account there is of how far it got. */
  note: string | null;
  startedAt: string;
  detectedAt: string | null;
  restorable: boolean;
  /** Why restore is not on offer, in the operator's terms. Null when it is. */
  restoreBlocked: string | null;
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
    /**
     * Whether a real tracker is configured to file into — gates the "File ticket"
     * button on a finding and "File a work item" on unrecorded work alike, off the
     * same predicate both routes refuse on.
     */
    canFileTickets: boolean;
  };
  /** Live, mutable dispatch controls — the current cap and pause state. */
  control: {
    cap: number;
    paused: boolean;
  };
  /**
   * When `world` was observed. The cockpit's world is the baseline the last pulse
   * persisted — not a live provider read, which would put a provider fan-out
   * behind every refetch — so its age is shown rather than implied. Null before
   * the first cycle, when the world is empty.
   */
  worldObservedAt: string | null;
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
  /** Paths two concurrently-running agents both wrote. Optional for older servers. */
  overlaps?: FileOverlap[];
  /** What agents noticed outside their own tasks, newest first. Optional for older servers. */
  findings?: Finding[];
  escalations: Escalation[];
  /**
   * Agents the previous run left orphaned, each awaiting a restore / requeue /
   * remove. **A non-empty list means the harness is running no cycles at all**, so
   * the cockpit draws it as a blocking banner rather than one more panel. Optional
   * so an older server simply shows none.
   */
  recovery?: CrashedAgent[];
  /** Acts put to a human, newest first. Optional so an older server degrades to plain escalations. */
  proposals?: Proposal[];
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
   * Flag id → the URL to open that artifact by navigation. Built server-side so it
   * can carry the per-flag capability a navigation needs (a bearer header can't
   * ride a top-level navigation). An http(s) flag is absent here — the cockpit
   * links those directly. Optional so an older server degrades gracefully.
   */
  artifactUrls?: Record<string, string>;
  /**
   * The rule dispatcher's rule book, keyed by the rule id a decision carries.
   * The Decision log looks `decision.rule` up here to expand a row into the
   * rule that fired; a missing key ⇒ no rule identity to show.
   */
  dispatchRules: Record<string, DispatchRule>;
}
