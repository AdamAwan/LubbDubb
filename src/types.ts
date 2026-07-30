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
   * Reported for visibility only: `classifyCiFailures` never classifies it and
   * `ciNeedsAttention` never counts it, so it cannot dispatch an agent, escalate,
   * or be muted by a `ci.checks` rule.
   *
   * The Azure comment policy's mode. Surfacing it as an ordinary check would let
   * rule 1 outrank rule 2b and send the generic CI-fix prompt in place of one
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

type StoryState = 'ready' | 'in_progress' | 'blocked' | 'done';

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
  /** The task this job was dispatched as, once it has been. Null while queued. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
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
  summary: string;
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
export type FindingInput = Pick<Finding, 'kind' | 'ref' | 'summary'>;

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

/** Who decided an issue was delivered: the assessing agent, or the operator directly. */
export type DeliveryAuthor = 'assessor' | 'operator';

/**
 * One issue's standing `delivered` verdict — the harness's own park.
 *
 * Distinct from {@link IssueConclusion}, and deliberately not a third member of
 * {@link IssueConclusionVerdict}, because the two have different lifetimes and
 * different readers. A conclusion is declared once by the agent that did the work
 * and **gates nothing** — rule 3b is its only consumer. A delivery verdict is
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
  /** What was delivered, and on what evidence. Required: a bare verdict is not reviewable. */
  summary: string;
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
 * `deliveryHold` is asked by rule 4's filter and by `issuePickupStatus`, each
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
  /** What is missing. Required: it becomes the next agent's starting point. */
  summary: string;
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
 * Where a plan sits in its life:
 * - `planning` — a verdict is still being worked out (a replan in flight).
 * - `single`   — the planner said one PR; the issue falls through to normal pickup.
 * - `awaiting_approval` — decomposed, and `planning.requireApproval` is on, so a
 *   human has been asked to authorize the decomposition (issue #109 phase 3).
 *   Nothing is scheduled from it: this status *is* the gate, which is why release
 *   is a one-way move to `active` rather than a verdict re-read every pulse.
 * - `active`   — decomposed into parts, at least one still outstanding.
 * - `complete` — every part merged.
 * - `abandoned`— the operator gave up on the decomposition.
 */
export type PlanStatus = 'planning' | 'single' | 'awaiting_approval' | 'active' | 'complete' | 'abandoned';

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
  /** What could go wrong with this split, as the planner saw it. Null when it said nothing. */
  risks: string | null;
  /** What the planner deliberately left out. */
  outOfScope: string | null;
  /** The full narrative, markdown — the read-in-depth version of this plan. */
  document: string | null;
  /** True while an operator is discussing this plan with an agent (see rule 3c). */
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
 * observes; the other two end in a record already durable in the store the moment
 * the agent writes it — which is why the plan reconciler's fold differs by kind,
 * and why only these two are declarable through `conclude_part`.
 */
export type PartOutcomeKind = 'code' | 'report' | 'determination';

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
   */
  decidedBy: 'human' | 'auto_send' | null;
  decidedAt: string | null;
  /** The inbox item this hangs off, so answering and deciding stay one surface. */
  escalationId: string | null;
  createdAt: string;
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
