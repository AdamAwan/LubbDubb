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

/**
 * Where a pull request sits: still open, merged, or closed without merging.
 *
 * Absent on a PR from a provider (or persisted row) that predates closed-PR
 * visibility — read it through the pure `prState` helper in `prHealth.ts`, which
 * folds a missing value back onto the long-standing `merged` flag.
 */
export type PrState = 'open' | 'merged' | 'closed';

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
  /**
   * Open / merged / closed-unmerged. Populated by providers that report recently
   * closed PRs; absent means "the provider only told us about open PRs", which
   * `prState` reads back as open-or-merged from {@link merged}. This is the field
   * that tells a merge apart from an abandoned PR — `merged` alone cannot.
   */
  state?: PrState;
  /** When the PR left the open set (ISO). Only set on a closed/merged PR. */
  closedAt?: string;
  /**
   * Labels/tags on the PR. Drives the provider-agnostic exclusion gate: a PR
   * carrying `config.prExclusionLabel` is left alone by the dispatcher. Absent when
   * the PR carries no labels (or the provider/persisted row predates this field) —
   * treat missing as `[]`.
   */
  labels?: string[];
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
  /**
   * The subset of `labels` the authenticated viewer added themselves, when the
   * provider resolves tag authorship (GitHub timeline / Azure work-item revisions).
   * `undefined` when authorship isn't tracked — the fake provider, or the ownership
   * gate being off. The dispatcher consults this instead of `labels` only when
   * `issuePickupRequireOwnLabel` is set, so a tag added by someone else can't get an
   * item picked up.
   */
  labelsAddedByViewer?: string[];
  state: IssueState;
  /**
   * The provider's *native* workflow state, when it has a richer model than
   * open/closed — e.g. an Azure DevOps work item's `System.State`
   * ("New"/"Ready"/"Doing"/"In Review"/…). `state` above collapses this to
   * open/closed; this preserves the raw value so the dispatcher can gate pickup on
   * it and move an item to a review state once a PR is open. `undefined` for
   * providers with no such model (GitHub issues, the fake), which leaves every
   * state-based gate off for them.
   */
  workItemState?: string;
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
  /**
   * Labels/tags on the story, driving the same opt-in watch/ignore gate as issues
   * (`${labelPrefix}-watch` / `-ignore`). Optional — a story with no labels (older
   * row / provider that predates this) is treated as untagged. Stories are
   * fake-backlog-only today, so this is exercised via the fake provider.
   */
  labels?: string[];
}

/** The full picture of the outside world at one instant. */
export interface WorldSnapshot {
  takenAt: string; // ISO
  /**
   * **Open** pull requests, and only those. Every dispatcher rule and every PR
   * predicate (`openPrForIssue`, `basePrOf`, `inheritedCiFailure`, `isStackedPr`)
   * takes this list and trusts it to be open — recently-closed PRs are carried
   * separately below so that stays true by construction.
   */
  pullRequests: PullRequest[];
  /**
   * PRs that left the open set within `config.closedPrWindowMs` — a merge or an
   * abandonment the harness would otherwise only ever see as a disappearance.
   * Deliberately *not* merged into {@link pullRequests}: it exists so the world
   * diff can emit a real `pr_merged`/`pr_closed`, plan reconciliation can tell a
   * merge from an abandoned PR, and the cockpit can show what just happened —
   * none of which are reasons to put a dead PR in front of a dispatch rule.
   *
   * Absent/empty when the provider doesn't report closed PRs or the window is
   * disabled; every consumer must degrade to the old "absence means merged"
   * inference rather than assuming this list is complete.
   */
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  stories: Story[];
}

// ---------------------------------------------------------------------------
// World change history (observed transitions between snapshots)
// ---------------------------------------------------------------------------

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

/**
 * One observed world state transition, derived by diffing consecutive
 * {@link WorldSnapshot}s. The activity feed is the timeline of these — the
 * counterpart to the decision log, but for the world rather than the harness.
 */
export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  /** The world object this concerns, e.g. "pr:42", "story:abc", "issue:12". Null if global. */
  ref: string | null;
  /** Human-readable one-line summary, e.g. "PR #42 CI passing". */
  summary: string;
  createdAt: string; // ISO
}

/** A world event before the store assigns it an id and timestamp. */
export type WorldEventInput = Omit<WorldEvent, 'id' | 'createdAt'>;

// ---------------------------------------------------------------------------
// Error log (failures surfaced to the cockpit)
// ---------------------------------------------------------------------------

/**
 * One recorded failure — a harness cycle exception, a provider snapshot error, an
 * agent crash, a route 500, … Durable (persisted to the store) and streamed to the
 * cockpit's Errors panel so an operator can see things going wrong as they happen.
 */
export interface ErrorLogEntry {
  id: string;
  /** Which part of the system the failure came from. */
  source: 'cycle' | 'provider' | 'agent' | 'server' | 'boot';
  /** Human-readable one-line summary of what failed. */
  message: string;
  /** Optional longer context (stack trace, output tail). Null if none. */
  detail: string | null;
  createdAt: string; // ISO
}

/** An error before the store assigns it an id and timestamp. */
export type ErrorLogInput = Omit<ErrorLogEntry, 'id' | 'createdAt' | 'detail'> & { detail?: string | null };

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
  /**
   * Human-readable context about the originating item, captured at dispatch
   * time so the cockpit can explain a running agent without re-fetching from
   * the source provider (issue #17). `originTitle` is the source item's own
   * title (issue/PR/story title), `originSummary` a body excerpt or state
   * summary, and `dispatchReason` the reason the dispatcher started this task.
   */
  originTitle: string | null;
  originSummary: string | null;
  dispatchReason: string | null;
  status: TaskStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An operator-launched job: a prompt queued from the cockpit that the harness
 * turns into an agent. Unlike a {@link Task} (materialised the instant an agent
 * spawns), a job is a durable request that persists *ahead of* dispatch — so it
 * can sit in a queue when the fleet is at capacity and be dispatched in a later
 * cycle. The dispatcher drains queued jobs before any world-driven rule, so a
 * manual request takes priority for the next free slot.
 */
export type JobStatus =
  | 'queued' // awaiting a free slot
  | 'dispatched' // an agent was spawned for it (see taskId)
  | 'cancelled'; // the operator dropped it before it ran

export interface Job {
  id: string;
  /** Human-readable title (derived from the prompt when the operator omits one). */
  title: string;
  /** The prompt handed to the agent when this job is dispatched. */
  prompt: string;
  /** Whether it runs as a code agent (in a worktree) or a desk agent (scratch dir). */
  kind: TaskKind;
  /** For code jobs: the branch to work on. Null => derived (`job/<id>`) at dispatch. */
  branch: string | null;
  status: JobStatus;
  /** The task this job was dispatched as, once it has been. Null while queued. */
  taskId: string | null;
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
  /**
   * Claude Code session id this agent runs under, chosen at spawn so it can be
   * resumed (`claude --resume <id>`) in the same worktree after a restart. Null
   * for runtimes that don't support resume, or agents that never got one.
   */
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * Cumulative Claude usage as last reported by the session's `result` events
   * (stream runtime only — a PTY session reports none, so these stay null).
   * `costUsd` is the session's total API cost so far; tokens/turns likewise
   * accumulate across the whole session.
   */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  /**
   * The agent's own one-line answer to "what are you doing right now", from the
   * `note_progress` tool — a *current value*, replaced on each call, and null for
   * an agent that never called it (which is a supported state, not a degraded
   * one: the output tail is what the fleet card falls back to).
   */
  note: string | null;
  /**
   * When {@link Agent.note} was written. Display context only — it dates the note
   * so a reader knows how current it is. **Nothing derives liveness or health from
   * it**, by decision: the longest gaps between notes are the long test runs and
   * big refactors, i.e. exactly the stretches where an agent is healthiest, so a
   * staleness verdict would punish honest use and turn this into a heartbeat.
   * Liveness is the process, the status transitions and the `waiting` park.
   */
  notedAt: string | null;
}

/**
 * An artifact an agent surfaced to the cockpit mid-run via the flag sentinel
 * (`@@LUBBDUBB_FLAG:…@@`) — a design doc, a report, a link. Generic on purpose:
 * `kind`/`label` are cosmetic and `ref` is either a worktree-relative path (served
 * through the confined artifact route) or an absolute http(s) URL. Deduped per
 * agent by `ref`, so an agent re-flagging the same doc as it evolves just refreshes
 * the timestamp rather than piling up duplicates.
 */
export interface AgentFlag {
  id: string;
  agentId: string;
  kind: string;
  label: string;
  ref: string;
  createdAt: string;
}

/** A flag as parsed from the sentinel, before the store assigns identity. */
export type AgentFlagInput = Pick<AgentFlag, 'kind' | 'label' | 'ref'>;

/**
 * A file an agent wrote, captured by the file-events `PostToolUse` hook (not the
 * flag sentinel — so it needs no cooperation from the agent's prompt). Every
 * write is tracked as the "files changed" list; `promoted` ones are additionally
 * surfaced as an {@link AgentFlag} chip (a report/doc, per `classifyArtifact`).
 * Deduped per agent by `path`.
 */
export interface AgentFile {
  id: string;
  agentId: string;
  /** Worktree-relative when the write landed inside the agent's cwd, else as reported. */
  path: string;
  /** The tool that wrote it (Write/Edit/…), or null if the hook didn't report one. */
  tool: string | null;
  /** True when this was surfaced as an artifact chip (a report, not a code change). */
  promoted: boolean;
  createdAt: string;
}

/** A file event as captured, before the store assigns identity. */
export type AgentFileInput = Pick<AgentFile, 'path' | 'tool' | 'promoted'>;

// ---------------------------------------------------------------------------
// Findings (what an agent discovers outside its own task)
// ---------------------------------------------------------------------------

/**
 * What sort of discovery a finding is.
 *
 * The vocabulary is three concrete gaps, not a taxonomy: each kind is one thing
 * an agent could previously only write into a PR comment, and each implies a
 * *different operator action*, which is the axis that earns a separate kind.
 *
 * - `duplicate` — "this issue duplicates #41". Two tracked items are one piece of
 *   work; the operator closes or links one.
 * - `blocked` — "the real fix is in a package I don't own". The work cannot be
 *   completed from here; the operator unblocks it or parks it.
 * - `out_of_scope` — "there's an unrelated bug in the module I touched". Work
 *   nobody has yet; the operator decides whether it becomes a job.
 */
export type FindingKind = 'duplicate' | 'blocked' | 'out_of_scope';

/**
 * Where a finding sits: `open` until an operator acts on it, then either
 * `promoted` (queued as a job — see {@link Finding.jobId}) or `dismissed`.
 * Nothing in the dispatcher reads findings; the transition is operator-driven by
 * design (see `src/mcp/findings.ts`).
 */
export type FindingStatus = 'open' | 'promoted' | 'dismissed';

/**
 * Something an agent noticed that is not its own task — filed through the
 * `report_finding` tool. Attribution is structural: `agentId`/`taskId`/`originRef`
 * come from the credential the call arrived on, never from an argument, so a
 * finding always says truthfully who found it and what they were working on.
 */
export interface Finding {
  id: string;
  /** The agent that filed it, from its credential. */
  agentId: string;
  /** That agent's task, and the origin it was dispatched for. */
  taskId: string;
  originRef: string | null;
  kind: FindingKind;
  /** The world item the finding is *about* (`issue:41`), or null — not every finding has one. */
  ref: string | null;
  summary: string;
  status: FindingStatus;
  /** The operator-queued job this was promoted into, if it was. */
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A finding as reported, before the store assigns identity and status. */
export type FindingInput = Pick<Finding, 'kind' | 'ref' | 'summary'>;

// ---------------------------------------------------------------------------
// Plans (the multi-PR issue funnel)
// ---------------------------------------------------------------------------

/**
 * Where a plan sits in its life:
 * - `planning` — a verdict is still being worked out (a replan in flight).
 * - `single`   — the planner said one PR; the issue falls through to normal pickup.
 * - `active`   — decomposed into parts, at least one still outstanding.
 * - `complete` — every part merged.
 * - `abandoned`— the operator gave up on the decomposition.
 */
export type PlanStatus = 'planning' | 'single' | 'active' | 'complete' | 'abandoned';

/**
 * One issue's delivery plan — the planning agent's verdict, persisted so the
 * planner never re-runs on the same issue. Written for *both* outcomes: a
 * `single` plan is a first-class row, which is what turns today's one-agent /
 * one-PR path into an explicit outcome of the funnel rather than a bypass.
 */
export interface Plan {
  id: string;
  /** The issue this plan belongs to, in the world's ref shape: `issue:12`. */
  originRef: string;
  title: string;
  status: PlanStatus;
  /** The planner's own justification for its verdict. Null when it gave none. */
  reason: string | null;
  /** Provider comment id for the plan's status comment, edited in place (stage 3). */
  statusCommentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where one part of a multi-PR plan sits: `pending` (dependencies outstanding),
 * `ready` (dispatchable), `dispatched` (an agent is on it), `in_review` (its PR
 * is open), `merged`, `blocked`, or `retired` — a part an amended plan no longer
 * declares. Retiring is a *status transition, not a disappearance*: the row stays
 * so the graph remains readable after a replan, and nothing schedules it again.
 */
export type PlanPartStatus = 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'blocked' | 'retired';

/** One part of a multi-PR plan — a single reviewable PR's worth of work. */
export interface PlanPart {
  /** `<plan id>:<slug>`. */
  id: string;
  planId: string;
  /** Stable, author-chosen, unique within the plan; survives a replan. */
  slug: string;
  seq: number;
  title: string;
  /** Files/areas this part owns, so concurrent parts don't collide. */
  scope: string;
  /** Sibling slugs this part stacks on. */
  dependsOn: string[];
  branch: string | null;
  prNumber: number | null;
  status: PlanPartStatus;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A part as the planner declared it, before the store assigns identity or progress. */
export type PlanPartInput = Pick<PlanPart, 'slug' | 'seq' | 'title' | 'scope' | 'dependsOn'>;

/** One cumulative usage report from a session's turn-end `result` event. */
export interface AgentUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** One subscriber rate-limit window (5h or weekly) as Claude Code reports it. */
export interface RateLimitWindow {
  usedPercentage: number;
  /** ISO timestamp the window resets at, when reported. */
  resetsAt: string | null;
}

/**
 * Account-level Claude rate limits captured from a PTY agent's status-line
 * payload. Pro/Max only — API-key auth carries no `rate_limits`, and each
 * window can be independently absent.
 */
export interface AccountRateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  /** When the payload this was parsed from was written. */
  capturedAt: string;
}

export type EscalationType = 'approve_change' | 'answer_question' | 'resolve_ambiguity' | 'review_reply';

/**
 * A structured question an agent raised through the `escalate` MCP tool — the
 * typed form of what the WAITING sentinel can only carry as one line of free
 * text. `question` is the sentinel's equivalent and is all that is required; the
 * rest is what the sentinel could never express.
 */
export interface AgentAsk {
  /** One line: what the agent needs decided. Becomes the escalation prompt. */
  question: string;
  /** What sort of decision this is; maps onto {@link EscalationType}. */
  kind?: string;
  /** Concrete answers the cockpit renders as one-click replies. */
  options?: string[];
  /** Background the human needs in order to decide. */
  detail?: string;
}

export type EscalationStatus = 'open' | 'answered' | 'dismissed';

/**
 * The extra context an escalation carries so a human can answer it in-place,
 * without leaving the card. Every key is optional — each escalation type
 * populates the subset that makes sense — and the index signature keeps it
 * extensible for new kinds. The cockpit's `EscalationCard` renders whatever is
 * present (recent output, the originating signal, a draft reply, …).
 */
export interface EscalationContext {
  /** Title of the task this escalation concerns. */
  taskTitle?: string;
  /** The world signal that spawned the task, e.g. "pr:42:ci" or "issue:12". */
  originRef?: string | null;
  /** Tail of the agent's transcript leading up to the question (sentinels stripped). */
  recentOutput?: string;
  // -- reply_on_pr / merge_pr escalations --------------------------------
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
  type: EscalationType;
  status: EscalationStatus;
  /** What the human needs to weigh in on. */
  prompt: string;
  /** Task/agent/PR this concerns — see {@link EscalationContext}. */
  context: EscalationContext;
  /** If tied to a live parked agent, its answer is typed into that session. */
  agentId: string | null;
  taskId: string | null;
  response: string | null;
  createdAt: string;
  answeredAt: string | null;
}

/**
 * What a human is being asked to authorize. Two today (issue #109 phase 1), both
 * acts the auto-send gate already refuses to perform on its own: a drafted PR
 * reply and a merge.
 */
export type ProposalKind = 'reply_draft' | 'merge';

/** One-way: a proposal leaves `pending` exactly once, in one of two directions. */
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/**
 * An act the harness proposed and a human accepted or rejected — the object that
 * was missing between "approve" and "the approved thing happens" (issue #109).
 *
 * An {@link Escalation} can record that a human *typed something*; only this can
 * record that they said **yes**, which is the difference between an approval the
 * harness can branch on and one that goes nowhere. It hangs off an escalation
 * rather than replacing it: the escalation stays the inbox item and the routing
 * mechanism, and a plain question still has no proposal at all.
 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  /**
   * The act's subject in the harness's own ref vocabulary (`pr:42:merge`,
   * `pr:42:comment:c_7`). This is what the gate keys on, which is why it's a
   * column and not something re-derived from the payload at read time.
   */
  ref: string;
  status: ProposalStatus;
  /**
   * The validated action the executor was about to run, kept verbatim: accepting
   * runs *that act*, not a re-derivation of it from the world as it is minutes later.
   */
  action: Action;
  /** Free text alongside the verdict — never instead of it. */
  note: string | null;
  /** Who decided. Only `human` is written today; phase 2 folds `autoSend` in here. */
  decidedBy: 'human' | 'auto_send' | null;
  decidedAt: string | null;
  /** The inbox item this hangs off, so answering and deciding stay one surface. */
  escalationId: string | null;
  createdAt: string;
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
  | 'set_work_item_state'
  | 'no_op';

/** One decision from the dispatcher. Every action carries a reason for the audit log. */
export interface Action {
  type: ActionType;
  reason: string;
  /** The dispatcher rule that produced this action (a `DISPATCH_RULES` id), when one did. */
  rule?: string | null;
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
  /**
   * The dispatcher rule that produced the action, lifted off it at record time
   * so the audit log can answer "which rule fired" first-class. Null for
   * decisions with no rule identity (LLM dispatcher, lifecycle bookkeeping).
   */
  rule: string | null;
  createdAt: string;
}
