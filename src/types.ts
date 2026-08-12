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

/**
 * One CI check as its provider names it — a GitHub check-run or commit status
 * context, an Azure blocking policy.
 *
 * {@link CiStatus} is the fold of these and stays the field every gate reads;
 * this is the detail the fold used to discard, kept so per-check policy can act
 * on *which* check went red (`src/ci/ciPolicy.ts`). Never `unknown`: a check
 * that has not reported is `pending`, and a check with no signal at all is not
 * in the list.
 */
export interface CiCheck {
  name: string;
  status: Exclude<CiStatus, 'unknown'>;
  /**
   * False when the provider says this check does not block completion (an Azure
   * "Optional" branch policy). Absent means blocking, so every provider and
   * persisted row that predates this reads unchanged.
   *
   * Display and briefing only — nothing gates on it. Whether a *check* blocks and
   * whether the *PR* can merge are different questions, and the second is
   * {@link CiStatus}'s alone.
   */
  blocking?: boolean;
  /**
   * Other names the provider shows for this same check. A `ci.checks` glob
   * matches an alias exactly as it matches {@link name}, so an operator can write
   * the rule against whichever name they can actually see.
   *
   * Azure's status policies are the case it exists for: the harness keys one by
   * its `statusGenre/statusName` pair (`pr-agent-review/reviewed`), which is *not*
   * the label the pull request page shows for it (`settings.defaultDisplayName`,
   * e.g. `PR-Agent-Reviewed`). {@link name} stays the primary — it is what the
   * cockpit renders and what a briefing names — so nothing an existing glob
   * matched stops matching.
   */
  aliases?: string[];
  /**
   * Reported for visibility only: `classifyCiFailures` never classifies it and
   * `ciNeedsAttention` never counts it, so it cannot dispatch an agent, escalate,
   * or be muted by a `ci.checks` rule.
   *
   * The Azure comment policy's mode. Surfacing it as an ordinary check would let
   * rule `pr-ci-failing` outrank rule `pr-review-comment` and send the generic CI-fix prompt in place of one
   * carrying the comment's author and body — the same work with strictly less
   * information. Structural rather than configurational, so the correct behaviour
   * cannot be lost by forgetting a line of config.
   */
  advisory?: boolean;
}

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
  /**
   * The individual checks {@link ciStatus} folds. Optional: a provider that
   * doesn't report per-check detail (and every PR persisted before it did)
   * leaves it unset, which the CI policy reads as "no detail" and therefore as
   * the pre-policy behaviour — act on the failure generically.
   */
  ciChecks?: CiCheck[];
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
 * a pull request.
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
  /**
   * The provider's *native* item type — an Azure DevOps work item's
   * `System.WorkItemType` ("Feature", "User Story", "Bug", "Task"). `undefined`
   * for trackers with one kind of item (GitHub issues, the fake), which leaves
   * every type-based gate off for them. The dispatcher reads it to refuse
   * picking up a *container* type (see `src/issueRelations.ts`).
   */
  issueType?: string;
  /**
   * The item this one hangs off — an Azure DevOps hierarchy parent, typically the
   * Feature a story or bug belongs to. Carries the parent's **description**,
   * because that is where the overall goal of the feature is written and it is
   * the context an agent planning one of its children needs.
   *
   * The three states are distinct and all three are read: `undefined` means the
   * provider does not track hierarchy at all, `null` means it does and this item
   * has no parent (an *orphan* — which the harness reports rather than invents a
   * parent for), and an object is the parent itself.
   */
  parent?: IssueRelative | null;
  /**
   * The items hanging off this one — a Feature's stories. Empty for a leaf.
   * `undefined` when the provider does not track hierarchy. Bodies are not
   * carried: a child's own description is read when that child is worked, and
   * carrying every one would put a whole feature's text on every snapshot.
   */
  children?: IssueRelative[];
  /**
   * The *other* children of {@link parent} — the sibling stories under the same
   * feature. `undefined` when hierarchy isn't tracked or there is no parent;
   * empty when this is the feature's only child. What makes a planning agent able
   * to see the scope either side of the item it was handed.
   */
  siblings?: IssueRelative[];
  /** The PR opened to resolve this issue, once one exists. Null until linked. */
  linkedPrNumber: number | null;
  url?: string;
}

/**
 * One end of a tracker relationship — the parent, child or sibling of an
 * {@link Issue}, as it is carried *on* that issue.
 *
 * Deliberately not an `Issue`: a relative is a summary, and typing it as the full
 * item would invite code to treat a related item as something the harness can act
 * on. Only the item the harness was handed is ever dispatched against; everything
 * here is context.
 */
export interface IssueRelative {
  number: number;
  title: string;
  /** `System.WorkItemType` — "Feature", "User Story", "Bug", … */
  issueType: string;
  /** The provider-native workflow state, unsummarised (the sibling list shows it). */
  workItemState: string;
  /** The open/closed collapse of {@link workItemState}, so readers need no state vocabulary. */
  state: IssueState;
  /**
   * The item's description. Present on a **parent** only — the feature's goal —
   * and omitted everywhere else on purpose (see {@link Issue.children}).
   */
  body?: string;
  url?: string;
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
  | 'issue_linked';

/**
 * One observed world state transition, derived by diffing consecutive
 * {@link WorldSnapshot}s. The activity feed is the timeline of these — the
 * counterpart to the decision log, but for the world rather than the harness.
 */
export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  /** The world object this concerns, e.g. "pr:42", "issue:12". Null if global. */
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

type TaskKind = 'code' | 'desk';

type TaskStatus =
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
   * title (issue/PR title), `originSummary` a body excerpt or state
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
type JobStatus =
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
  /**
   * The origin whose work this job stands in for — `issue:41:retro` for a retro a
   * crash recovery **requeued**, and null for the ordinary operator job, which
   * stands in for nothing.
   *
   * A job's *own* origin is always `job:<id>`: that is what the dispatch is keyed
   * on, what the executor marks dispatched, and what the work graph folds its PR
   * onto. This field is the other half — the work being redone — and it exists
   * because the gates that stop two agents landing on one piece of work read
   * origins. Without it a requeued `issue:41:retro` is invisible to the rule that
   * dispatches retros, which dispatches a second one while the first is running.
   */
  originRef: string | null;
  /** The task this job was dispatched as, once it has been. Null while queued. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A recurring blueprint: a prompt the operator wants run on a cron schedule, and
 * how far through that recurrence the harness has got.
 *
 * It is **intent, not work**. What a firing produces is an ordinary {@link Job},
 * queued exactly as a hand-launched one is and dispatched by the same rule — so a
 * schedule adds a way for work to arrive and no new way for it to be run. That is
 * what keeps a recurrence inside every gate the fleet already has: the cap, the
 * pause flag, the Up next queue and the cooldowns all see a job and neither know
 * nor care that a clock queued it.
 */
export interface JobSchedule {
  id: string;
  /** The title each firing's job carries. Derived from the prompt when the operator omits one. */
  title: string;
  /** The prompt each firing's job carries, verbatim. */
  prompt: string;
  /** Whether firings run as a code agent (in a worktree) or a desk agent (scratch dir). */
  kind: TaskKind;
  /**
   * The five-field cron expression, read in the **harness process's local
   * timezone** — see `src/schedules/cron.ts` for what that means on the two days
   * a year it is not the same as any other clock.
   */
  cron: string;
  /** Off means the recurrence stands but nothing fires; `nextRunAt` is null while it is. */
  enabled: boolean;
  /**
   * When the next firing is due. Null while the schedule is disabled, and null for
   * an expression that matches no future minute at all (`0 0 30 2 *`), which is
   * how a schedule that can never fire says so instead of being asked every pulse.
   */
  nextRunAt: string | null;
  /** When it last fired — including a firing the operator asked for by hand. */
  lastFiredAt: string | null;
  /**
   * The job the last firing created, which is also how the next pulse asks whether
   * that firing is still going on. Null until it has fired once.
   */
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An image an operator attached to a blueprint, as it arrives on the wire
 * (issue #249). `data` is base64 of the raw file — no data-URL prefix.
 *
 * There is deliberately **no `mime` field**: a client-declared type is
 * attacker-controlled, and the type an agent is told to trust is the one sniffed
 * from the decoded bytes (`src/jobs/attachments.ts`). `name` is a display label
 * only and is never used to build a path.
 */
export interface JobAttachmentInput {
  /** The operator's own filename, kept for display. Optional — a pasted screenshot has none. */
  name?: string;
  /** The file's bytes, base64-encoded. */
  data: string;
}

/**
 * An attachment as stored: the file on disk, plus what an agent is told about it.
 *
 * Keyed on `targetRef` rather than on a job id, because the thing an attachment
 * belongs to outlives the row it arrived with — a code blueprint becomes a desk
 * filing job and then a ticket, and the image has to follow.
 */
export interface JobAttachment {
  id: string;
  /** What it is attached to: `job:<id>` while the blueprint is one. */
  targetRef: string;
  /** Position in the operator's list, 0-based — also the file's stem on disk. */
  index: number;
  /** The operator's filename, for display. Never used as a path. */
  label: string;
  /** The image type, decided by magic bytes on the decoded buffer. */
  mime: string;
  /** Size of the stored file in bytes. */
  bytes: number;
  /** Absolute path to the stored file — what an agent is handed. */
  path: string;
  createdAt: string;
}

/** What a work-graph node represents. `assess` is written only by stage 2. */
export type WorkNodeKind = 'issue' | 'plan' | 'part' | 'pr' | 'concern' | 'job' | 'assess';

/**
 * How a PR node's terminal state was learned. `observed` means it was seen in
 * `closedPullRequests`; `inferred` means it left the open set and the window never
 * showed it. The distinction is kept because absence-means-merged is a deliberate
 * fallback, and a durable record has no reason to forget that it *was* one.
 */
export type WorkNodeProvenance = 'observed' | 'inferred';

/**
 * One node of the durable work graph: what the harness did for a work item, and
 * what it descended from. Keyed on the ref vocabulary that already exists
 * (`issue:12`, `issue:12:part:schema`, `pr:41`, `pr:41:ci`) so it joins to every
 * gate, override and proposal without a second naming scheme.
 *
 * `parentRef` follows *work lineage* — a PR's parent is the part that produced it.
 * Stacking is a different relation and lives on `baseRef`, which keeps the graph a
 * tree and stops it lying about what caused the work.
 */
export interface WorkNode {
  ref: string;
  kind: WorkNodeKind;
  parentRef: string | null;
  /** PR nodes only: the PR this one is based on, from `basePrOf`. */
  baseRef: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance: WorkNodeProvenance | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Where a work-item filing sits. Two statuses rather than one because filing is
 * *asynchronous*, the same reason {@link FindingStatus} splits them: the click
 * queues a desk job, and the ticket exists only once that job's agent has created
 * it and called `link_ticket`. `filing` is the honest reading in between, and
 * `filed` is the one that carries {@link WorkItemFiling.ticketRef}.
 */
export type WorkItemFilingStatus = 'filing' | 'filed';

/**
 * A tracker item the operator asked an agent to create for work the harness did
 * that nothing external accounts for — an operator job that produced commits and
 * a PR with no issue anywhere behind it (stage 3 of the work graph).
 *
 * Keyed on the node it is *for*, so one node has at most one filing. Once the ref
 * comes back it becomes that node's `parentRef` — written by the fold, never from
 * here, so the recorder stays the graph's only writer.
 *
 * Deliberately not a {@link Finding}: a finding is an agent's testimony with
 * structural attribution, and this row has no agent behind it to attribute to.
 */
export interface WorkItemFiling {
  /** The unrecorded node this is filing a work item for (`job:job_abc`). */
  targetRef: string;
  /** The desk job doing the filing — how `link_ticket` finds its way back here. */
  jobId: string;
  status: WorkItemFilingStatus;
  /** The tracker item it was filed as (`issue:314`), once the agent reports it. */
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A bug the operator raised against a story from the cockpit, and what became of
 * it. Shares {@link WorkItemFilingStatus} because it is the same asynchrony: the
 * click queues a desk job, and the bug exists only once that job's agent created
 * it and called `link_ticket`.
 *
 * Keyed on {@link BugFiling.jobId} rather than on the story, so one story can
 * carry several bugs over its life — see `src/store/bugFilings.ts` for why that
 * differs from {@link WorkItemFiling}.
 */
export interface BugFiling {
  /** The desk job doing the filing — how `link_ticket` finds its way back here. */
  jobId: string;
  /** The story it was raised from (`issue:12`). */
  originRef: string;
  status: WorkItemFilingStatus;
  /** The bug it was filed as (`issue:314`), once the agent reports it. */
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One node as observed this pulse. Timestamps are the store's to stamp. */
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

/**
 * An operator priority override for the "Up next" queue (issue #128). Keyed on a
 * candidate's stable `origin` so it survives pulses and restarts while the queue
 * itself stays a per-pulse projection. `rank` is ascending — `0` means "do this
 * next" — and only orders *among* overridden origins; a lower rank never
 * un-holds a held item, it only re-orders.
 */
export interface PriorityOverride {
  origin: string;
  rank: number;
}

/**
 * `crashed` is the one status no agent transition writes: it is stamped at boot on
 * a row that still claimed to be live when its process died, and it means only
 * that an operator's recovery verdict is outstanding (see
 * {@link file://./agents/recoveryDesk.ts}). It is deliberately *not* live — a
 * crashed agent stops counting toward the concurrency cap and stops reading as
 * running in the cockpit — and it is not terminal either, since `restore` puts the
 * same row back to `running`.
 */
export type AgentStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'interrupted' | 'failed' | 'crashed';

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
  /**
   * When this agent was last seen *doing work after it parked on a human*, or null
   * if that has not happened since its current park. It exists because the park is
   * only ever a request: the `escalate` tool returns immediately, telling the agent
   * to wait, and a model that carries on regardless leaves the row saying `waiting`
   * with an open alert nobody needs to answer.
   *
   * What counts as work is runtime-specific and narrow — a **tool call**, observed
   * on the legible transcript (see `AgentSession`'s `activity` event). Prose does
   * not count: an agent that escalates and then writes one more sentence before
   * ending its turn is still waiting, and reading that as "resumed" would clear
   * alerts that genuinely need answering.
   *
   * Read as display context, never as a status. Nothing un-parks off it and nothing
   * in the dispatcher reads it — it marks an alert stale so a human can dismiss it
   * with confidence, which is the whole job.
   */
  resumedAt: string | null;
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
 * Where a finding sits: `open` until an operator acts on it, then `promoted`
 * (queued as a job — see {@link Finding.jobId}), `dismissed`, or filed as a
 * ticket in the tracker. Nothing in the dispatcher reads findings; every
 * transition is operator-driven by design (see `src/mcp/findings.ts`).
 *
 * Filing is two statuses rather than one because it is *asynchronous*: the click
 * queues a desk job, and the ticket exists only once that job's agent has
 * created it and called `link_ticket`. `filing` is the honest reading in
 * between — "an agent is filing this" — and `filed` is the one that carries
 * {@link Finding.ticketRef}. Collapsing them would have the card claim a ticket
 * that does not exist yet, and leave nothing to show when the filing agent dies
 * without creating one.
 */
export type FindingStatus = 'open' | 'promoted' | 'dismissed' | 'filing' | 'filed';

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
  /**
   * The claim, on one line. Validation refuses a newline here, which is what
   * keeps the three fields three fields: an agent with more to say has
   * {@link Finding.where} and {@link Finding.detail} to say it in, and a
   * summary that swallowed both is the undifferentiated block this split
   * replaced. Rows filed before the split still hold one — the card clamps
   * rather than pretending they have structure.
   */
  summary: string;
  /**
   * What locates it — file and line, package, service, endpoint. Free text,
   * because "where" means something different per kind and a closed vocabulary
   * would be guessed at. Null when the summary already says it, or when there
   * is nowhere to point.
   */
  where: string | null;
  /**
   * The evidence: the error, the repro, the reasoning. Markdown, rendered as
   * such in the cockpit, so a stack trace lands in a code block instead of the
   * middle of a paragraph. Null when the claim stands on its own.
   */
  detail: string | null;
  status: FindingStatus;
  /**
   * The operator-queued job this became — the one that works it (`promoted`) or
   * the desk job that files it as a ticket (`filing`/`filed`). One field for
   * both because a finding is terminal either way, so only ever one job hangs
   * off it.
   */
  jobId: string | null;
  /**
   * The tracker item this was filed as (`issue:314`), set when the filing agent
   * reports it back through `link_ticket`. Null until then.
   */
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A finding as reported, before the store assigns identity and status. */
export type FindingInput = Pick<Finding, 'kind' | 'ref' | 'summary' | 'where' | 'detail'>;

/**
 * Where a piece of work only a person can do has got to. Two terminals, and both
 * are settlements — there is no way for one to lapse, expire or be deleted.
 *
 * `declined` is not a failure state and not a tidy-up: it is the operator saying
 * *no, and here is why*, which is a fact the plan, the next agent and a later
 * replan all need. A task nobody will ever do that says nothing about why is the
 * shape this repo refuses everywhere else.
 *
 * Clearing a settled row off the bench is {@link HumanTask.dismissedAt}, not a
 * value here: what a person is owed and whether they have finished reading about
 * it are two questions, and one column cannot answer both.
 */
export type HumanTaskStatus = 'open' | 'done' | 'declined';

/**
 * Who a human task is *for the harness*, which is a different question from who
 * asked for it.
 *
 * `ask` is every task a person typed or an agent requested: the harness knows
 * nothing about it beyond the words, and only a person can say it is done.
 * `close_out` is one the harness files itself and can therefore also settle
 * itself — the ticket it names is a thing it watches every pulse.
 *
 * A discriminator rather than a title match. The close-out sweep has to find its
 * own row again on the next pulse, and the alternative is recognising it by the
 * sentence it wrote — parsing prose the harness composed, which is the failure
 * mode `signalPolarity` and the reason plates already refuse.
 */
export type HumanTaskKind = 'ask' | 'close_out';

/**
 * A unit of work only a person can do: flipping a setting in a console nobody
 * gave the fleet an account for, plugging something in, looking at a rendered
 * screen and saying whether it is right.
 *
 * **It is not an {@link Escalation}, and the difference is not a nuance.** An
 * escalation is a *question*: exactly one running agent is blocked on it, holding
 * a slot and a worktree; it is settled by typing an answer into that session, and
 * it dies with the agent. A human task is *work*: no agent is blocked on it, it
 * outlives every agent and every restart, and other work can be made to depend on
 * it. An agent that needs an answer to carry on escalates. An agent that needs a
 * person to *do something* — which may take until Tuesday — requests one of these
 * and gets on with, or concludes, what it can.
 *
 * Attribution is structural on the agent arm, as for a {@link Finding}:
 * `agentId`/`taskId`/`originRef` come from the credential the call arrived on,
 * never from an argument. A null `agentId` means no individual agent asked —
 * either an operator filed it from the cockpit, or a plan declared it as a step,
 * and {@link HumanTask.partId} is what tells those two apart. There is no
 * `requestedBy` column, so nothing can disagree with the ids beside it.
 */
export interface HumanTask {
  id: string;
  /**
   * The ask, on one line. Validation refuses a newline for
   * {@link Finding.summary}'s reason: this string is the headline of a panel row,
   * and the only cheap moment to fix a blob is the requesting agent's own turn.
   */
  title: string;
  /** What to do and how to know it is done. Markdown, rendered as such. Null when the title says it all. */
  detail: string | null;
  /** The work this belongs to — `issue:<n>`, `issue:<n>:part:<slug>`, `pr:<n>` — or null for a standalone ask. */
  originRef: string | null;
  /**
   * The plan part this task *is*, when a planner declared a step for a person
   * (`expectedKind: 'human'`). Null for every other human task.
   *
   * This is the only field through which a human task ever holds work off the
   * fleet, and it is deliberately the only one: the part is the scheduling node
   * that `dependsOn` and the reconciler's readiness pass already understand, so
   * blocking needs no second mechanism beside them. A standalone human task
   * blocks nothing — it is a visible obligation, not a gate.
   */
  partId: string | null;
  /**
   * What kind of obligation this is — see {@link HumanTaskKind}. `ask` for
   * everything a person or an agent filed; `close_out` for the harness's own
   * "the goal is delivered, close its ticket", which it files and settles.
   */
  kind: HumanTaskKind;
  /** The agent that asked for it, from its credential. Null when an operator filed it themselves. */
  agentId: string | null;
  taskId: string | null;
  status: HumanTaskStatus;
  /** The operator's note. Required on `declined`, optional on `done`, null while open. */
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /**
   * When the operator cleared a **settled** row off the bench, or null while it is
   * still on it.
   *
   * Deliberately not a fourth {@link HumanTaskStatus}: a status is the verdict on
   * the work, and "I have read the record of it" is not a third answer to that
   * question — the reconciler asking whether a part was declined must not have to
   * learn a value that says nothing about the part. Only a settled row can carry
   * one, so a dismissal can never lose an obligation; the row itself is kept for
   * the reason a dismissed finding is, and because the close-out sweep finds its
   * own settled row again by looking for it.
   */
  dismissedAt: string | null;
}

/** A human task as requested, before the store assigns identity and status. */
export type HumanTaskInput = Pick<HumanTask, 'title' | 'detail'>;

/**
 * What someone said about whether an issue is finished.
 *
 * `undeclared` is a value, not the absence of one, and that distinction is the
 * whole feature: a work item parked in a review state is genuinely ambiguous —
 * it sits there when work remains *and* when everything is delivered and it is
 * waiting on test — so folding "nobody said" into "not finished" is exactly the
 * assumption that had the harness re-pick merged work. Only
 * {@link IssueConclusionVerdict} is ever stored; `undeclared` is what the
 * resolver returns for a row that doesn't exist.
 */
export type IssueConclusionVerdict = 'done' | 'more_work';

/**
 * Who cast a verdict: the agent that did the work, the assessor that later judged
 * the issue as a whole, or the operator overriding either.
 */
export type ConclusionAuthor = 'agent' | 'assessor' | 'operator';

/**
 * One issue's standing conclusion — the `conclude_work` tool's row, or the
 * operator's override of it.
 *
 * Keyed on the `issue:<n>` origin rather than hung off an agent (the way a
 * `note_progress` note is) because a conclusion belongs to the **issue** and has
 * to outlive every agent that ever touched it — including across a replan, which
 * rewrites the plan row. One row per issue, overwritten per declaration, so the
 * standing verdict is a lookup rather than a fold over history.
 */
export interface IssueConclusion {
  /** The issue, as `issue:<n>` — the same origin every dispatch rule and gate keys on. */
  originRef: string;
  verdict: IssueConclusionVerdict;
  /** What was delivered, or what remains. Required: a bare verdict is not reviewable. */
  note: string;
  by: ConclusionAuthor;
  /** The declaring agent and its task, from the credential. Null for an operator toggle. */
  agentId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A finished goal the operator has kept on the Goal Floor, until they dismiss it
 * (issue #203).
 *
 * The floor is built from the live world, so a completed goal drops off it the
 * moment the tracker stops returning the issue (a human closes the ticket) or its
 * watch tag comes off — and with it the one way in to the run's report. The row is
 * written while the goal is still live, so its `title` survives the world
 * forgetting the issue, and the floor draws a retained completion from it either
 * way until `dismissedAt` is set. Dismissal is one-way and persists across a
 * restart, so the same finished goals do not reappear.
 */
/**
 * How a run ended, stamped at the moment it is dismissed (issue #234): the
 * harness had judged the work, or the operator abandoned it. Derived from the
 * row rather than passed in — a run with a completion instant was judged, one
 * without was abandoned — so the two cannot be claimed independently of the
 * evidence.
 */
export type IssueRunOutcome = 'judged' | 'abandoned';

/**
 * One run of the harness at a goal, from the first pulse that saw work under it
 * to the operator's dismissal (issue #234).
 *
 * A run's life is **not** the tracker's answer. The tracker returns open issues,
 * so a ticket closed by hand — often by the very PR that delivered it — used to
 * take the whole goal out of `ctx.world.issues` mid-workflow, and the assessor
 * and the retrospective that come *after* a merge never ran. The row is minted at
 * pickup and lives until dismissed, which is also what gives an **abandoned**
 * goal something to dismiss: it never completes, so a record minted on completion
 * alone was never written for one.
 *
 * The five snapshot fields are the issue as it last stood while live. They are
 * here because a retained run is dispatched from: `issue-assess` and `issue-retro`
 * interpolate the body into their prompts, and every rule reads the labels through
 * the watch gate — a stub with neither would put an assessor on a goal it cannot
 * read, and hide a retained run from the gate that decides whether the operator
 * still wants it worked.
 */
export interface IssueRun {
  /** The issue, as `issue:<n>` — the same origin every record and gate keys on. */
  originRef: string;
  issueNumber: number;
  /** The goal's title, captured while the issue was still in the world. */
  title: string;
  /** Its description, captured the same way — what the assessor and the retro read. */
  body: string;
  /** Its labels, captured the same way — what every watch/ignore gate reads. */
  labels: string[];
  /** The PR that resolved it, captured the same way. */
  linkedPrNumber: number | null;
  /** The provider's native workflow state, where it has one; null otherwise. */
  workItemState: string | null;
  /** The first pulse the harness saw work under this origin. */
  startedAt: string;
  /** When the goal was first observed complete; frozen. Null while it is not. */
  completedAt: string | null;
  /** How it ended, stamped at dismissal and never before. */
  outcome: IssueRunOutcome | null;
  /** Null until the operator dismisses it — the one thing that ends a run. */
  dismissedAt: string | null;
  updatedAt: string;
}

/** Who decided an issue was delivered: the assessing agent, or the operator directly. */
export type DeliveryAuthor = 'assessor' | 'operator';

/**
 * One issue's standing `delivered` verdict — the harness's own park.
 *
 * Distinct from {@link IssueConclusion}, and deliberately not a third member of
 * {@link IssueConclusionVerdict}, because the two have different lifetimes and
 * different readers. A conclusion is declared once by the agent that did the work
 * and **gates nothing** — rule `work-item-back-to-pickup` is its only consumer. A delivery verdict is
 * re-read by the pickup gate every pulse and stops standing when the world moves
 * (`src/delivery/delivery.ts`). Folding them would give the resolver an expiring
 * member its other two do not have, and would overwrite the working agent's note
 * with the assessor's.
 *
 * They are mutually exclusive: writing either clears the other, in the store, so
 * an issue never carries a conclusion and a delivery that contradict.
 *
 * `delivered` is weaker than the tracker's `closed` and reversible. It says the
 * harness believes it has done what it can, and its only effect is to stop pickup.
 */
export interface IssueDelivery {
  /** The issue, as `issue:<n>` — the same origin the conclusion and every gate keys on. */
  originRef: string;
  /** One line: what was delivered. Required — a bare verdict is not reviewable. */
  summary: string;
  /** The account behind the headline, as markdown. Null when the assessor added none. */
  detail: string | null;
  by: DeliveryAuthor;
  /** The assessing agent and its task, from the credential. Null for an operator verdict. */
  agentId: string | null;
  taskId: string | null;
  /** When the verdict was first cast — the instant world signal is measured against. */
  decidedAt: string;
  updatedAt: string;
}

/**
 * What a goal assay may conclude about an issue's text (issue #158).
 *
 * `workable` is stored as much as `unclear` is, for the reason the planner
 * persists a `single` verdict: without a row for the affirmative the assayer
 * re-runs on the same issue every cycle. Only `unclear` holds anything.
 *
 * There is deliberately no third "not assayed" member — that is the absence of a
 * row, which is what makes a crashed assayer fail open (see `src/intake/assay.ts`).
 */
export type GoalAssayVerdict = 'workable' | 'unclear';

/** Who judged an issue's goal text: the assaying agent, or the operator directly. */
export type AssayAuthor = 'assayer' | 'operator';

/**
 * One issue's standing goal assay — the answer to "is this ticket workable", cast
 * *before* anything is dispatched against it.
 *
 * Sibling of {@link IssueDelivery} and split from it for the reason that one is
 * split from {@link IssueConclusion}: the two verdicts are about opposite ends of
 * the same issue. A delivery says the work is *finished*; an assay says the goal
 * could not be *started* from. They can be true at different times about one
 * issue, so they are two rows, and neither clears the other.
 *
 * The distinguishing field is {@link goalRef}: an assay judges a *text*, not a
 * state of the world, so the verdict is bound to the exact text it judged. Change
 * the title or the body and the verdict no longer describes the ticket in front of
 * you, which is what makes "re-assay when it is edited" a lookup rather than an
 * event the harness has to have witnessed.
 */
export interface IssueAssay {
  /** The issue, as `issue:<n>` — the same origin every gate keys on. */
  originRef: string;
  verdict: GoalAssayVerdict;
  /** What is missing, or why the goal is actionable. Required: a bare verdict is not reviewable. */
  summary: string;
  /**
   * A fingerprint of the goal text this verdict was cast against (see
   * `goalFingerprint`). The hold ends the instant the issue's current text
   * fingerprints differently — no timer, and no world event to have missed.
   */
  goalRef: string;
  by: AssayAuthor;
  /** The assaying agent and its task, from the credential. Null for an operator verdict. */
  agentId: string | null;
  taskId: string | null;
  /** The provider's id for the one comment this verdict maintains on the ticket, once written. */
  commentRef: string | null;
  /** When the verdict was first cast — the instant world signal is measured against. */
  decidedAt: string;
  updatedAt: string;
}

/**
 * One entry on an issue's shared scratchpad — what an agent working the goal left
 * for whoever works it next, and for the retrospective at the end.
 *
 * Append-only: there is no update and no delete anywhere above this type. The pad
 * is a trail, and a retrospective reads *when* something was learned as much as
 * what.
 */
export interface ScratchEntry {
  id: string;
  /** The pad, always an `issue:<n>` ref — see `padOriginFor`. */
  padRef: string;
  /** The origin of the agent that wrote it: a part, the planner, the assessor. */
  authorOriginRef: string;
  /** Attribution, taken from the credential rather than from an argument. */
  agentId: string;
  taskId: string;
  /** An optional scannable tag the author chose. */
  topic: string | null;
  note: string;
  createdAt: string;
}

/**
 * What a pad amounts to without reading it: how much was written, and when the
 * last entry landed.
 *
 * The reading rather than the trail, for the retrospective's reason exactly — the
 * snapshot is polled continuously, and a goal's pad is unbounded prose, so what
 * rides on every poll is only what a control needs to know there is something to
 * open. The entries themselves are fetched when a reader opens them.
 */
export interface ScratchPadSummary {
  padRef: string;
  entries: number;
  /** The newest entry's timestamp — the pad is append-only, so this is its age. */
  updatedAt: string;
}

/**
 * One goal's retrospective: what shipped, and how the run went.
 *
 * Nothing gates on it — a goal is delivered whether or not anybody wrote it up —
 * which is what makes a missing one silence rather than a hold, and what makes the
 * rule that produces it safe to fail open.
 */
export interface Retrospective {
  /** The issue it is about, `issue:<n>` — the same key every other verdict uses. */
  originRef: string;
  /** One or two sentences: what an operator reads before opening the document. */
  summary: string;
  /** The write-up, markdown. Trimmed at submission rather than refused. */
  document: string;
  /** The writing agent and its task, from the credential. */
  agentId: string;
  taskId: string;
  /** When the run was *first* written up; preserved across a revision. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Which of the three failures an assessor's "not delivered" actually is (issue
 * #159).
 *
 * They wear one face — the issue was worked and the goal is not reached — and
 * they want three different things done, so the cause is **declared** by the
 * assessor rather than derived by the harness. Deriving "the plan was wrong" from
 * the fact that something is missing would route every shortfall to a replan, and
 * re-decompose plans whose shape was never the problem: the issue's own point 2.
 *
 * - `plan` — the decomposition was wrong: a part is missing, or the split is. The
 *   whole plan goes back to a planner.
 * - `part` — the split was right and one named part did not deliver its scope. A
 *   follow-up part is appended; the plan is not re-derived.
 * - `goal` — the issue itself is wrong, ambiguous or obsolete. Nothing is
 *   dispatched: that is #158's question, and this arm exists to stop pretending
 *   the planner can answer it.
 *
 * **No cause is a fourth answer, and it is never one of these three.** An issue
 * with no plan has no decomposition to be wrong about, so the honest reading of a
 * negative assessment there is usually just "the work is not finished" — which
 * names nothing to route and wants nothing done beyond what `more_work` already
 * did: the issue comes back round. That is the absence of a value, not a member,
 * for `undeclared`'s reason — folding it into `goal` would file an escalation
 * claiming the ticket is wrong every time an unplanned issue fell short, which is
 * inferring a route from silence.
 */
export type ShortfallCause = 'plan' | 'part' | 'goal';

/** Who judged that an issue fell short: the assessing agent, or the operator directly. */
export type ShortfallAuthor = 'assessor' | 'operator';

/**
 * One issue's standing "worked, and the goal is not reached" verdict — the
 * negative mirror of {@link IssueDelivery}.
 *
 * A **separate table** rather than a polarity column on the delivery row, and the
 * reason is the polarity itself. Every reader of `issue_deliveries` is a *gate*:
 * `deliveryHold` is asked by rule `issue-pickup`'s filter and by `issuePickupStatus`, each
 * pulse, and it holds pickup off. A shortfall must gate **nothing** — releasing
 * work is the entire point — so putting the two in one table would leave every
 * present and future reader having to remember which polarity it is holding, from
 * a row that looks identical until you read a column. That is the drift class this
 * repo has already paid for twice (`proposalHold` vs `planProposalHold`, detection
 * vs stripping in the PTY scanner), and both times the fix was to keep the two
 * predicates apart rather than give one a flag.
 *
 * It is also **not** an {@link IssueConclusion}. That row is the working agent's
 * own declaration about its own run, keyed `origin_ref PRIMARY KEY` — so an
 * assessor writing `more_work` into it overwrote the agent's note, its author and
 * its timestamp, with no precedence between two parties the resolver could not
 * tell apart. The assessor writes here instead, and `resolveIssueConclusion` reads
 * both, ranking this one higher because the assessor is later and better informed
 * than the agent that declared its own work.
 *
 * Mutually exclusive with a delivery — writing either clears the other, in the
 * store — for the reason a delivery and a conclusion are: they are two answers to
 * one question, so one must win, and a caller that remembered one and forgot the
 * other would leave the pickup gate holding an issue this row is trying to release.
 */
export interface IssueShortfall {
  /** The issue, as `issue:<n>` — the same origin every gate and verdict keys on. */
  originRef: string;
  /** What fell short — or null when there was nothing to name (see {@link ShortfallCause}). */
  cause: ShortfallCause | null;
  /** The part that fell short. Only ever set for `cause: 'part'`. */
  partSlug: string | null;
  /** One line: what is missing. Required — it becomes the next agent's starting point. */
  summary: string;
  /** The evidence behind the headline, as markdown. Null when the assessor added none. */
  detail: string | null;
  by: ShortfallAuthor;
  /** The assessing agent and its task, from the credential. Null for an operator verdict. */
  agentId: string | null;
  taskId: string | null;
  /** When the verdict was first cast. */
  decidedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Plans (the multi-PR issue funnel)
// ---------------------------------------------------------------------------

/**
 * Where a plan sits in its life — and **only** that. How the issue is being
 * delivered (one pull request, or several) is not a status: it is read off the
 * live parts, by `planShape`. The two were one field until a `single` status
 * meant a plan could not also be *running*, and every consumer that switched on
 * status had to know the shape — including the ones that forgot, which is how a
 * single-PR issue silently stopped being reconciled and never posted its status
 * comment.
 *
 * - `planning` — a verdict is still being worked out (a replan in flight).
 * - `awaiting_approval` — the planner has spoken and `planning.requireApproval` is
 *   on, so a human has been asked to authorize the verdict (issue #109 phase 3) —
 *   a decomposition, or the decision to work the issue as one PR. Nothing is
 *   scheduled from it: this status *is* the gate, which is why release is a
 *   one-way move rather than a verdict re-read every pulse. It releases to
 *   `active` on either arm.
 * - `active`   — being delivered. With live parts that is a decomposition with at
 *   least one part outstanding; with none, it is the single-PR arm, worked whole
 *   by rule `issue-pickup`.
 * - `complete` — every part settled. A single-PR plan does not reach it: what
 *   finishes that arm is the issue's own delivery, which the plan does not own.
 * - `abandoned`— the operator gave up on the decomposition.
 */
export type PlanStatus = 'planning' | 'awaiting_approval' | 'active' | 'complete' | 'abandoned';

/**
 * One issue's delivery plan — the planning agent's verdict, persisted so the
 * planner never re-runs on the same issue. Written for *both* outcomes: a
 * single-PR plan is a first-class row with no parts, which is what turns today's
 * one-agent / one-PR path into an explicit outcome of the funnel rather than a
 * bypass.
 */
export interface Plan {
  id: string;
  /** The issue this plan belongs to, in the world's ref shape: `issue:12`. */
  originRef: string;
  title: string;
  status: PlanStatus;
  /** The planner's own justification for its verdict. Null when it gave none. */
  reason: string | null;
  /** What could go wrong with this split, as the planner saw it. Null when it said nothing. */
  risks: string | null;
  /** What the planner deliberately left out. */
  outOfScope: string | null;
  /** The full narrative, markdown — the read-in-depth version of this plan. */
  document: string | null;
  /** True while an operator is discussing this plan with an agent (see rule `issue-plan`). */
  discussing: boolean;
  /** Provider comment id for the plan's status comment, edited in place (stage 3). */
  statusCommentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where one part of a multi-PR plan sits: `pending` (dependencies outstanding),
 * `ready` (dispatchable), `dispatched` (an agent is on it), `in_review` (its PR
 * is open), `merged`, `concluded` (it finished without a pull request — a report
 * or a determination), `blocked`, or `retired` — a part an amended plan no longer
 * declares. Retiring is a *status transition, not a disappearance*: the row stays
 * so the graph remains readable after a replan, and nothing schedules it again.
 *
 * `merged` and `concluded` are both terminals, and `concluded` is not a kind of
 * retirement: retired means "dropped before anything was started", which
 * `partHasWork` enforces, whereas a concluded part did its work and found there
 * was nothing to build. Ask `partSettled` rather than comparing to `merged`, so
 * the sites that mean "finished" cannot drift apart.
 */
type PlanPartStatus = 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'concluded' | 'blocked' | 'retired';

/**
 * What a part produces. `code` ends in a merged pull request, which the world
 * observes; `report` and `determination` end in a record already durable in the
 * store the moment the agent writes it — which is why the plan reconciler's fold
 * differs by kind, and why only those two are declarable through `conclude_part`.
 *
 * `human` is the fourth and the only one no agent ever produces: the part is work
 * a person does by hand, backed by a {@link HumanTask} row, and it is settled by
 * an operator marking that task done. It is a kind rather than a flag beside the
 * kinds because every consumer that already asks "what did this part produce"
 * — the plan comment, the modal, the floor, the retro dossier — then reads it for
 * free, and because collapsing it into `determination` would lose the one fact
 * worth keeping: that the thing which finished this part was a human.
 */
export type PartOutcomeKind = 'code' | 'report' | 'determination' | 'human';

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
  /** Why this is its own PR rather than folded into a sibling. */
  rationale: string | null;
  /** What makes this part done. */
  acceptance: string | null;
  /** What the planner expected this part to produce. Null means unstated, which reads as `code`. */
  expectedKind: PartOutcomeKind | null;
  /** What it actually produced, written when it concludes. Null until then; a merged part derives `code`. */
  outcomeKind: PartOutcomeKind | null;
  /** Optional evidence for a concluded part — `flag:<id>` or `finding:<id>`. */
  outcomeRef: string | null;
  /** What the concluding agent said it found. Required at close, so never empty on a concluded part. */
  outcomeSummary: string | null;
  /** Sibling slugs this part needs first: one to stack on it, several to rejoin them. */
  dependsOn: string[];
  branch: string | null;
  prNumber: number | null;
  status: PlanPartStatus;
  /**
   * Why this part is `blocked`, written by the reconciler with the status and
   * cleared with it. Null on every other status — a blocked part is the one that
   * has a reason nothing else in the world can be read for, since it has no
   * branch, no PR and no agent to explain it.
   */
  blockedReason: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A part as the planner declared it, before the store assigns identity or progress. */
export type PlanPartInput = Pick<
  PlanPart,
  'slug' | 'seq' | 'title' | 'scope' | 'dependsOn' | 'rationale' | 'acceptance' | 'expectedKind'
>;

/** One cumulative usage report from a session's turn-end `result` event. */
export interface AgentUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/**
 * One timestamped cost delta — the row `recordAgentUsage` appends beside the
 * cumulative figure it folds onto the agent.
 *
 * The deltas are what make cost answerable as a question about *time*: an agent
 * row says what a run came to and never when the money went, so a rolling window
 * or a trend can only be read off these. `sumUsageCostSince` is the total over a
 * window; this is the same rows, unaggregated, for a reader that needs the shape
 * rather than the sum.
 */
export interface UsageEvent {
  agentId: string;
  costUsd: number;
  at: string;
}

/**
 * What one goal has cost so far: every agent the harness put on the issue, summed.
 *
 * The unit is the **issue**, because that is the unit the operator budgets in and
 * the one thing the tracker names. Everything downstream of it — the planner, the
 * assay, each part, and the pull requests those parts opened — is spend on that
 * goal, so it rolls up rather than being counted as work of its own.
 *
 * A running figure, never a final one: `costUsd` is summed from the cumulative
 * report on each `agents` row, so it climbs while an agent is still working and
 * stops when the last one ends.
 */
export interface IssueSpend {
  /** `issue:<n>` — the same key every other per-issue record is stored under. */
  originRef: string;
  issueNumber: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** How many agent runs the totals are over. Never 0 — no agents, no row. */
  agents: number;
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
  /**
   * When the agent needs several things settled: one entry per question, each
   * with its own options and its own answer box. `question` stays the headline —
   * what the inbox row shows — and this is the questionnaire behind it, which the
   * cockpit opens in a modal rather than unpacking into the panel.
   */
  questions?: AgentAskQuestion[];
}

/** One question of an {@link AgentAsk}'s questionnaire — the whole ask, in miniature. */
export interface AgentAskQuestion {
  /** What this one asks. */
  question: string;
  /** Background for this question alone. Markdown, like {@link AgentAsk.detail}. */
  detail?: string;
  /** Concrete answers; clicking one fills this question's box rather than sending. */
  options?: string[];
}

type EscalationStatus = 'open' | 'answered' | 'dismissed';

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
  /**
   * The questionnaire an agent raised through `escalate` — see
   * {@link AgentAsk.questions}. Its presence is what makes the card open a modal
   * instead of offering one box, and what lets `/answer` take positional answers.
   */
  questions?: AgentAskQuestion[];
  // -- reply_on_pr / merge_pr escalations --------------------------------
  prNumber?: number;
  commentId?: string | null;
  draft?: string;
  confidence?: number;
  method?: string;
  autoSendFailed?: boolean;
  autoMergeFailed?: boolean;
  // -- propose_plan escalations -------------------------------------------
  /** The plan whose decomposition this item asks you to authorize (issue #109 phase 3). */
  planId?: string;
  // -- grant_permission escalations (issue #130 phase B) ------------------
  /**
   * Set when this escalation is a live permission request: an agent's tool call
   * fell through the allow-list, and it is blocked inside a `--permission-prompt-tool`
   * call until the operator allows or denies. Its presence is what marks the card
   * un-answerable by the ordinary free-text route (answering would type into a
   * session that is blocked in a tool call, not parked at a prompt); it is settled
   * through `POST /api/escalations/:id/permission` instead.
   */
  permission?: PermissionRequest;
  [key: string]: unknown;
}

/** The tool call an agent is blocked on, awaiting the operator's allow/deny (issue #130). */
interface PermissionRequest {
  /** The tool Claude Code asked permission for, e.g. `Bash`. */
  toolName: string;
  /** A one-line, human-readable rendering of what it wants to do (the Bash command, …). */
  summary: string;
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
 * What a human is being asked to authorize. Two of them are acts the auto-send
 * gate refuses to perform on its own (issue #109 phase 1): a drafted PR reply and
 * a merge. The third, `plan`, is the odd one and deliberately so — it publishes
 * nothing. Accepting it *releases a rule*: a decomposition of an issue into
 * stacked PRs stays unscheduled until a human says yes (phase 3).
 *
 * `shortfall` is the fourth and publishes nothing either (issue #159): accepting
 * it acts on an assessor's "this was worked and the goal is not reached" — sending
 * the plan back to a planner, or appending a follow-up part. It is a proposal
 * rather than an automatic action because both arms spend a fleet, and a plan the
 * harness rewrote on its own would churn `plan_parts` under whatever is running.
 */
export type ProposalKind = 'reply_draft' | 'merge' | 'plan' | 'shortfall';

/** One-way: a proposal leaves `pending` exactly once, in one of two directions. */
type ProposalStatus = 'pending' | 'accepted' | 'rejected';

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
  /**
   * Who decided. `human` is a click in the cockpit; `auto_send` is the harness
   * accepting its own proposal because the confidence gate cleared it (phase 2) —
   * one authorization representation rather than two, so the audit log answers
   * "who authorized this outbound act" the same way for both.
   *
   * `stack_landing` is the third, and it is a third rather than a reuse of
   * `auto_send` because it answers the question differently: not "the harness
   * cleared its own threshold" but "the operator authorized this whole chain in
   * advance, before any of it was proposed". Folding it into `auto_send` would
   * put a merge nobody's confidence gate ever judged under the gate's name.
   */
  decidedBy: 'human' | 'auto_send' | 'stack_landing' | null;
  decidedAt: string | null;
  /** The inbox item this hangs off, so answering and deciding stay one surface. */
  escalationId: string | null;
  createdAt: string;
}

/**
 * Where a standing intent ends up. Only `standing` authorizes anything; the
 * other three are terminal, and they are three rather than one because "it
 * finished", "you called it off" and "something went wrong" are different
 * answers to *why is this chain not landing*, and only the last needs surfacing.
 */
export type StackLandingStatus = 'standing' | 'landed' | 'stopped' | 'revoked';

/**
 * An operator's standing authorization to land a whole stack of pull requests —
 * one click that keeps saying yes to each rung's merge as the harness proposes
 * it, cycle after cycle.
 *
 * **It is not a merge, and it schedules none.** Rule `pr-merge-ready` already
 * proposes exactly one merge per stack — the bottom rung, the only one whose base
 * is the integration branch — and the rung above it becomes proposable only once
 * that lands and the provider retargets it, which is observed on a later pulse.
 * So a chain landing bottom-up over several cycles is what the harness does
 * anyway; this record only decides who accepts those proposals. A merge still
 * happens exactly one way, through `ActionExecutor.runAuthorized`.
 *
 * **Its scope is {@link rungs}, not {@link ref}.** `Stack.ref` is
 * `stack:<bottom rung's PR number>` and the bottom rung is precisely the one that
 * merges first, so the ref is stable only until the intent's first success. An
 * intent keyed on it would land one rung and then be orphaned — silently, which
 * is the whole failure this feature exists to avoid. Keying on the PR numbers
 * captured at the click also makes the authorization exactly what the operator
 * read: a rung stacked *on top* afterwards is not in the list, so it is not
 * authorized, with no rule needed to say so.
 */
export interface StackLanding {
  id: string;
  /** The stack's ref as it read at the click. Display and idempotence only. */
  ref: string;
  /** The authorization: the rungs' PR numbers, bottom-first, as they stood then. */
  rungs: number[];
  status: StackLandingStatus;
  /** Why it stopped, in the words the rack chip and the escalation both quote. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Dispatcher output — the bounded action vocabulary
// ---------------------------------------------------------------------------

type ActionType =
  | 'dispatch_code_agent'
  | 'dispatch_desk_agent'
  | 'escalate_to_human'
  | 'respond_to_agent'
  | 'reply_on_pr'
  | 'merge_pr'
  | 'propose_plan'
  | 'propose_shortfall'
  | 'set_work_item_state'
  | 'no_op';

/** One decision from the dispatcher. Every action carries a reason for the audit log. */
export interface Action {
  type: ActionType;
  reason: string;
  /** The dispatcher rule that produced this action (a `DISPATCH_RULES` id), when one did. */
  rule?: string | null;
  /**
   * What became of that proposal, when an admission transformed it (an
   * `admission`-kind `DISPATCH_RULES` id). Null for a proposal admitted
   * unchanged — see `decisions.admission`.
   */
  admission?: string | null;
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
   * The dispatcher rule that **proposed** the action, lifted off it at record
   * time so the audit log can answer "which rule fired" first-class. Null for
   * decisions with no rule identity (lifecycle bookkeeping, human-authorized acts) —
   * and for the one action with no single proposer, the branch note (see
   * `admission`).
   */
  rule: string | null;
  /**
   * What **became** of that proposal, when an admission transformed it rather
   * than letting it through: `cooldown-escalate` (the attempt cap turned a
   * dispatch into an escalation) or `branch-notify` (a fresh signal was
   * delivered to the agent already on the branch). Null for the ordinary case.
   *
   * The two columns are not fallbacks for each other. A row written before this
   * column existed carries the *outcome* in `rule` and `admission: null`, and
   * which rule was throttled on one is unrecoverable — the renderers say which
   * shape they are looking at rather than guessing.
   */
  admission: string | null;
  createdAt: string;
}
