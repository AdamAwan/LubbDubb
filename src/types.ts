/**
 * Shared domain types for the LubbDubb harness.
 *
 * These are the vocabulary the whole system speaks: the world snapshot the
 * connector produces, the tasks/agents/escalations the harness tracks, and the
 * bounded action plan the dispatcher emits.
 */

import type { PlaceKey, UsageArrival, UsageSubject, UsageVerb } from './usage/events.js';

// ---------------------------------------------------------------------------
// World snapshot (produced by a Connector)
// ---------------------------------------------------------------------------

export type CiStatus = 'passing' | 'failing' | 'pending' | 'unknown';

/**
 * One CI check as its provider names it — a GitHub check-run or commit status
 * context, an Azure blocking policy. {@link CiStatus} is the fold of these;
 * this is the per-check detail, kept so policy can act on which check went red.
 * Never `unknown`: an unreported check is `pending`, and a check with no signal at all is not in the list.
 */
export interface CiCheck {
  name: string;
  status: Exclude<CiStatus, 'unknown'>;
  /**
   * False when the provider says this check does not block completion (an Azure
   * "Optional" branch policy). Absent means blocking. Display/briefing only — nothing gates on it.
   */
  blocking?: boolean;
  /**
   * Other names the provider shows for this same check; a `ci.checks` glob matches an alias exactly
   * as it matches {@link name}. Exists for Azure status policies, which are keyed by
   * `statusGenre/statusName` rather than the display name the PR page shows.
   */
  aliases?: string[];
  /**
   * The Azure comment policy's mode, reported for visibility only: `classifyCiFailures` never
   * classifies it and `ciNeedsAttention` never counts it, so it cannot dispatch, escalate, or be
   * muted by a `ci.checks` rule. Keeps rule `pr-ci-failing` from outranking `pr-review-comment`.
   */
  advisory?: boolean;
  /**
   * The check is `pending` with nothing in flight — its last run is stale against the branch's
   * current commits and needs a fresh queue. Only set alongside `status: 'pending'`; absent means
   * the provider doesn't report the distinction. Exists for Azure build-validation policies, whose
   * `queued`+`isExpired` state is otherwise indistinguishable from a running build.
   */
  expired?: boolean;
  /**
   * How the provider that reported this check finds its failure output — a GitHub check-run id, an
   * Azure build id. Opaque above the integration that wrote it: nothing outside
   * `src/integrations/<provider>/` parses or renders it, only that provider's
   * {@link CiEvidenceCapable} read. Absent means nothing to fetch.
   */
  evidenceRef?: string;
  /**
   * How the provider that reported this check queues a fresh run of it — an Azure
   * policy-evaluation id. Opaque above the integration that wrote it, like {@link evidenceRef}.
   * Only ever set alongside {@link expired}; absent means the harness cannot requeue it itself.
   */
  requeueRef?: string;
}

/** GitHub's `mergeable_state`, normalised to the values the harness reacts to. */
export type MergeableState = 'dirty' | 'behind' | 'blocked' | 'clean' | 'unknown';

/**
 * Where a pull request sits: still open, merged, or closed without merging. Absent on a PR
 * predating closed-PR visibility — read it through `prState` in `prHealth.ts`, which folds a
 * missing value back onto the {@link PullRequest.merged} flag.
 */
export type PrState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  ciStatus: CiStatus;
  /**
   * The individual checks {@link ciStatus} folds. Absent when the provider (or a pre-existing
   * row) reports no per-check detail; CI policy then acts on the aggregate generically.
   */
  ciChecks?: CiCheck[];
  /**
   * The provider had per-check detail and was configured not to emit it (an `off` policy mode) —
   * distinct from an empty {@link ciChecks}, which means unreported. Withheld must not be read as
   * unreported: that would make `off` dispatch on every red PR with no check to name.
   * → `docs/spec/02-configuration.md#azuredevopspolicychecks`
   */
  ciChecksWithheld?: boolean;
  /** Unresolved review comments waiting on the author. */
  unresolvedComments: PrComment[];
  /**
   * The same threads with replies and state kept, for surfaces that show a person the review —
   * {@link unresolvedComments} is what dispatch rules read. Absent means the provider does not
   * report threads. → `docs/spec/07-pull-requests.md#review-threads`
   */
  reviewThreads?: PrReviewThread[];
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
   * Open / merged / closed-unmerged. Absent means the provider only reports open PRs, which
   * `prState` reads back as open-or-merged from {@link merged}; this field is what tells a merge
   * apart from an abandoned PR.
   */
  state?: PrState;
  /** When the PR left the open set (ISO). Only set on a closed/merged PR. */
  closedAt?: string;
  /**
   * The commit the merge produced on the base branch. Only set on a merged PR, by a provider that
   * reports it. Read once into a {@link GoalLanding} because git cannot recover it — a squash
   * merge leaves no ancestry link to the base. → `docs/spec/24-environments.md#recording-a-landing`
   */
  mergeCommitSha?: string;
  /**
   * The commit the checks on this pull request ran against — GitHub's `head.sha`, Azure's
   * `lastMergeSourceCommit`. The one signal that distinguishes a fixed check from a flaked one;
   * absent means the harness cannot say and must not guess a flake.
   */
  headSha?: string;
  /**
   * Labels/tags on the PR. Drives the provider-agnostic exclusion gate: a PR carrying
   * `config.prExclusionLabel` is left alone by the dispatcher. Absent means treat as `[]`.
   */
  labels?: string[];
  /**
   * That a person put this pull request on you, and how — resolved by the provider against
   * `config.userId`. A court input (`src/prAttention.ts`), not a dispatch one: no rule acts on it.
   * Absent means the provider does not resolve it, indistinguishable from nothing assigned — a
   * provider that cannot answer costs the operator this feature silently, as
   * {@link Issue.labelsAddedByViewer} costs pickup.
   * → `docs/spec/07-pull-requests.md#a-pull-request-a-person-put-on-you`
   */
  viewerAssignment?: ViewerAssignment;
  /**
   * Who opened the pull request, as the provider names them to a person — Azure's `displayName`,
   * GitHub's login. Used only to show who asked for a review; nothing dispatches on it. Absent
   * means the provider does not report it — the sentence drops the name rather than inventing one.
   * → `docs/spec/07-pull-requests.md#a-pull-request-a-person-put-on-you`
   */
  author?: string;
  /**
   * That the credential the harness posts under opened this pull request — resolved against the
   * viewer identity the token is, never against `filters.prAuthor` (a fetch filter). Keeps the
   * fleet off a colleague's work; `ownWorkOnly` widens the fetch via {@link viewerAssignment}, so
   * "in the world" stopped meaning "ours". Absent means the provider cannot say; only `false` is a
   * positive statement that takes a PR out of the dispatch world.
   * → `docs/spec/07-pull-requests.md#whose-pull-request-is-it`
   */
  viewerAuthored?: boolean;
  /**
   * That you personally gave this pull request an approving verdict — your own vote, never the
   * fold in {@link approved} (any reviewer's). Ends an assignment: without it, a review request a
   * colleague raised stays on the rail forever. Absent is never read as a verdict — silence leaves
   * the row where it was. → `docs/spec/07-pull-requests.md#when-the-assignment-ends`
   */
  viewerApproved?: boolean;
  url?: string;
}

/**
 * How a pull request came to be yours. Three values because providers mean different things by
 * it: GitHub has one `assignees` list, Azure has `required`/`optional` reviewers, and those two
 * are not the same obligation. A group the operator belongs to is never one of these on either
 * provider — folding it in would fill the queue with every open PR in the org.
 */
export type ViewerAssignment = 'assignee' | 'reviewer-required' | 'reviewer-optional';

export interface PrComment {
  id: string;
  author: string;
  body: string;
  /** True once the harness has handled (drafted a reply / fixed) this comment. */
  handled: boolean;
  /**
   * The replies under the root, oldest first — the rest of the conversation, carried alongside
   * {@link PrReviewThread}. `body` is only the root; a reviewer's follow-up narrowing the finding
   * must reach the agent too, so this must not be dropped on the way to the prompt. Absent (never
   * empty) on a thread nobody replied to. → `docs/spec/07-pull-requests.md#the-thread-is-the-conversation`
   */
  replies?: PrThreadMessage[];
}

/**
 * Where a review thread stands — the three-way answer the fleet acts on, said out loud instead of
 * folded into {@link PrComment.handled}, which conflates "reviewer closed it" (finished) with
 * "fleet answered it" (waiting on the reviewer). `reopened` is the operator's own verdict,
 * outranking the provider's, and reads like an unanswered thread. → `docs/spec/07-pull-requests.md#review-threads`
 */
export type PrThreadState = 'open' | 'answered' | 'resolved' | 'reopened';

/** One message in a review thread — the root, or a reply under it. */
export interface PrThreadMessage {
  id: string;
  author: string;
  body: string;
  /** The harness wrote this one, resolved by the provider against `config.userId`. */
  ours: boolean;
}

/**
 * A review thread as the world carries it: the conversation, and where it stands. Kept beside
 * {@link PullRequest.unresolvedComments} deliberately — that list is what dispatch rules read
 * (`handled` folding the four {@link PrThreadState} values into one bit); this is the same threads
 * with replies and state, for surfaces that show a person the review. Absent when the provider
 * cannot report threads. → `docs/spec/07-pull-requests.md#review-threads`
 */
export interface PrReviewThread {
  /** The thread's id — the same id the matching {@link PrComment} carries, and the one a reply threads under. */
  id: string;
  author: string;
  body: string;
  state: PrThreadState;
  /** The replies under the root, oldest first. Empty on a thread nobody answered. */
  replies: PrThreadMessage[];
  /** The file the thread hangs on, where the provider reports one. Absent on a summary comment or an unreporting provider. */
  path?: string;
  /** The line in {@link path} the thread was left on, where the provider reports one. */
  line?: number;
  /**
   * When the operator reopened it (ISO). Only set on a `reopened` thread — distinguishes a reopen
   * from a thread nobody has answered yet, which otherwise read identically to the dispatcher.
   */
  reopenedAt?: string;
  /**
   * The provider's own key/value bag on the thread, flattened to strings, where it has one (Azure
   * DevOps does, GitHub does not). Lets the harness recognise a thread its own toolchain opened via
   * a stamped key (`review.publishedThreadProperty`), the second arm of {@link PrReviewState.addressed}.
   * Absent, never empty, on a thread carrying none. → `docs/spec/07-pull-requests.md#a-thread-the-harness-stamped`
   */
  properties?: Readonly<Record<string, string>>;
}

/**
 * What the fleet's own reviewer said about a diff — `clear` when it found nothing worth a
 * person's attention, `findings` when it did. No severity ladder: the verdict gates nothing by
 * itself (see `reviewSatisfied`); detail lives in `summary` and `findings`.
 */
export type PrReviewVerdict = 'clear' | 'findings';

/**
 * One recorded fleet review — the harness's own record, written by the `review_report` tool and
 * never inferred from a provider comment. Keyed on the pull request, not the commit it read (the
 * review runs once); `headSha` is display-only. → `docs/spec/07-pull-requests.md#the-fleet-review`
 */
export interface PrReview {
  prNumber: number;
  /** The commit the reviewer read, where the provider reported one. Display only. */
  headSha: string | null;
  verdict: PrReviewVerdict;
  /** One sentence: what this diff does, as the reviewer understood it. */
  summary: string;
  /** What it found, one entry each. Empty on a `clear` verdict. */
  findings: string[];
  /** The agent that reported it, so the run behind a verdict is reachable. */
  agentId: string | null;
  reviewedAt: string;
  /**
   * The provider's id for the review thread the findings were published into, where the harness
   * sent one and the provider named it. Null when `review.publish` is off, the provider's PR
   * comments aren't threads (GitHub's are not), the send returned no id, or the row predates this
   * column. A record of what went out, never inferred from a thread's author; feeds
   * {@link PrReviewState.addressed}.
   */
  publishedThread: string | null;
}

/**
 * How the harness decided to read a pull request — the triage's verdict, naming one of the modes
 * the project declared. Kept as its own row rather than a column on {@link PrReview}: the merge
 * gate is satisfied by a `pr_reviews` row existing, so a row written early to hold a route would
 * report a PR as reviewed by the step that only decided how. → `docs/spec/07-pull-requests.md#choosing-how-to-review`
 */
export interface PrReviewRoute {
  prNumber: number;
  /** The mode's key in `review.modes`, as the triage agent named it. Empty on a skip. */
  mode: string;
  /**
   * The triage decided this pull request needs no review at all — waives the gate rather than
   * sizing it, available only where `review.allowSkip` is set. Read by both `needsFleetReview`
   * and `reviewSatisfied`, so a skipped review does not also block the merge; {@link reason} is
   * required. False on every pre-existing row, which needs no backfill.
   * → `docs/spec/07-pull-requests.md#skipping-a-review-altogether`
   */
  skipped: boolean;
  /** Why, in the triage's own words — the whole of what an operator reads later. */
  reason: string;
  agentId: string | null;
  decidedAt: string;
}

/** A route as the tool hands it over; the store stamps the rest. */
export type PrReviewRouteInput = Omit<PrReviewRoute, 'decidedAt'>;

/**
 * What `review_report` supplies. `publishedThread` is not part of it: the reviewer reports first
 * and publishes after, so the thread is written by the send rather than the report.
 */
export type PrReviewInput = Omit<PrReview, 'reviewedAt' | 'publishedThread'>;

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
   * The subset of `labels` the authenticated viewer added themselves, when the provider resolves
   * tag authorship (GitHub timeline / Azure work-item revisions). `undefined` when authorship
   * isn't tracked. The dispatcher reads this instead of `labels` only when
   * `issuePickupRequireOwnLabel` is set, so a tag added by someone else can't trigger pickup.
   */
  labelsAddedByViewer?: string[];
  state: IssueState;
  /**
   * The provider's native workflow state, when it has a richer model than open/closed (e.g.
   * Azure's `System.State`). `state` collapses this to open/closed; this preserves the raw value
   * so the dispatcher can gate on it. `undefined` for providers with no such model.
   */
  workItemState?: string;
  /**
   * The provider's native item type (e.g. Azure's `System.WorkItemType`: "Feature", "User Story",
   * "Bug", "Task"). `undefined` for trackers with one kind of item. The dispatcher reads it to
   * refuse picking up a container type (see `src/issueRelations.ts`).
   */
  issueType?: string;
  /**
   * The classification node the item sits on — Azure's `System.AreaPath`. `undefined` for
   * trackers with no such concept. Never empty on a provider that has it: an unclassified item
   * sits on the project's root node, so "unclassified" is equal-to-root, not absent — see
   * `src/intake/placement.ts`.
   */
  areaPath?: string;
  /**
   * The item this one hangs off — an Azure hierarchy parent, typically the Feature a story
   * belongs to. Carries the parent's description for planning context. Three distinct states:
   * `undefined` means no hierarchy tracked, `null` means tracked with no parent (an orphan), and
   * an object is the parent.
   */
  parent?: IssueRelative | null;
  /**
   * The items hanging off this one — a Feature's stories. Empty for a leaf, `undefined` when
   * hierarchy isn't tracked. Bodies are not carried — a child's own description is read when that
   * child is worked.
   */
  children?: IssueRelative[];
  /**
   * The other children of {@link parent} — sibling stories under the same feature. `undefined`
   * when hierarchy isn't tracked or there is no parent; empty when this is the only child.
   */
  siblings?: IssueRelative[];
  /**
   * The items this one waits on — Azure's `System.LinkTypes.Dependency-Reverse` (Predecessor).
   * The order already drawn on the board, read but never written (→ `docs/spec/33-story-sequencing.md`).
   * `undefined` means the provider tracks no dependencies (read as "no order stated"); an empty
   * list means it tracks them and this item waits on nothing — the distinction matters as it does
   * for {@link parent}.
   */
  dependsOn?: IssueRelative[];
  /** The PR opened to resolve this issue, once one exists. Null until linked. */
  linkedPrNumber: number | null;
  url?: string;
}

/**
 * One end of a tracker relationship — the parent, child or sibling of an {@link Issue}, as
 * carried on that issue. Deliberately not an `Issue`: a relative is a summary only, so code
 * cannot treat a related item as something the harness can act on directly.
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
   * Open pull requests, and only those. Every dispatcher rule and PR predicate trusts this list
   * to be open; recently-closed PRs are carried separately below so that stays true by construction.
   */
  pullRequests: PullRequest[];
  /**
   * PRs that left the open set within `config.closedPrWindowMs` — a merge or abandonment the
   * harness would otherwise only see as a disappearance. Deliberately not merged into
   * {@link pullRequests}: lets the world diff emit a real `pr_merged`/`pr_closed` without putting
   * a dead PR in front of a dispatch rule. Absent/empty means the provider doesn't report closed
   * PRs or the window is disabled — consumers must degrade to "absence means merged".
   */
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  /**
   * Ids of integrations whose slice of this snapshot is last-known-good rather than freshly read
   * (a provider read that failed and fell back). Absent/empty means every slice is current.
   * Recorded so a cycle deciding against a stale world is distinguishable from one against a
   * fresh, unchanged world — including in the decision log. Nothing in `decide` gates on it
   * (a stale world is still the best available one); the one gate is the world-event baseline,
   * which does not diff or move against a world any source reported stale.
   */
  staleSources?: string[];
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

/**
 * A task without the rendered prompt handed to its agent — every column except the bulk text.
 * Split out because the prompt is large and read by almost nothing (it dominated a real
 * deployment's state payload while no surface reads it); the prompt is fetched per row via
 * {@link Store.getTask}. `Task` extends this so a field added here lands on both by default.
 */
export interface TaskSummary {
  id: string;
  kind: TaskKind;
  /** Human-readable summary of what this task is for. */
  title: string;
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
  /**
   * The dispatcher rule that proposed this task (a `DISPATCH_RULES` id), captured at dispatch so
   * spend can be split "by task type" (`src/taskTypeSpend.ts`) since a decision row has no link
   * back to its task. A plain string, not `DispatchRuleId` — domain types must not reach into
   * `src/dispatcher/`, and an unknown id renders as itself rather than dropping silently. Null for
   * a task dispatched outside the pulse; absent means not recorded (pre-existing rows).
   */
  rule?: string | null;
  /**
   * The CI checks this task was dispatched to answer, as the provider names them — null for a
   * non-CI dispatch or one whose provider reported no per-check detail. Recorded structurally
   * rather than parsed back out of {@link dispatchReason}'s prose. Absent and null both mean "no check named".
   */
  ciChecks?: string[] | null;
  /**
   * MCP servers this launch carries beside the harness's own, or null for none. Stored on the row
   * (not derived from {@link rule}) because `AgentManager.resume` rebuilds a launch from it after
   * a restart — an agent reattached without the server it launched with loses tool calls it can no
   * longer make. Absent means not recorded (pre-existing rows).
   */
  mcpServers?: ExtraMcpServer[] | null;
  /**
   * The model this run launches on (`claude --model`), resolved from `agentModels` policy at
   * dispatch time — null means no `--model` was passed. Resolved at dispatch, not spawn, so a
   * resumed agent keeps launching on the model it started on rather than whatever config now says.
   * Absent means not recorded (pre-existing rows).
   */
  model?: string | null;
  /**
   * The reasoning depth this run launches at (`claude --effort`), resolved from the same profile
   * and moment as {@link model}. Stored separately because cost varies by depth even for one
   * rule/model pair. Null means no `--effort` was passed (the CLI's own default).
   */
  effort?: string | null;
  /**
   * The name of the profile {@link model} and {@link effort} came from (e.g. `fast`, `deep`).
   * Null for a run that resolved to no profile. Stored rather than looked up because profiles get
   * re-pointed at new models over time.
   */
  profile?: string | null;
  /**
   * Which level of the precedence chain named that profile: `pin` (the goal/part chose it), `rule`
   * (`byRule` did), or `default`. The point is `pin` — without it, a run costing three times its
   * rule's price reads as ordinary.
   */
  profileSource?: string | null;
  status: TaskStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A task, whole: a {@link TaskSummary} plus the rendered prompt its agent was
 * handed. Produced only by a single-row read or by the write that created it —
 * see {@link TaskSummary} for why the list reading and the wire shape drop it.
 */
export interface Task extends TaskSummary {
  /** The prompt handed to the agent. */
  prompt: string;
}

/**
 * An operator-launched job: a prompt queued from the cockpit that the harness turns into an
 * agent. Unlike a {@link Task} (materialised the instant an agent spawns), a job is a durable
 * request that persists ahead of dispatch, so it can queue at capacity. The dispatcher drains
 * queued jobs before any world-driven rule.
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
   * The origin whose work this job stands in for — e.g. `issue:41:retro` for a retro a crash
   * recovery requeued; null for an ordinary operator job. A job's own origin is always
   * `job:<id>`; this field is the work being redone, needed so the gates that stop two agents
   * landing on one piece of work can see it — otherwise a requeued retro is invisible and a
   * second one dispatches while the first still runs.
   */
  originRef: string | null;
  /** The task this job was dispatched as, once it has been. Null while queued. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A recurring brief: a prompt the operator wants run on a cron schedule, and how far through
 * that recurrence the harness has got. It is intent, not work — a firing produces an ordinary
 * {@link Job}, queued and dispatched exactly as a hand-launched one, so every gate the fleet
 * already has (cap, pause, Up next, cooldowns) applies unchanged.
 */
export interface JobSchedule {
  id: string;
  /** The title each firing's job carries. Derived from the prompt when the operator omits one. */
  title: string;
  /** The prompt each firing's job carries, verbatim. */
  prompt: string;
  /** Whether firings run as a code agent (in a worktree) or a desk agent (scratch dir). */
  kind: TaskKind;
  /** The five-field cron expression, read in the harness process's local timezone. */
  cron: string;
  /** Off means the recurrence stands but nothing fires; `nextRunAt` is null while it is. */
  enabled: boolean;
  /**
   * When the next firing is due. Null while disabled, and null for an expression that matches no
   * future minute at all (`0 0 30 2 *`) — a schedule that can never fire says so once.
   */
  nextRunAt: string | null;
  /** When it last fired — including a firing the operator asked for by hand. */
  lastFiredAt: string | null;
  /** The job the last firing created; also how the next pulse checks whether it's still running. Null until first fire. */
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An image an operator attached to a brief, as it arrives on the wire. `data` is base64 of the
 * raw file, no data-URL prefix. Deliberately no `mime` field — a client-declared type is
 * attacker-controlled, so the type an agent trusts is sniffed from the decoded bytes instead.
 * `name` is display-only, never used to build a path.
 */
export interface JobAttachmentInput {
  /** The operator's own filename, kept for display. Optional — a pasted screenshot has none. */
  name?: string;
  /** The file's bytes, base64-encoded. */
  data: string;
}

/**
 * An attachment as stored: the file on disk, plus what an agent is told about it. Keyed on
 * `targetRef` rather than a job id because what an attachment belongs to outlives the row it
 * arrived with — a code brief becomes a desk filing job and then a ticket.
 */
export interface JobAttachment {
  id: string;
  /** What it is attached to: `job:<id>` while the brief is one. */
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
 * `closedPullRequests`; `inferred` means it left the open set and the window never showed it —
 * kept because absence-means-merged is a deliberate fallback worth remembering as such.
 */
export type WorkNodeProvenance = 'observed' | 'inferred';

/**
 * One node of the durable work graph: what the harness did for a work item, and what it
 * descended from. Keyed on the existing ref vocabulary (`issue:12`, `pr:41`, …) so it joins to
 * every gate without a second naming scheme. `parentRef` follows work lineage (a PR's parent is
 * the part that produced it); stacking is a different relation on `baseRef`, keeping the graph a tree.
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
 * Where a work-item filing sits. Two statuses because filing is asynchronous: the click queues a
 * desk job, and the ticket exists only once that job's agent creates it and calls `link_ticket`.
 * `filing` is the state in between; `filed` carries {@link WorkItemFiling.ticketRef}.
 */
export type WorkItemFilingStatus = 'filing' | 'filed';

/**
 * A tracker item the operator asked the harness to create for work with no issue behind it (an
 * operator job that produced commits and a PR). Keyed on the node it is for, so one node has at
 * most one filing; the ref becomes that node's `parentRef` once it comes back, written by the
 * fold only. Deliberately not a {@link Finding} — this row has no agent to attribute to.
 */
export interface WorkItemFiling {
  /** The unrecorded node this is filing a work item for (`job:job_abc`). */
  targetRef: string;
  status: WorkItemFilingStatus;
  /** The tracker item it was filed as (`issue:314`), once the harness created it. */
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A bug the operator raised against a story from the cockpit, and what became of it. Shares
 * {@link WorkItemFilingStatus}'s asynchrony. Keyed on `jobId` rather than the story, so one story
 * can carry several bugs over its life. → `src/store/bugFilings.ts`
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
 * An operator priority override for the "Up next" queue. Keyed on a candidate's stable `origin`
 * so it survives pulses and restarts while the queue itself stays a per-pulse projection. `rank`
 * is ascending (`0` = next) and only orders among overridden origins — it never un-holds a held item.
 */
export interface PriorityOverride {
  origin: string;
  rank: number;
}

/**
 * An operator override of which model profile one queued dispatch runs on. Keyed on the same
 * stable `origin` {@link PriorityOverride} uses, for the same reason. A separate statement from
 * priority — "cheaper" vs "sooner". Standing, not one-shot: not consumed by the dispatch it
 * changes, so a retry runs the same profile; cleared by the operator or pruned via
 * `upNextOverrideTtlMs`. Wins over the goal's tag and the plan's part profile.
 */
export interface ProfileOverride {
  origin: string;
  /**
   * The profile's name. A plain string, same terms as {@link PlanPart.profile}; `resolveAgentProfile`
   * falls through to the rule for a name it cannot resolve rather than launching on nothing.
   */
  profile: string;
}

/**
 * A goal the operator has marked a priority: everything dispatched under `issue:<n>`, and
 * against the pull requests it opened, is ranked ahead of the natural cross-rule order until
 * cleared. A boolean on the goal, not a rank on an origin — unlike {@link PriorityOverride} it
 * survives the goal's work changing shape (part/PR origins spun off it). Orders only — a
 * cooldown, cap, unapproved plan or ignore tag still holds a flagged goal's work.
 */
export interface GoalPriority {
  /** The goal's origin, `issue:<n>` — the same key every verdict on a goal is written against. */
  originRef: string;
  /** When the operator flagged it. Shown as the age of the decision, never read by the dispatcher. */
  since: string;
}

/**
 * `crashed` is the one status no agent transition writes: stamped at boot on a row that still
 * claimed to be live when its process died, meaning only that an operator's recovery verdict is
 * outstanding. Deliberately not live (stops counting toward the concurrency cap) nor terminal
 * (`restore` puts it back to `running`).
 */
export type AgentStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'interrupted' | 'failed' | 'crashed';

/**
 * What the executor is doing with an action it has picked up but not yet turned into anything
 * the fleet can see — the awaited steps only, since `ActionExecutor.execute` walks the plan
 * strictly serially and every other action waits behind whichever one is mid-await.
 *
 * - `picked-up` — in hand, no awaited step reached yet.
 * - `ci-evidence` — reading a CI dispatch's failing check output from the provider.
 * - `slot-handover` — the worktree pool handing a slot over (`git clean -ffdx` + cold checkout).
 * - `authorizing` — checking whether an outbound act (merge, review reply) is already authorized.
 */
export type ReadyingStep = 'picked-up' | 'ci-evidence' | 'slot-handover' | 'authorizing';

/**
 * One action the executor is working on right now — in flight and not an agent: no slot, no
 * transcript, nothing to kill or inject into. In-memory only and deliberately so — its lifetime
 * is one stack frame of `ActionExecutor.execute`, so a persisted row would outlive the process
 * and leave a phantom on every crash.
 */
export interface ReadyingAction {
  /** The row's key: the cycle it belongs to and the action's place in that plan. */
  id: string;
  /** The cycle whose plan this action came from. */
  cycleId: string;
  /** What the action is, in the words the dispatcher gave it. */
  title: string;
  /** What it is for, as `issue:<n>` / `pr:<n>:<concern>` / `job:<id>`, or null for an action naming none. */
  originRef: string | null;
  /** The branch a slot is being handed to, where the action names one. */
  branch: string | null;
  /** What the executor is doing with it now. */
  step: ReadyingStep;
  /** When the executor picked the action up — the only elapsed time the row has. */
  startedAt: string;
}

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
   * Cumulative Claude usage as last reported by the session's `result` events (stream runtime
   * only — a PTY session reports none, so these stay null). `costUsd` is the session's total API
   * cost so far; tokens/turns likewise accumulate across the whole session.
   */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * The cached share of {@link Agent.inputTokens} — a part of it, never a sibling total (`inputTokens`
   * stays the gross fresh+written+read figure). Both null when no usage was reported, zero when
   * usage was reported with no caching. Stored because cache hit rate is what a gross figure
   * cannot show and cache pricing differs sharply from fresh tokens.
   */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  /**
   * The agent's own one-line answer to "what are you doing right now", from `note_progress` — a
   * current value, replaced on each call, null for an agent that never called it (a supported
   * state, not degraded).
   */
  note: string | null;
  /**
   * When {@link Agent.note} was written. Display context only — nothing derives liveness or
   * health from it, since the longest gaps between notes are long test runs, i.e. exactly when an
   * agent is healthiest. Liveness is the process, status transitions, and the `waiting` park.
   */
  notedAt: string | null;
  /**
   * When this agent was last seen doing work after it parked on a human, or null if that hasn't
   * happened since its current park. Exists because `escalate` only requests a wait — a model
   * that carries on anyway leaves `waiting` with a stale alert. Counts only tool calls, not prose,
   * on the transcript. Display context only — nothing un-parks off it or dispatches on it.
   */
  resumedAt: string | null;
  /**
   * How many times the harness has re-attached to this agent after its process died mid-run,
   * bounded by `agentResumeAttempts`. Zero for an agent that never crashed or predates the
   * column. A budget, not an observation — unlike {@link Agent.resumedAt} it is never cleared by
   * answering an escalation, and persisted (not in-memory) since `spawn`/`resume` reuse one row
   * across restarts.
   */
  resumeAttempts: number;
}

/**
 * An artifact an agent surfaced to the cockpit mid-run via the flag sentinel
 * (`@@LUBBDUBB_FLAG:…@@`) — a design doc, a report, a link. Generic on purpose: `kind`/`label`
 * are cosmetic and `ref` is a worktree-relative path or an absolute http(s) URL. Deduped per
 * agent by `ref`.
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
 * A file an agent wrote, captured by the file-events `PostToolUse` hook (not the flag sentinel —
 * needs no cooperation from the agent's prompt). Every write is tracked as "files changed";
 * `promoted` ones are also surfaced as an {@link AgentFlag} chip. Deduped per agent by `path`.
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

/**
 * One path a goal has been edited in, and the work that last wrote it — the `agent_files` rows
 * of a whole issue subtree, folded to one row per path. Narrower than {@link AgentFile} (no
 * agent id, tool, or promotion flag) since the only reader is the prior-work briefing.
 */
export interface GoalFile {
  /** As the writing agent reported it — worktree-relative where the write landed inside its cwd. */
  path: string;
  /** The origin of the task whose agent last wrote it: `issue:12:part:schema`, say. */
  originRef: string;
  /** When that last write was recorded. */
  createdAt: string;
}

/**
 * Another goal that has been in the same files as this one, and what its retrospective said
 * about the run. Keyed on the goal, not the writing agent: `detectFileOverlaps` answers "who is
 * editing this path now", this answers "who has been here before".
 */
export interface GoalNeighbour {
  /** The neighbour goal, always the `issue:<n>` root — a retrospective's own key. */
  goalRef: string;
  /**
   * The neighbour's retrospective summary, quoted whole — carried rather than pointed at, since
   * no tool an agent has can reach another goal's write-up.
   */
  retroSummary: string;
  /** The paths both goals have been in, the neighbour's most recent write first. */
  sharedPaths: string[];
  /** The neighbour's most recent write among those paths. */
  lastWriteAt: string;
}

/**
 * Which kind of return to a pull request a {@link Remedy} accounts for: its CI going red, or a
 * review asking for changes. Resolved from the dispatch origin, never from an argument.
 * → `src/remedies/remedies.ts`
 */
export type RemedyKind = 'ci' | 'review';

/**
 * What was actually wrong. Which values a given {@link RemedyKind} may name is
 * `CAUSES_BY_KIND`'s to say, not this union's: a review round is never a flake.
 */
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

/**
 * What would have caught it before the push — the second axis, and the one that
 * answers *how do we get fewer of these*. `undocumented` is the only value the
 * harness can act on, and the only one a proposed {@link Lesson} may ride on.
 */
export type RemedyGuard = 'local_check' | 'documented' | 'undocumented' | 'unpreventable';

/**
 * One account of why the fleet had to come back to a pull request, written by the agent that
 * settled it. A record, not a verdict — nothing gates on it. Its own table rather than columns
 * on `tasks` because one run can settle several reds and one red can take several runs, so the
 * two do not share a key.
 */
export interface Remedy {
  id: string;
  /** From the origin, never claimed. */
  kind: RemedyKind;
  /** The dispatch origin it was filed against: `pr:<n>:ci` or `pr:<n>:comments`. */
  originRef: string;
  prNumber: number;
  cause: RemedyCause;
  guard: RemedyGuard;
  /** One line: what was wrong, and what fixed it. Required — a bare pair of enums is not a reading. */
  summary: string;
  /**
   * The checks that were red when this agent was dispatched, from {@link Task.ciChecks}, not the
   * submission. Empty for a review remedy or a CI dispatch on a provider with no per-check detail.
   */
  checks: string[];
  /** The reporting agent and its task, from the credential. */
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

/** A remedy as submitted, before the store assigns identity and stamps it. */
export type RemedyInput = Omit<Remedy, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Where a piece of work only a person can do has got to. Two terminals, both settlements — no
 * lapse, expiry, or deletion. `declined` is the operator saying "no, and here is why", a fact the
 * plan and next agent need. Clearing a settled row off the bench is {@link HumanTask.dismissedAt},
 * not a status here.
 */
export type HumanTaskStatus = 'open' | 'done' | 'declined';

/**
 * Who a human task is for the harness, distinct from who asked for it. `ask` is anything a
 * person typed or an agent requested — only a person can close it. `close_out`, `burn`,
 * `validate`, and `watch` are ones the harness both files and settles itself, watching a ticket,
 * spend, validation checks, or a post-deploy window respectively. A discriminator rather than a
 * title match, since the harness must re-find its own row on the next pulse without parsing prose.
 */
export type HumanTaskKind = 'ask' | 'close_out' | 'burn' | 'validate' | 'supply' | 'watch';

/**
 * A unit of work only a person can do — flipping a setting, plugging something in, judging a
 * rendered screen. Not an {@link Escalation}: an escalation blocks one running agent and dies
 * with it; a human task is work that outlives every agent and restart, and other work can depend
 * on it. Attribution is structural: `agentId`/`taskId`/`originRef` come from the credential the
 * call arrived on. A null `agentId` means an operator filed it or a plan declared it as a step
 * ({@link HumanTask.partId} tells those apart).
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
   * The plan part this task is, when a planner declared a step for a person (`expectedKind:
   * 'human'`). Null otherwise. The only field through which a human task holds work off the
   * fleet — a standalone human task blocks nothing.
   */
  partId: string | null;
  /** What kind of obligation this is — see {@link HumanTaskKind}. */
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
   * When the operator cleared a settled row off the bench, or null while still on it.
   * Deliberately not a fourth {@link HumanTaskStatus} — "I've read it" is not a verdict on the
   * work. Only a settled row can carry one, so a dismissal can never lose an obligation.
   */
  dismissedAt: string | null;
}

/** A human task as requested, before the store assigns identity and status. */
export type HumanTaskInput = Pick<HumanTask, 'title' | 'detail'>;

/**
 * What someone said about whether an issue is finished. `undeclared` is a value, not the
 * absence of one — folding "nobody said" into "not finished" is the assumption that had the
 * harness re-pick merged work. Only {@link IssueConclusionVerdict} is ever stored; `undeclared`
 * is what the resolver returns for a row that doesn't exist.
 */
export type IssueConclusionVerdict = 'done' | 'more_work';

/**
 * Who cast a verdict: the agent that did the work, the assessor that later judged
 * the issue as a whole, or the operator overriding either.
 */
export type ConclusionAuthor = 'agent' | 'assessor' | 'operator';

/**
 * One issue's standing conclusion — the `conclude_work` tool's row, or the operator's override.
 * Keyed on the `issue:<n>` origin, not hung off an agent, because it must outlive every agent
 * that touched the issue. One row per issue, overwritten per declaration.
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
 * Something the operator has told the fleet to do on a goal, in their own words. A row rather
 * than a note on the verdict because the old bare `more_work` toggle carried no words, so the
 * next agent re-read the same ticket. Instructions accumulate: every one since the last
 * conclusion stands, is appended to every dispatch on the goal in order, and is settled together
 * by `conclude_work`. An operator can withdraw one they didn't mean.
 */
export interface IssueInstruction {
  id: string;
  /** The goal, as `issue:<n>` — the origin every dispatch on it hangs beneath. */
  originRef: string;
  /** The operator's words, verbatim. Never rendered by the harness into anything else. */
  text: string;
  createdAt: string;
  /** When it stopped standing: an agent concluded the goal, or the operator withdrew it. Null while it stands. */
  settledAt: string | null;
}

/**
 * A finished goal the operator has kept on the Goal Floor, until they dismiss it. The floor is
 * built from the live world, so a completed goal would otherwise drop off it the moment the
 * tracker stops returning the issue; this row is written while the goal is still live so its
 * `title` survives that. Dismissal is one-way and persists across a restart.
 */
/**
 * How a run ended, stamped at dismissal: the harness had judged the work, or the operator
 * abandoned it. Derived from the row (a completion instant means judged) rather than passed in,
 * so the two cannot be claimed independently of the evidence.
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
/**
 * One tracker item as the mirror keeps it (issue #329).
 *
 * Deliberately thinner than {@link Issue}: this is the row behind a *history*, so
 * it carries what a list is read and ordered by and nothing a dispatch would want.
 * No body, because the mirror holds every item the tracker has ever returned and a
 * description per row is the bulk of a tracker; a rule that needs one reads the
 * live issue, which is the only shape it is allowed to act on anyway.
 *
 * `changedAt` is the provider's own last-modified instant, and it is load-bearing
 * twice over: it is the high-water mark the next sweep asks from, and it is why
 * the one-month floor is a floor rather than a cut — an item older than the anchor
 * that someone has touched since arrives on a changed-since read and is then kept
 * like any other. → `docs/spec/14-persistence.md`
 */
export interface TrackerItem {
  number: number;
  title: string;
  labels: string[];
  state: IssueState;
  /**
   * The provider's own workflow word — `Closed`, `Removed`, `Ready` — or null
   * where it has none (GitHub, the fake).
   *
   * Read on the *history* sweep and not only on the live overlay, which is the
   * whole difference between a closed item that says `Closed` and one no state
   * filter can reach: the overlay is built from the open set by construction, so
   * an item that has left it would otherwise keep whatever state it was last seen
   * live with — or, for everything closed before the harness ever saw it open,
   * none at all. → `docs/spec/14-persistence.md#the-ticket-mirror`
   */
  workItemState: string | null;
  /** The provider's web URL, when it gave one. */
  url: string | null;
  /** When the tracker says the item was filed — the list's `added` reading. */
  createdAt: string;
  /** When the tracker last saw it change. The sweep's high-water mark. */
  changedAt: string;
}

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
  /** What the operator said when they ended a run whose validation plan was not clear. Null when nobody was asked. */
  dismissNote: string | null;
  updatedAt: string;
}

/**
 * Who decided an issue was delivered: the assessing agent, the operator, or the planner that
 * found the goal already met before anything was built. → `src/mcp/planNotNeeded.ts`
 */
export type DeliveryAuthor = 'assessor' | 'planner' | 'operator';

/**
 * One issue's standing `delivered` verdict — the harness's own park. Distinct from
 * {@link IssueConclusion} (a different lifetime and reader): a conclusion is declared once and
 * gates nothing, a delivery verdict is re-read by the pickup gate every pulse and stops standing
 * when the world moves. Writing either clears the other. `delivered` is weaker than `closed` and
 * reversible; its only effect is stopping pickup.
 */
export interface IssueDelivery {
  /** The issue, as `issue:<n>` — the same origin the conclusion and every gate keys on. */
  originRef: string;
  /** One line: what was delivered. Required — a bare verdict is not reviewable. */
  summary: string;
  /** The account behind the headline, as markdown. Null when its author added none. */
  detail: string | null;
  by: DeliveryAuthor;
  /** The agent that cast it and its task, from the credential. Null for an operator verdict. */
  agentId: string | null;
  taskId: string | null;
  /** When the verdict was first cast — the instant world signal is measured against. */
  decidedAt: string;
  updatedAt: string;
}

/**
 * What a goal appraisal may conclude about an issue's text. `workable` is stored as much as
 * `unclear`, else the appraiser re-runs every cycle. No third "not appraised" member — that is
 * the absence of a row, which is what makes a crashed appraiser fail open.
 */
export type GoalAppraisalVerdict = 'workable' | 'unclear';

/** Who judged an issue's goal text: the appraising agent, or the operator directly. */
export type AppraisalAuthor = 'appraiser' | 'operator';

/**
 * One issue's standing goal appraisal — whether the ticket is workable, cast before anything is
 * dispatched against it. Sibling of {@link IssueDelivery}: a delivery says the work is finished,
 * an appraisal says the goal could not be started from — both can be true at different times, so
 * neither clears the other. Bound to the exact text via {@link goalRef}, so an edited ticket
 * re-appraises by lookup rather than an event the harness had to witness.
 */
export interface IssueAppraisal {
  /** The issue, as `issue:<n>` — the same origin every gate keys on. */
  originRef: string;
  verdict: GoalAppraisalVerdict;
  /** Why the goal is, or is not, actionable. Required: a bare verdict is not reviewable. */
  summary: string;
  /**
   * What the ticket has to say before an agent could start, one question per entry, addressed to
   * whoever wrote it. Empty on every `workable` verdict and on an operator's.
   */
  missing: string[];
  /**
   * A fingerprint of the goal text this verdict was cast against (see `goalFingerprint`). The
   * hold ends the instant the issue's current text fingerprints differently — no timer needed.
   */
  goalRef: string;
  by: AppraisalAuthor;
  /**
   * The model profile the appraiser proposed for this goal's work, or null when it named none.
   * Kept regardless of what the operator later decides, so the pair (this, the ticket tag) shows
   * whether a human intervened; nothing reads this as the pin.
   */
  proposedProfile: string | null;
  /**
   * When the profile question was settled — by the operator answering, or at write time if
   * nothing needed asking. Null holds the funnel (see `appraisalHold`).
   */
  profileAnsweredAt: string | null;
  /**
   * The container work item the appraiser proposed this goal should hang off, or null when it
   * named none. A number, not a resolved item — the cockpit resolves it through `refUrls`.
   * Nothing here expires it; whether the question is still worth asking is derived from the live
   * work item. See {@link parentSettledAt} for the one thing that is stored.
   */
  proposedParent: number | null;
  /**
   * When the operator answered the parent question, whichever of the three answers they gave.
   * The one piece of state a derived question needs — accepting or supplying a value both change
   * the work item (visible on the next read), but "this goal wants no parent" changes nothing out
   * there, so without a stamp it sits in the needs band forever. Scoped to this row, so rewritten
   * goal text asks again.
   */
  parentSettledAt: string | null;
  /** The area path the appraiser proposed, from the candidates the harness offered it. */
  proposedAreaPath: string | null;
  /** {@link parentSettledAt} for the area path — the same three answers, the same scope. */
  areaPathSettledAt: string | null;
  /** The appraising agent and its task, from the credential. Null for an operator verdict. */
  agentId: string | null;
  taskId: string | null;
  /** The provider's id for the one comment this verdict maintains on the ticket, once written. */
  commentRef: string | null;
  /** When the verdict was first cast — the instant world signal is measured against. */
  decidedAt: string;
  updatedAt: string;
}

/**
 * One entry on an issue's shared scratchpad — what an agent working the goal left for whoever
 * works it next, and for the retrospective at the end. Append-only: no update or delete anywhere
 * above this type.
 */
export interface ScratchEntry {
  id: string;
  /** The pad: an `issue:<n>` ref, or `pr:<n>` for the agents working a pull request — see `padOriginFor`. */
  padRef: string;
  /** The origin of the agent that wrote it: a part, the planner, the assessor, a CI fixer. */
  authorOriginRef: string;
  /** Attribution, taken from the credential rather than from an argument. */
  agentId: string;
  taskId: string;
  /** An optional scannable tag the author chose. */
  topic: string | null;
  note: string;
  /** What makes the entry a fork rather than a note — the witness log. Null on an ordinary note. */
  decision: PadDecision | null;
  createdAt: string;
}

/**
 * A moment where the change could reasonably have gone another way, recorded by the agent that
 * took it. `rejected` justifies the record — a diff can never answer why not the other way.
 */
export interface PadDecision {
  /** What the change does here. */
  chose: string;
  /** Why. */
  because: string;
  /** The alternatives, each with the reason it was not taken. */
  rejected: { alternative: string; because: string }[];
  /** The files the fork touches, where the agent can say. */
  paths: string[];
}

/**
 * What a pad amounts to without reading it: how much was written, and when the last entry
 * landed. The snapshot is polled continuously, so this carries only what a control needs to know
 * there's something to open; entries are fetched separately.
 */
export interface ScratchPadSummary {
  padRef: string;
  entries: number;
  /** The newest entry's timestamp — the pad is append-only, so this is its age. */
  updatedAt: string;
}

/**
 * One goal's retrospective: what shipped, and how the run went. Nothing gates on it — a missing
 * one is silence, not a hold, which is what makes the rule that produces it safe to fail open.
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
 * A review pack: one pull request's change restated as a handful of ideas, each followed
 * through every file it touched, with every sentence a claim the checker marked true, false or
 * undecidable. → `docs/spec/31-review-packs.md#the-pack`
 *
 * A document, not a row: written whole by the author, annotated whole by the checker, read whole
 * by every renderer — nothing queries inside it. Self-contained (carries its own code) so the
 * HTML companion can render one with no harness behind it. The checker's fields (`order`, each
 * idea's `attention`/`cue`, each claim's `verdict`/`evidence`) are null/empty until it has run.
 */
export interface ReviewPack {
  /**
   * The document's shape version, compared by every reader against the one it knows: an unknown
   * version refuses loudly rather than silently rendering a page missing its false-claim banner.
   */
  schema: number;
  prNumber: number;
  /** The commit the pack was written against; staleness is decided against the pull request's head on every load. */
  headSha: string;
  /** What the change does, in one plain sentence — the author's. */
  headline: string;
  /** A paragraph in the same register, the one thing the reader most needs in bold — the author's. */
  summary: string;
  /** How long the author expects the read to take. */
  estimatedMinutes: number;
  /** Idea ids in the order the checker says to read them. Empty until the checker has run. */
  order: string[];
  ideas: ReviewIdea[];
  /**
   * Whether a witness log existed when the pack was written. False on a pull request nobody
   * witnessed, where every claim comes out `inferred` and the header says so.
   */
  witnessed: boolean;
  /** The colophon's "what is fake" sentence — what a demo owes, and what a real pack states as "nothing". */
  fake: string;
}

/**
 * An idea: one falsifiable claim plus an ordered walk of anchors. The unit a
 * change is actually made in, and the unit a diff destroys by sorting everything
 * by path. → `docs/spec/31-review-packs.md#an-idea`
 */
export interface ReviewIdea {
  /**
   * Minted by the author on every run, so nothing durable is keyed to it — a reviewer's marks
   * ride on the hunks an idea owns ({@link ReviewMark}). `plumbing` is the one reserved id, for
   * hunks carrying nothing to review.
   */
  id: string;
  /** One sentence, falsifiable, stating what this idea does — for the checker. */
  claim: string;
  /** The same thing said across a desk, no identifiers — for the person. */
  title: string;
  /** One short line under the title: why the attention label is what it is. The checker's; null until it has run. */
  cue: string | null;
  /** The walk, in the order the reasoning ran — never the order the files sort in. */
  anchors: ReviewAnchor[];
  /** The checkable statements this idea rests on. */
  claims: ReviewClaim[];
  /**
   * The test scenarios this idea is covered by, one short line each, never explained. Lives on
   * the idea rather than in an idea of its own, so a reader is not sent elsewhere to check
   * coverage. → `docs/spec/31-review-packs.md#tests-are-never-an-idea`
   */
  coverage?: string[];
  /** How hard to look. The checker's, never the author's; null until it has run. */
  attention: ReviewAttention | null;
}

/**
 * How much scrutiny an idea needs. `split` is the checker's opinion that the idea
 * is unrelated to the rest of the pull request and could be its own.
 */
export type ReviewAttention = 'read' | 'decide' | 'skim' | 'split';

/**
 * A place in the tree the walk stops at, with one line saying why. A `hunk` is a
 * range of the diff; a `region` is a range of a file the diff does not touch —
 * context the change cannot be judged without, or a deliberate absence: the file
 * a reader would expect to have changed, shown unchanged.
 * → `docs/spec/31-review-packs.md#an-anchor`
 */
export interface ReviewAnchor {
  kind: 'hunk' | 'region';
  /** Where the lines are, at the pack's head sha. */
  range: ReviewRange;
  /**
   * The lines as they stood at the head sha, embedded so the pack renders with no
   * repository behind it. A hunk's lines carry their diff prefixes; a region's are
   * plain.
   */
  code: string[];
  /** One line, always shown: why the walk stops here. */
  gist: string;
  /** The reasoning, folded away; never required to understand the code. */
  note: ReviewNote | null;
  /** The one-line label on the code block itself, saying what the block is. */
  caption: string | null;
  /** Why this stop stands out, where it does. */
  mark: ReviewAnchorMark | null;
}

/**
 * A range of one file at a head sha: what an anchor points at, and what a
 * reviewer's mark is keyed to. `start` and `end` are 1-based and inclusive.
 */
export interface ReviewRange {
  path: string;
  start: number;
  end: number;
}

/**
 * `key`: the stop the idea turns on. `false`: the stop a false claim is about.
 * `disputed`: the stop where the witness and the code disagree.
 */
export type ReviewAnchorMark = 'key' | 'false' | 'disputed';

/**
 * A note states its provenance the way a claim does: written by the witness at the time (citing
 * the pad entry) or added by the author afterwards.
 */
export type ReviewNote = { by: 'witness'; text: string; entryId: string; at: string } | { by: 'author'; text: string };

/**
 * A sentence that can be shown false, with where it came from and what the
 * checker made of it. → `docs/spec/31-review-packs.md#claims`
 */
export interface ReviewClaim {
  text: string;
  provenance: ReviewProvenance;
  /** The checker's answer; null until it has run. */
  verdict: ReviewVerdict | null;
  /** What the checker did to decide — the search, the test, the file it read. Null until it has run. */
  evidence: string | null;
  /**
   * The checker's finding, on a `false` claim and nothing else — the page's most important
   * prose. Null until the checker has run. → `docs/spec/31-review-packs.md#what-a-false-claim-does`
   */
  finding: ReviewFinding | null;
}

/**
 * Where a claim came from, structurally rather than decoratively. `witnessed` cites the pad
 * entry (stores the id, never a copy); `disputed` cites the entry the code disagrees with;
 * `inferred` is the author's own reading. → `docs/spec/31-review-packs.md#provenance`
 */
export type ReviewProvenance =
  | { kind: 'witnessed'; entryId: string }
  | { kind: 'inferred' }
  | { kind: 'disputed'; entryId: string };

/** `cant_tell` is a first-class answer: not decidable from this repository. */
export type ReviewVerdict = 'true' | 'false' | 'cant_tell';

/**
 * What a false claim does to the document: the finding lives on the claim, and the anchor it is
 * about carries the `false` mark so the walk shows where. Drawn twice from this one field.
 */
export interface ReviewFinding {
  /** One plain line saying what is wrong. */
  headline: string;
  /** The consequence worked out, how serious it is and whose call it is. Markdown. */
  body: string;
  /**
   * The step of the idea's walk the claim is about, 1-based — the anchor that carries
   * `mark: 'false'`. Null where the contradiction is somewhere the walk never stopped, and
   * {@link counter} shows it.
   */
  step: number | null;
  /** The code that contradicts the claim, where not already on the walk — a range of the tree at the head. */
  counter: { range: ReviewRange; code: string[]; caption: string } | null;
}

/**
 * A pack as the store holds it: the document, and when it was written. Pull request and head sha
 * are copied out as columns so staleness can be checked without opening the document.
 */
export interface ReviewPackRecord {
  pack: ReviewPack;
  writtenAt: string;
}

/**
 * Whether one pull request's pack has been shared into the pool, and what became of it.
 * → `docs/spec/31-review-packs.md#sharing-a-pack`
 *
 * Sharing is a second, deliberate act — this row exists only once somebody has asked for one; no
 * row is the ordinary state. Request and publish happen on different clocks (the publish is
 * never inside a route handler), so the row carries both moments to distinguish "asked for" from
 * "in the pool". → `docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`
 */
export interface ReviewPackShare {
  prNumber: number;
  /** The head of the pack that was shared — a share is of one pack, not of a pull request. */
  headSha: string;
  requestedAt: string;
  /** When the transport took it, or null while it has not been published yet. */
  publishedAt: string | null;
  /**
   * When somebody unshared it, or null. Set only on a share that is in the pool — the copy stays
   * in the namespace until the pool's own arm removes it, and this tells the arm to. Never set
   * beside a null {@link publishedAt} (an un-published share is just deleted).
   * → `docs/spec/31-review-packs.md#unsharing-a-pack`
   */
  withdrawnAt: string | null;
  /**
   * Why the secret backstop refused it, naming the line. Null on a share nothing refused. Loud,
   * never a rewrite — the pack stays local. → `docs/spec/28-cross-fleet-pool.md#data-classification`
   */
  refusal: string | null;
}

/**
 * What a reviewer did to a pack — an attention override, an idea marked read — held beside the
 * document, never written into it, so a rewritten pack doesn't lose their marks. Keyed to a hunk,
 * never an idea, since an idea's id is minted fresh on every run.
 * → `docs/spec/31-review-packs.md#what-a-reviewer-does-is-not-part-of-the-pack`
 */
export interface ReviewMark {
  prNumber: number;
  /** The hunk the mark rides on: path and range at the head it was made against. */
  hunk: ReviewRange;
  /** The head the reviewer was looking at when they marked it. */
  headSha: string;
  /** The reviewer's label, or null where they left the checker's standing. */
  attention: ReviewAttention | null;
  /** Whether the reviewer marked the owning idea read. */
  read: boolean;
  /**
   * Whether the reviewer took the finding on this idea's false claim.
   *
   * The third column, and the only one about the **checker's** output rather than
   * the author's. It is what makes prominence measurable: the four surface
   * requirements under *What a false claim does* are checkable as an order things
   * are drawn in, and none of them says whether a false claim was read. This does
   * — a pull request that merged with a false claim nobody marked seen is the one
   * number that measures them.
   * → `docs/spec/31-review-packs.md#whether-prominence-works`
   */
  seen: boolean;
  markedAt: string;
}

/**
 * What a developer would tell a product owner about one Feature — the account rule
 * `feature-summary` dispatches an agent to write, and the one thing on the feature
 * board that is prose rather than a fold.
 *
 * Four fields rather than one document, because they are the four questions the
 * card is opened with and a reader must not have to find each of them inside a
 * paragraph. Only {@link standing} is required: a Feature with nothing usable yet,
 * nothing blocked, or nothing left are each ordinary states, and an empty section
 * says so where an invented one would be the forecast the board refuses to make.
 * → `docs/spec/17-cockpit.md#the-feature-summary`
 */
export interface FeatureSummary {
  /** The Feature, as `issue:<n>` — the same origin shape every verdict is keyed on. */
  originRef: string;
  /** Where this Feature actually is: two or three sentences, the card's whole lede. */
  standing: string;
  /** What a person can see or use today, and where. Null where the agent named nothing. */
  usable: string | null;
  /** What is stopping the rest, and what it needs from a human. Null for nothing blocked. */
  blocked: string | null;
  /** What is left to do. Null for a Feature with nothing outstanding. */
  remaining: string | null;
  /**
   * The digest of where every child stood when this was written
   * (`featureStandingKey`). What makes the summary re-writable exactly once per
   * movement: the rule dispatches when this differs from the current standing and
   * does nothing, for ever, while it matches.
   */
  standingKey: string;
  /** The writing agent and its task, from the credential. */
  agentId: string;
  taskId: string;
  /** When the Feature was *first* summarised; preserved across a revision. */
  createdAt: string;
  updatedAt: string;
}

/**
 * One "this story waits on that one", with **where the edge came from recorded on
 * it**. → `docs/spec/33-story-sequencing.md#where-the-order-comes-from`
 *
 * The provenance is not presentational. `link` is a statement a person made on
 * their own board; `inferred` is an agent's guess from the items' own text. A
 * surface that drew the two the same way would invite an operator to accept the
 * second thinking it was the first.
 */
export interface FeatureSequenceEdge {
  /** The story that waits. */
  issue: number;
  /** The story it waits on. */
  dependsOn: number;
  /**
   * Where the edge came from. `link` — the tracker's own Predecessor, drawn by a
   * person on their own board. `inferred` — the sequencer read it out of the items'
   * text. `operator` — somebody amended the order by hand, through the desktop
   * channel.
   *
   * Three rather than two because an operator's edge is neither of the others, and
   * marking one `inferred` would claim an agent guessed at a judgement a person
   * made. → `docs/spec/33-story-sequencing.md#amending-it`
   */
  source: 'link' | 'inferred' | 'operator';
  /** One line on why this edge. Null on a `link`, where the reason is that somebody drew it. */
  reason: string | null;
}

/**
 * The order the stories under one Feature are worked in.
 *
 * Only `accepted` holds anything. A `proposed` order is an agent's suggestion
 * nobody has answered and a `declined` one is an operator saying "run them all" —
 * both leave the fleet behaving exactly as it does with no row at all, which is
 * what makes every failure of this mechanism a failure to *order* rather than a
 * failure to work. → `docs/spec/33-story-sequencing.md#the-record`
 */
export interface FeatureSequence {
  /** The Feature, as `issue:<n>` — `FeatureSummary`'s key, and every verdict's. */
  originRef: string;
  status: 'proposed' | 'accepted' | 'declined';
  /** Why this order, in the sequencer's own voice. Empty on one built only from links. */
  reason: string;
  /**
   * The edge it would most like argued with, and what would change its mind.
   * `openQuestions`' job on the plan document: an order with no stated doubt is one
   * nobody can disagree with usefully. Null where every edge was drawn by a person.
   */
  unsure: string | null;
  /**
   * The digest of *which* stories were under the Feature when this was written
   * (`featureSequenceKey`) — membership, never movement. A story merging does not
   * invalidate an order; a story being added does.
   */
  standingKey: string;
  /** The order itself. Rewritten as a set, never merged. */
  edges: FeatureSequenceEdge[];
  /**
   * The stories this order was written over, ascending — every watched child the
   * Feature had, settled ones included.
   *
   * **Null on a row written before the column existed**, and null means *we cannot
   * say which stories are new*. That is the fail-open reading: a re-sequence that
   * cannot prove it only extended the order asks the operator again, which is what
   * every row did before this. → `docs/spec/33-story-sequencing.md#a-story-is-added`
   */
  members: number[] | null;
  /** Who accepted or declined it, and when. Null while it is still a proposal. */
  answeredBy: string | null;
  answeredAt: string | null;
  /** The writing agent and its task, or null for a sequence built only from links. */
  agentId: string | null;
  taskId: string | null;
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
 * - `awaiting_approval` — the planner has spoken, so a human has been asked to
 *   authorize the verdict (issue #109 phase 3) —
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
  /**
   * What is actually wrong — the root cause the planner found in the code, not a
   * restatement of the issue. Null when it said nothing, and legitimately null on
   * work that is not a defect: there is no root cause of a feature.
   */
  diagnosis: string | null;
  /**
   * What is going to be done about it, in a few sentences. The summary an operator
   * approves on, kept separate from {@link reason} because that one answers a
   * different question — a shape justification is not a description of the work,
   * and one field asked to be both is reliably neither.
   */
  approach: string | null;
  /** The planner's own justification for its verdict — why *this shape*. Null when it gave none. */
  reason: string | null;
  /** What could go wrong with this split, as the planner saw it. Null when it said nothing. */
  risks: string | null;
  /** What the planner deliberately left out. */
  outOfScope: string | null;
  /**
   * What the planner considered and rejected, and why. Null when it said nothing.
   *
   * Its own field rather than a paragraph of {@link document} because of *when* it
   * is read: it is the most useful thing an approver can have and it was reachable
   * only by opening the write-up and scrolling, which is not what anyone does with
   * a decision in front of them.
   */
  alternatives: string | null;
  /** What the planner is least sure about — the agenda a discussion opens on. */
  openQuestions: string | null;
  /**
   * How anyone will know the *whole* thing worked. Distinct from a part's
   * `acceptance`, which answers the same question one branch at a time and never
   * for the issue — which is the question `issue-assess` is later handed cold.
   */
  verification: string | null;
  /**
   * Where in the code the diagnosis comes from. Empty when the planner cited
   * nothing, which is every plan written before the field existed.
   *
   * A root cause with no citation is unfalsifiable, and the harness asks for
   * testimony to be attributable everywhere else it takes any (`raise`).
   */
  evidence: PlanEvidence[];
  /** The full narrative, markdown — the read-in-depth version of this plan. */
  document: string | null;
  /** Provider comment id for the plan's status comment, edited in place (stage 3). */
  statusCommentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One thing about a plan an operator has to have *read* before they may release
 * it (`src/plans/planCaveats.ts`).
 *
 * A plan approval used to be a click on a card whose warnings were prose in the
 * body: the planner's own uncertainty, a part that is already blocked, a pull
 * request open on the issue that belongs to no part of the plan. Prose is
 * skippable, and the one verdict that starts every agent, branch and pull request
 * the plan declares was the easiest thing on the page to give without reading it.
 * A caveat is that same sentence made into a thing the operator ticks, and the
 * accept refuses while any of them is unticked.
 *
 * `id` is what the acknowledgement names, and it is stable for the life of one
 * proposal because it is stored on the action the proposal carries — the gate
 * compares what was ticked against what that row declares, never against a
 * re-derivation from a world that has moved since the card was drawn.
 */
export interface PlanCaveat {
  /** Stable within one proposal; what an acknowledgement names. */
  id: string;
  /**
   * The short line the operator is ticking — a title, not a paragraph. What it is
   * *about* goes in {@link detail}, so a checklist of several reads as a list
   * rather than as the wall of prose it replaced.
   */
  label: string;
  /** What the label is about: the planner's own words, or the stored reason. */
  detail: string | null;
}

/**
 * The plan-level prose of one verdict, gathered so a revision can hold it whole.
 *
 * Every field is on {@link Plan} as well, and that is not duplication: the plan row
 * is what the harness acts on *now*, while a revision is what was said *then* —
 * and the row is overwritten by every amendment, which is exactly the reason the
 * snapshot has to exist separately.
 */
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

/**
 * One verdict, exactly as the planner submitted it.
 *
 * Written at ingestion — the one place a document becomes rows — so the record is
 * of what was *proposed*, not of what the store made of it. That distinction is
 * the whole value on a replan: a part the amendment dropped but `partsToRetire`
 * kept (because work had started) appears as dropped here and as live on the plan,
 * and both readings are true.
 */
export interface PlanRevision {
  id: string;
  planId: string;
  /** 1-based. v1 is the first plan ever ingested for this plan row. */
  seq: number;
  narrative: PlanNarrative;
  /** The parts as declared, in document order. Never empty — a plan declares at least one. */
  parts: PlanPartInput[];
  at: string;
}

/**
 * Who wants the plan changed. Only the settlement differs — an operator's own
 * amendment is still proposed rather than applied, because the point of the gate
 * is that a plan under way changes only on a decision somebody took deliberately,
 * and the person arguing with a plan at their keyboard is not always the person
 * who approved it.
 */
export type PlanAmendmentAuthor = 'agent' | 'operator';

/**
 * Where a proposed amendment stands. `superseded` is the terminal for one the
 * world overtook — the plan was replanned, or abandoned, under it — and is not a
 * verdict anybody gave.
 */
export type PlanAmendmentStatus = 'pending' | 'applied' | 'declined' | 'superseded';

/**
 * A correction to a plan that is **already running**, waiting on an operator.
 *
 * The row exists because the alternative is the one thing a live plan must not do:
 * rewrite itself under the agents working it. An agent that finds the plan wrong
 * halfway through a part, or an operator who reads it again and disagrees, records
 * one of these; the plan keeps scheduling exactly as it was until the amendment is
 * approved, and applying it is the ordinary ingestion — merged on slug, so work in
 * flight keeps its branch, its pull request and its progress.
 *
 * The document is kept as submitted and re-validated at apply time, by the same
 * `validatePlanDocument` the two transports use: what an operator approved and
 * what is ingested are then the same document.
 */
export interface PlanAmendment {
  id: string;
  planId: string;
  /** `issue:<n>` — the goal, so a reader need not resolve the plan first. */
  originRef: string;
  /** The proposed plan document, serialized. Parsed and validated where it is applied. */
  document: string;
  /** Why the plan must change. The whole of what an operator is shown beside the diff. */
  note: string;
  author: PlanAmendmentAuthor;
  /** The agent that proposed it, for the audit line. Null for an operator's own. */
  authorRef: string | null;
  status: PlanAmendmentStatus;
  /** What settled it: the operator's note, or why the harness withdrew it. */
  resolution: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * One place in the code a plan's diagnosis rests on — the planner's citation.
 *
 * `line` is optional because a claim is often about a file rather than a line, and
 * a planner made to invent one would invent one. `note` says what the reader is
 * meant to see there; without it a citation is a path, which is not evidence.
 */
export interface PlanEvidence {
  path: string;
  line: number | null;
  note: string | null;
}

/**
 * Where one validation check stands.
 *
 * `unrun` is the state everything starts in and the one the flag is loudest
 * about: with every check a person's by default, the realistic failure is the set
 * nobody got to, so silence is counted as a finding rather than as an absence —
 * the same refusal `undeclared` makes about a conclusion nobody declared.
 *
 * `waived` and `deferred` are two operator acts with opposite effects on the
 * flag, and they are kept apart because collapsing them would make one of them
 * dishonest: "the test environment is rebuilt on Thursday" is not "I am not going
 * to check this".
 */
export type ValidationCheckState = 'unrun' | 'passed' | 'failed' | 'waived' | 'deferred';

/**
 * Who is expected to run a check — **the operator's decision, and only theirs**.
 *
 * `human` is the default and stays the default. The planner's {@link
 * ValidationCheck.fleetCandidate} is a nomination and does not set this: whether
 * an agent can run a check is a property of the deployment (what logins it has,
 * whether anything can drive a browser), which a planner reading the repository
 * cannot know. A wrong guess is a check dispatched against a login the fleet does
 * not have, so the nomination is information and the deciding stays with the
 * person who has the information.
 *
 * `fleet` is a hand-over: the operator has read the check and said the harness's
 * own agents may run it. It is not permanent — an agent that finds it cannot do
 * the work hands it back (see {@link ValidationCheck.handbackNote}), and a
 * rewording returns it, because the hand-over was a decision about wording that
 * no longer exists.
 */
export type ValidationCheckActor = 'human' | 'fleet';

/**
 * Who took a reading, and the three are genuinely different claims about how
 * much a tick is worth.
 *
 * - `operator` — a person ran the procedure and ticked it. The default a
 *   validation checklist already means, which is why it is the one that draws no
 *   marker anywhere.
 * - `agent` — a fleet agent the operator handed the check to ran it unattended.
 * - `desktop` — the operator's own Claude Code session ran it, at their keyboard,
 *   on their machine. Not the fleet, because nobody dispatched it and it reached
 *   an environment the fleet cannot; and not a person, because a person did not
 *   carry out the steps.
 *
 * The distinction is the point rather than bookkeeping: a reader deciding whether
 * to re-run a check before closing a goal is deciding on exactly this.
 */
export type ValidationCheckResultBy = 'operator' | 'agent' | 'desktop';

/**
 * One executable step in a goal's validation plan: what to do, what a pass looks
 * like, and what anyone concluded from running it.
 *
 * Validation is **per goal**, not per part. A check usually spans several parts —
 * the question it answers is whether the goal works — and {@link
 * ValidationCheck.covers} only lets it say which parts it exercises.
 */
export interface ValidationCheck {
  /**
   * The **goal** this check belongs to, as `issue:<n>` — the same `originRef` a
   * plan carries.
   *
   * Keyed on the goal rather than on the plan because that is what validation is
   * about. A plan is 1:1 with a goal today, which is what let `plan_id` stand in
   * for this, but it is the wrong key wearing the right key's clothes: a check
   * outlives any one plan of the work, and nothing about it is a property of the
   * decomposition.
   */
  originRef: string;
  /**
   * The author's own kebab-case slug, and **the merge key**: an amended plan
   * merges onto this row rather than replacing it, so it has to survive a replan
   * exactly as a part's slug does.
   */
  id: string;
  /**
   * `A`, `B`, `C`… — the handle a person types. Assigned at ingestion, stored,
   * and never reused or reassigned, so a check named in a note yesterday is the
   * same check today. Derived from position instead, it would silently move under
   * the next amendment.
   */
  letter: string;
  /** Declaration order within the document, for rendering. Not the letter. */
  seq: number;
  title: string;
  /** The procedure, markdown. */
  do: string;
  /** What a pass looks like. A check that cannot say this is not a check. */
  expect: string;
  /** Names of the declared resources this check needs — never paths. */
  uses: string[];
  /** Part slugs this check exercises. Any number, including none. */
  covers: string[];
  /**
   * The planner's nomination that an agent could run this, with {@link
   * ValidationCheck.candidateWhy}. A suggestion and nothing else: whether an
   * agent *can* run a check is a property of the deployment, not of the check.
   */
  fleetCandidate: boolean;
  candidateWhy: string | null;
  /**
   * Who is expected to run it. `human` unless an operator handed it over — see
   * {@link ValidationCheckActor}, and note that this is deliberately *not*
   * derived from {@link ValidationCheck.fleetCandidate}.
   */
  actor: ValidationCheckActor;
  /**
   * Why the fleet gave this check back, in the agent's words, and null once
   * anything has been recorded about the check since.
   *
   * The alternative is an agent recording `failed` when it simply could not get
   * to the environment, which is the most expensive possible lie: it flags the
   * goal for a reason that has nothing to do with the goal. A hand-back leaves
   * the state exactly as it was and says what stopped it.
   */
  handbackNote: string | null;
  state: ValidationCheckState;
  /**
   * Required with every result, and with a deferral or a waiver — except a
   * `passed` result, where it is optional: the person clicking through their own
   * checklist is watching it happen, so nothing is lost by leaving it blank.
   */
  resultNote: string | null;
  /**
   * Who took the reading. **Drawn wherever the reading is**, because "an agent
   * says this passed" and "I ran it and it passed" are different facts, and the
   * whole feature exists to stop the second being assumed from evidence that only
   * supports the first.
   */
  resultBy: ValidationCheckResultBy | null;
  resultAt: string | null;
  /**
   * The label a desktop session claimed this check under, and null when nobody
   * holds it. **At most one live claim exists across the whole harness** — the
   * operator's own constraint, said as they said it: they can only run a single
   * branch at once, and two things reaching for it is the failure the claim
   * exists to prevent.
   *
   * A claim is not {@link ValidationCheck.actor}. The actor says who is expected
   * to run a check; a claim says who is running it *now*, and it stops the fleet
   * dispatching one out from under a person mid-run.
   */
  claimedBy: string | null;
  /**
   * When the claim was taken. A claim older than `validation.desktopClaimMinutes`
   * is stale and holds nothing — the backstop for a harness that was killed
   * between a claim and its release, which no socket close can cover.
   */
  claimedAt: string | null;
  /** When a deferral says it comes back. Null is "not yet, and I am not saying when". */
  deferUntil: string | null;
  /**
   * Why an amendment stopped declaring this check. Null is a live check; set is
   * one kept for its record, greyed, and outside the verdict — the same
   * settlement an amended plan gives a part it dropped.
   */
  supersededReason: string | null;
  /**
   * What an amendment replaced, and the reading it cost. Null on a check nothing
   * has amended, and on one whose new reading has since been recorded — see
   * {@link ValidationCheck.amendedAt}.
   */
  revision: ValidationRevision | null;
  /**
   * When an amendment last changed this check, and the flag the cockpit draws its
   * band from. **Cleared by the next recorded reading**, because the band exists
   * to say "this is not the check you ran" and an operator who has just run it has
   * been told. Set with no {@link ValidationCheck.revision} on a check an
   * amendment *added*: there is no prior wording, and the operator still needs to
   * know it appeared after they read the plan.
   */
  amendedAt: string | null;
  /** Why it changed, in the amender's words. Required of every amendment. */
  amendNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The wording an amendment replaced, and the reading that was withdrawn with it.
 *
 * Kept as one record rather than as loose columns because it is read as one — a
 * band saying "you passed this, and then it changed to say something else" is
 * only meaningful with both halves. `state` is null when the check had not been
 * run: an amendment to an `unrun` check costs nothing, and saying it withdrew a
 * reading nobody took would be an invention.
 */
export interface ValidationRevision {
  title: string;
  do: string;
  expect: string;
  /** The withdrawn reading, or null when the check was `unrun` at the time. */
  state: ValidationCheckState | null;
  /** The withdrawn reading's note. */
  note: string | null;
}

/**
 * A check as a document declares it — everything the author writes, and nothing
 * the harness or an operator later records about it.
 *
 * The split is the same one {@link PlanPartInput} makes against {@link PlanPart},
 * and it is what lets an amendment re-declare a check without wiping a result:
 * the fields here are refreshed, the rest are progress and are left alone.
 * **There is no `state` and no actor** — a document cannot say who runs a check
 * or how it went.
 */
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

/**
 * One check of an amendment: the same declaration, minus the sequence number.
 *
 * An amendment names the checks it is changing and says nothing about the rest,
 * so there is no document order to take a `seq` from — the store assigns one
 * after the last, which is also the only honest place for it. A caller that had
 * to compute the number would have to read the plan's checks first, and would
 * then be one race away from two checks claiming the same position.
 */
export type ValidationCheckAmendment = Omit<ValidationCheckInput, 'seq'>;

/**
 * What one amendment does to a plan's validation block.
 *
 * **Merge-only, and that is the whole difference from an ingestion.**
 * `ingestValidation` reads a document that declares the *entire* check set, so a
 * check it omits was withdrawn. An amendment declares only what it is changing:
 * an omitted check is untouched, and withdrawing one is said out loud in
 * {@link ValidationAmendment.withdraw}, with a reason. The alternative — letting
 * an agent send a short list and having the harness read the omissions as
 * withdrawals — is a validation plan an agent can delete by being terse.
 */
export interface ValidationAmendment {
  /** Added when the id is new, merged onto the row when it is not. */
  checks: ValidationCheckAmendment[];
  /** Superseded, never deleted — the row stays, and so does its letter. */
  withdraw: { id: string; reason: string }[];
  /** Merged by name; nothing here removes a resource another check may still use. */
  resources: ValidationResourceInput[];
  /** Why the plan is changing. Goes on every check this amendment touches. */
  note: string;
}

/** What an amendment did, so the caller can be told what it cost. */
export interface ValidationAmendResult {
  added: ValidationCheck[];
  /**
   * Checks whose wording changed. Each carries the {@link ValidationRevision} it
   * cost, which is how an agent learns that its rewording withdrew a pass.
   */
  reworded: ValidationCheck[];
  /** Ids re-declared with identical wording — a no-op, reported rather than hidden. */
  unchanged: string[];
  withdrawn: string[];
  /** Ids named for withdrawal that this plan does not have, or had already withdrawn. */
  unknown: string[];
}

/** A resource as a document declares it. */
export interface ValidationResourceInput {
  name: string;
  kind: ValidationResourceKind | null;
  note: string | null;
  provided: boolean;
}

/** What kind of thing a validation resource is. Null is "the planner did not say". */
export type ValidationResourceKind = 'fixture' | 'access' | 'reference' | 'data';

/**
 * Something a check needs that is not in the repository: a seeded fixture, a
 * reference screenshot, an account on an environment.
 *
 * Named rather than pathed. The path an agent sees, the path the cockpit serves
 * and the path an operator opens are three different strings, and a stored
 * absolute path is wrong for two of them the moment `validationRoot` moves.
 */
export interface ValidationResource {
  /** The goal it belongs to, as `issue:<n>` — {@link ValidationCheck.originRef}. */
  originRef: string;
  name: string;
  kind: ValidationResourceKind | null;
  note: string | null;
  /**
   * False is the planner saying it needs something it cannot produce, and
   * ingestion files a `human_tasks` row asking for it — so a missing resource is
   * an ask rather than a check that mysteriously never runs.
   */
  provided: boolean;
  /** The ask that was filed for an unprovided resource. Null when none was. */
  humanTaskId: string | null;
}

/**
 * Whether a goal's validation plan is settled, and by how much it is not.
 *
 * `flagged` **blocks nothing** — no merge, no dispatch, no conclusion. It changes
 * exactly one thing: what closing the goal looks like.
 */
export interface ValidationVerdict {
  state: 'clear' | 'flagged';
  /** Live checks only — a superseded one is out of the count as well as out of the sheet. */
  total: number;
  passed: number;
  failed: number;
  unrun: number;
  deferred: number;
  waived: number;
}

/**
 * How big a part is to *review*, as the planner judged it — not how long it takes.
 * Three values rather than a number, for the reason story points are not hours:
 * the useful signal is "this one is not like the others", and any finer scale
 * invites a precision the planner does not have.
 */
export type PartSize = 's' | 'm' | 'l';

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
  /**
   * The same claim as {@link scope}, as paths rather than prose. Empty when the
   * planner declared none.
   *
   * Two fields rather than one because they are read by different things and only
   * one of them can be *checked*: `scope` is what the part's agent is told, at
   * whatever grain the work has, while these are what a merged part's writes are
   * compared against (`partScopeDrift`). Narrowing `scope` to an array would have
   * cost the prose; deriving the array by parsing the prose would have invented
   * paths nobody declared.
   */
  touches: string[];
  /** Why this is its own PR rather than folded into a sibling. */
  rationale: string | null;
  /** What makes this part done. */
  acceptance: string | null;
  /**
   * Which of the criteria in {@link acceptance} a reviewer has confirmed, held as
   * the criterion text itself rather than an index.
   *
   * Keyed on the text so a re-declared criterion loses its tick, which is the
   * behaviour worth having: an amendment that rewords what "done" means has
   * withdrawn the thing that was confirmed. An index would silently carry the tick
   * across to a criterion nobody looked at.
   */
  acceptanceMet: string[];
  /** How big this part is to review, as the planner judged it. Null when unstated. */
  size: PartSize | null;
  /** What the planner expected this part to produce. Null means unstated, which reads as `code`. */
  expectedKind: PartOutcomeKind | null;
  /**
   * The model profile this part's own work should run on (issue #342), or null to
   * inherit the goal's pin — which is the common case and the one the planner
   * should leave alone.
   *
   * Named by the planner, because it is the stage that knows: it has just cut the
   * decomposition, and the part it made narrow enough to state acceptance
   * criteria for is the part it can price. Overridable from the cockpit, since a
   * plan is a proposal and this is one of its claims.
   *
   * A plain string for {@link PlanPart.slug}'s neighbours' reason — a profile
   * this deployment no longer configures reads back as what the plan said, and
   * `resolveAgentProfile` falls through to the rule rather than resolving to
   * nothing.
   *
   * Optional on the same terms as {@link Task.model}: every stored row has it,
   * and a caller building a part in a test has one fewer field to state.
   */
  profile?: string | null;
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
  /**
   * **Which** of the two blockers put it there, for the readers that must tell
   * them apart — {@link planIsWedged} above all, which escalates one and must not
   * escalate the other.
   *
   * Carried on the row rather than re-derived from {@link blockedReason}'s prose:
   * the reconciler is the only writer and already knows which it wrote, and a
   * reader sniffing the sentence would be one rewording away from silently
   * escalating a refusal back at the operator who made it.
   *
   * Null on every unblocked part, and null on a blocked one from a database before
   * the column existed — read as *unattributed*, which counts toward the wedge the
   * way it did before there was anything to attribute.
   */
  blockedBy: PlanPartBlocker | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The two things that block a plan part, named so a reader can tell them apart.
 *
 * A **collision** is git's: `refs/heads/issue/12` is taken, so no part's branch
 * can be cut, and it blocks every part together or none. A **decline** is the
 * operator's: they refused one human step, and it blocks that part alone.
 *
 * One predicate answering for both is the bug in #505 — the collision's "every
 * live part is blocked" reading escalates a refusal back at the person who made
 * it, and misses the collision the moment one sibling has settled.
 */
export type PlanPartBlocker = 'collision' | 'declined';

/** A part as the planner declared it, before the store assigns identity or progress. */
export type PlanPartInput = Pick<
  PlanPart,
  | 'slug'
  | 'seq'
  | 'title'
  | 'scope'
  | 'touches'
  | 'dependsOn'
  | 'rationale'
  | 'acceptance'
  | 'size'
  | 'expectedKind'
  | 'profile'
>;

/** One cumulative usage report from a session's turn-end `result` event. */
export interface AgentUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The cached share of {@link AgentUsage.inputTokens} — see {@link Agent.cacheReadTokens}. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
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
 * appraisal, each part, and the pull requests those parts opened — is spend on that
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
  /** How many agent runs the totals are over. Zero on a goal whose only measured spend is a local run. */
  agents: number;
  /**
   * How many local runs are in the totals — an operator bringing this goal's branch
   * up on their own machine, which is billed to the same account.
   *
   * Counted separately rather than added to {@link IssueSpend.agents} because the
   * cockpit prints that figure as "Agents" and a local run is not one. The money is
   * in `costUsd` either way: it was spent on this goal.
   */
  localRuns: number;
}

/**
 * A park held on an agent that stopped without saying why, and when it settles
 * itself as done (`agentStallParkMs` from the park, or from the last Extend).
 *
 * The pair rather than the id alone — which is all a limit park needs on the wire —
 * because this park is drawn as a countdown, and a countdown with no end to count
 * to is a chip that says "soon".
 */
export interface StallPark {
  agentId: string;
  /** ISO, always present: a park with no deadline is never entered into. */
  expiresAt: string;
}

/** One subscriber rate-limit window (5h or weekly) as Claude Code reports it. */
export interface RateLimitWindow {
  usedPercentage: number;
  /** ISO timestamp the window resets at, when reported. */
  resetsAt: string | null;
}

/**
 * Account-level Claude usage windows, read off the `rate_limit_event` every
 * stream agent receives. Pro/Max only — API-key auth carries no windows at all,
 * and each window can be independently absent.
 *
 * Turn-bound, which is what {@link AccountRateLimits.capturedAt} is for: a
 * reading arrives only when an agent takes a turn, so an idle fleet's ages while
 * the real window keeps moving underneath it (an operator's own Claude Code on
 * the same account spends from it too). Stale-and-optimistic is the failure mode
 * to render honestly, not to hide.
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
  method?: string;
  autoMergeFailed?: boolean;
  // -- propose_plan escalations -------------------------------------------
  /** The plan whose decomposition this item asks you to authorize (issue #109 phase 3). */
  planId?: string;
  // -- issue-shortfall escalations ----------------------------------------
  /**
   * The goal a shortfall item is about. Carried on both of the rule's arms —
   * the escalation and the proposal — so the card's overrule can name the issue
   * it writes a verdict for rather than stripping the number back out of
   * `originRef`, which is `refLabel`'s job and nothing else's.
   */
  issueNumber?: number;
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

/**
 * When one escalation stood, and the only two handles there are on what it stood
 * *about* — the projection the runway lens measures a hold from.
 *
 * A projection rather than the row because `listEscalations` is all-time and
 * carries every settled item's `recentOutput` transcript tail with it, and the
 * runway is re-read on every cockpit refresh. This is four columns and no JSON
 * body.
 *
 * Deliberately raw. There is no `originRef: string` here resolved to a goal,
 * because {@link EscalationContext} populates a different subset per escalation
 * type — a merge approval carries `prNumber` and no ref at all — and deciding
 * which of the two reaches which goal is the lens's judgement to make, not a
 * caller's. → `docs/spec/25-supply.md#the-lead-time-is-fleet-time`
 */
export interface EscalationSpan {
  createdAt: string;
  /**
   * When a person answered, or null. Null covers two different things and the
   * lens has to tell them apart: an item still open (the hold is running now)
   * and one dismissed without an answer (`dismissEscalation` stamps no time, so
   * when that hold ended is not recorded anywhere) — which is what {@link open}
   * is for.
   */
  answeredAt: string | null;
  /** `context.originRef`, verbatim: `issue:12`, `pr:42:ci`, or absent. */
  originRef: string | null;
  /** `context.prNumber`, verbatim — the only handle the merge and reply arms carry. */
  prNumber: number | null;
  open: boolean;
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
export type ProposalKind = 'reply_draft' | 'merge' | 'plan' | 'shortfall' | 'plan_amendment';

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
   * Who decided. `human` is a click in the cockpit; `stack_landing` is the
   * operator having authorized a whole chain in advance, over the pull request
   * numbers it was clicked across, before any rung of it was proposed.
   *
   * `auto_send` is the operator having authorized a *class* of act in advance,
   * in their config, rather than one chain of pull requests with a click:
   * `sendPrRepliesWithoutApproval` sends a drafted review reply without asking.
   * It is scoped to replies and it can only ever *accept* — a machine "no" would
   * mean the question is never put to anyone.
   *
   * It also predates that key: the removed confidence gate wrote the same value,
   * so a database from before it went carries rows with no config key behind
   * them. Both read as "auto-send authorized", which is what they were.
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
  | 'propose_plan_amendment'
  | 'propose_shortfall'
  | 'update_pr_branch'
  | 'requeue_ci_check'
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

/**
 * How far along a deliberate upgrade of the harness's *own* build is — see
 * `src/selfUpdate/upgradePlan.ts` for the transitions and
 * `src/store/upgrades.ts` for why it is persisted when the pause flag is not.
 */
export type UpgradeState = 'idle' | 'draining' | 'ready' | 'applying';

/** What the operator asked the upgrade to do, and what a cancel must undo. */
export interface UpgradeIntent {
  state: UpgradeState;
  /**
   * The upstream commit the operator accepted. Carried so the next boot can say
   * which build it came up on, including when the supervisor landed somewhere
   * else because upstream moved again mid-handoff.
   */
  targetSha: string | null;
  requestedAt: string | null;
  /**
   * Whether the *drain* is what paused dispatch. Load-bearing on cancel: a fleet
   * the operator had already paused themselves must stay paused, and a blanket
   * un-pause on cancel would silently start dispatching for them.
   */
  pausedByDrain: boolean;
}

// -- Pets --------------------------------------------------------------------

/**
 * The twenty-seven creatures a deployment can collect. One vivarium per database,
 * so a species is a fact about the harness rather than about a profile of it.
 *
 * The set is closed and the keys are stored, so a species is never renamed — the
 * display name in `src/pets/catalogue.ts` is what changes when one reads wrong.
 */
export type PetSpecies =
  // common — two universals, then one signature per action kind
  | 'pip'
  | 'mote'
  | 'nib'
  | 'tuft'
  | 'beck'
  | 'berth'
  | 'stoke'
  | 'speck'
  | 'patch'
  // uncommon
  | 'warden'
  | 'cinder'
  | 'nocturne'
  | 'chit'
  | 'vellum'
  | 'drift'
  | 'bramble'
  // rare
  | 'lander'
  | 'quill'
  | 'cairn'
  | 'ingot'
  // mythic — one signature per action kind, and no action without one
  | 'clarion'
  | 'covenant'
  | 'oracle'
  | 'keystone'
  | 'forge'
  | 'lodestone'
  | 'ouroboros';

/** How hard a species is to draw, and how long it takes to raise. */
export type PetRarity = 'common' | 'uncommon' | 'rare' | 'mythic';

/** How far a pet has been raised. Derived from what it has been fed, never stored. */
export type PetStage = 'hatchling' | 'juvenile' | 'adult';

/**
 * Where a pet can come from — one operator action, named.
 *
 * **Persisted on the row it hatched.** `pets.origin_kind` carries this word, and
 * the cockpit derives a pet's colours and markings from the `<kind>:<ref>` seed —
 * so renaming a member does not rename a category, it orphans every creature
 * already hatched from one. Which is why `finding` is still here: nothing produces
 * one any more (a claim an operator rules on is `claim`, since the three claim
 * stores became one), and every row carrying it is a pet somebody has had for
 * months. It is retired rather than removed, the way a `PromptId` is.
 */
export type PetActionKind = 'escalation' | 'human-task' | 'plan' | 'landing' | 'job' | 'claim' | 'finding' | 'upgrade';

/** One hatched creature. */
export interface Pet {
  id: string;
  species: PetSpecies;
  /**
   * The action key it hatched from (`escalation:esc_9f2a`), which is also what
   * the cockpit derives its colours and markings from — so two `pip`s are the
   * same animal and visibly not the same pet, at no cost in drawn sprites.
   */
  seed: string;
  /** What the operator called it, or null for the species' own name. */
  name: string | null;
  /** Beats spent on it, cumulative. The only input to its stage. */
  fed: number;
  originKind: PetActionKind;
  originRef: string;
  /** When the action it hatched from happened — not when the scan reached it. */
  hatchedAt: string;
  /**
   * When the operator cracked the shell, or null while it is still an egg.
   *
   * The drop and the reveal are two moments, and this is the second one. Nothing
   * about the creature is decided here — the species and the tier were fixed by
   * the hash of the action the instant it was rolled, and the shell only withholds
   * them. A roll at opening time would put the one decision this subsystem makes
   * behind a click, which is the whole of what the hash exists to prevent.
   *
   * Null on nothing that predates eggs: `openPetsFromBeforeEggs` stamps every
   * existing row on the boot the column arrives, because a collection an operator
   * spent months on must not turn back into a pile of shells because the harness
   * learned a new trick. → `docs/spec/22-pets.md#the-egg`
   */
  openedAt: string | null;
  /** Whether it stands in the vivarium at the foot of the rail. */
  placed: boolean;
  /**
   * When a duplicate was blended into beats, or null while the animal is alive.
   *
   * A stamp rather than a `DELETE`, because the panel's origin line — the night
   * you answered the thing that produced this pet — is the one part of the
   * subsystem that gets better the longer a deployment runs, and a row removed
   * takes that record with it. A dissolved pet keeps its species, its seed and
   * its origin, draws greyed, and can no longer be fed or placed.
   */
  dissolvedAt: string | null;
  /**
   * The harness build that rolled it, and whether that build's own checkout was
   * clean. Null and false when no reading could be taken.
   *
   * Taking the rates out of the config stops an operator dialling a vivarium into
   * existence; it stops nothing at all for one willing to edit `src/pets/rules.ts`
   * and restart. This is what makes that visible — and what lets the replay check
   * accuse anything safely, since a pet stamped with a build that is not the
   * running one is a pet the running constants cannot judge.
   */
  builtSha: string | null;
  builtClean: boolean;
  /**
   * This row's link in the hatch chain: its identity hashed onto the link before
   * it. Null on every pet from before the chain existed.
   */
  chain: string | null;
}

/**
 * Why a pet does not verify against the record of what the operator did.
 *
 * Coded rather than a boolean, because "this one is not real" is a sentence
 * an operator will want a reason for — and the reasons are different enough that
 * one of them is a bug in the harness rather than a forgery. → `src/pets/attest.ts`
 */
/** One failed check, with the sentence the card draws under the sprite. */
export interface PetFlaw {
  code: 'unrecorded' | 'misdated' | 'impossible' | 'overfed' | 'broken-chain' | 'unearned';
  note: string;
}

/**
 * What kind of build hatched a pet, as the card reports it.
 *
 * `unknown` is the honest answer for every pet from before the stamp existed, and
 * for a tarball install that is not a git checkout at all. It is **not** a
 * suspicion: the checks that could accuse a pet decline to judge an unknown build
 * rather than assuming the worst of it.
 */
export type PetProvenance = 'official' | 'modified' | 'unknown';

/**
 * One operator action the scan has already rolled, and what came of it.
 *
 * Recorded for every qualifying action rather than only the ones that hatched,
 * because "how many actions since the last pet" is what the pity rule reads and
 * a table of hatches alone cannot answer it. It is also what makes a re-scan
 * free: an action already here is skipped rather than re-rolled.
 */
export interface PetAction {
  kind: PetActionKind;
  ref: string;
  at: string;
  /** The pet this action hatched, or null when the roll came up empty. */
  petId: string | null;
}

/** What beats there are, and where they went. All three are derived at read time. */
export interface PetWallet {
  /**
   * `floor(cost since the last clearance × PET_RULES.beatsPerDollar)`. Only ever
   * grows — until a clearance moves the floor, which is the one thing that takes
   * it back to zero. → {@link PetReset}
   */
  earned: number;
  spent: number;
  balance: number;
}

/**
 * One clearance of the vivarium: when it ran, and how much it released.
 *
 * Named rather than counted, because what a build asks is "has *this* clearance
 * run here", and a build that asked "has any" would leave the next one unable to
 * happen. `at` is the epoch the wallet counts fleet spend from afterwards.
 */
export interface PetReset {
  id: string;
  at: string;
  /** How many pets it released. Nothing reads it; it is the record of what went. */
  cleared: number;
}

// ---------------------------------------------------------------------------
// Environments — where a goal's landed work has actually got to
// ---------------------------------------------------------------------------

/**
 * A goal's work arriving on the integration branch: the commit one of its pull
 * requests landed as, recorded against the goal it belonged to.
 *
 * **The SHA is a provider fact and cannot be recovered later.** `merge_pr` squashes,
 * and a squash-merged branch has no ancestry link to its base — so the branch tip
 * answers "is this in production" with a permanent no. What a downstream check has
 * to be handed is the commit the merge *created*, which only the provider reports
 * ({@link PullRequest.mergeCommitSha}).
 *
 * Keyed on the pull request, for {@link BranchReapStore}'s reason: a branch name is
 * reusable, and a goal can land more than once.
 */
export interface GoalLanding {
  /** The pull request that landed. */
  prNumber: number;
  /** The goal it was work for, `issue:<n>` — the key every verdict on a goal is written against. */
  goalRef: string;
  /** The commit the merge produced on the base branch. */
  sha: string;
  recordedAt: string;
}

/**
 * Whether a commit has got to an environment.
 *
 * Three values and not two. A probe that cannot answer — the command is missing, it
 * timed out, the cluster credentials expired — must not be readable as "not
 * deployed": that is the same word the true answer uses, and the operator has no
 * way to tell which one they are looking at. `unknown` is asked again; `absent` is
 * asked again too, and only `reached` is ever final.
 * → `docs/spec/24-environments.md#the-three-verdicts`
 */
export type EnvironmentReachStatus = 'reached' | 'absent' | 'unknown';

/** One probe's answer about one commit, kept so the next pulse need not re-ask it. */
export interface EnvironmentReading {
  sha: string;
  /** The environment's name as the operator configured it. */
  environment: string;
  status: EnvironmentReachStatus;
  /** Why, for an `unknown` — the exit code, the signal, or the stderr's first line. */
  detail: string | null;
  observedAt: string;
}

/**
 * Whether an environment is **well**, as its own health check answered.
 *
 * Beside {@link EnvironmentReachStatus} and deliberately not folded into it: reach
 * is a question about one commit and health is a question about the environment,
 * and the two have different right answers at the same moment — a testUk holding
 * every commit a goal owns while its search index is down is `reached` and it is
 * `unhealthy`. Folded, the loudest half of the pair would be the one nobody could
 * see. → `docs/spec/24-environments.md#is-the-environment-well`
 *
 * Three values, for {@link EnvironmentReachStatus}'s reason. A check that could
 * not answer — the command is missing, it timed out, the credentials expired —
 * must be readable as neither `healthy` nor `unhealthy`: the first is an
 * environment nobody is watching reporting that it is fine, and the second is a
 * page in the night about a credential.
 */
export type EnvironmentHealthState = 'healthy' | 'unhealthy' | 'unknown';

/**
 * How bad an `unhealthy` environment is, worst first.
 *
 * A closed set because the tier is what decides how loudly the reading is drawn,
 * and a tier the cockpit cannot rank would be drawn at some tone nobody asked for.
 * A report naming another word is refused and says so on the glass, where the
 * person who wrote the script will read it.
 */
export type EnvironmentHealthTier = 'red' | 'orange';

/** The current standing of one environment's health check — one row, replaced each reading. */
export interface EnvironmentHealthReading {
  /** The environment's name as the operator configured it. */
  environment: string;
  state: EnvironmentHealthState;
  /** How bad, for an `unhealthy`. Null everywhere else, and null on an untiered one. */
  tier: EnvironmentHealthTier | null;
  /** What the check said is wrong, in its own words. Drawn verbatim, never parsed. */
  reasons: string[];
  /** Why, for an `unknown` the harness refused rather than the check declared. */
  detail: string | null;
  /** When the check last answered — as precise as `environmentHealthIntervalMs`. */
  observedAt: string;
  /**
   * When it last became what it is now.
   *
   * Held because "red" and "red since Tuesday" are different sentences, and the
   * second is the one an operator acts on. Moved by a change of state or tier and
   * **not** by a change of reasons: a check whose reason list shifts under the same
   * tier is the same episode still running, and a clock restarting under it every
   * five minutes would report a fresh outage forever.
   */
  changedAt: string;
}

/**
 * A whole goal's standing in one environment, folded from its landings.
 *
 * `partial` is the reading this exists for: a goal is several pull requests, they
 * land separately, and a release cut between two of them puts half a feature in
 * production. Folded to a boolean that reads as "shipped", which is the wrong
 * answer in the expensive direction.
 */
export type GoalReachStatus = 'reached' | 'partial' | 'absent' | 'unknown';

export interface GoalEnvironmentReach {
  environment: string;
  status: GoalReachStatus;
  /**
   * How many of the goal's landings this environment has, out of everything the
   * goal owes: its landings, its merges nothing could attribute, **and its plan
   * parts that have yet to merge**. The last of those is why the fraction does not
   * close the day part one of four lands — work with no commit yet is work no
   * environment is holding. → `docs/spec/24-environments.md#the-lens`
   */
  landed: number;
  total: number;
  /**
   * When the environment was first seen holding the goal's *last* landing — the
   * moment the whole goal was there. Null unless `status` is `reached`, and only
   * ever as precise as the probe interval.
   */
  at: string | null;
  /**
   * Which delivered-goal obligations arriving here opens, from the operator's own
   * list. Shipped on the row rather than looked up beside it so the cockpit can
   * say *why* a goal's bench rows are waiting on this environment without holding
   * a second copy of the configuration.
   */
  opens: EnvironmentGate[];
}

/**
 * The obligations an arrival at an environment opens. Both name a
 * {@link HumanTaskKind} the harness already files on a delivered goal — what a
 * gate changes is *when*: at the delivery, or once the work is somewhere a person
 * can act on it. → `docs/spec/24-environments.md#what-an-arrival-means`
 */
export type EnvironmentGate = 'validate' | 'close_out';

/**
 * A whole goal's work confirmed in one environment, the first time it was.
 *
 * Stored rather than folded on demand, and that is the only reason the table
 * exists: {@link goalReach} can say a goal *is* somewhere on every pulse, but not
 * that it has just **got** there — and an arrival is a moment. Something has to
 * be written down for the comment to go out once rather than every five minutes,
 * and for the signal to read as an event rather than as a status.
 *
 * `OR IGNORE` on the write, for {@link GoalLanding}'s reason: the goal arriving is
 * a settled fact, and a goal that grows another pull request and arrives again is
 * the same arrival, not a second one.
 */
export interface GoalArrival {
  /** The goal, `issue:<n>`. */
  goalRef: string;
  /** The environment's name as the operator configured it. */
  environment: string;
  /** The reading that confirmed the goal's last landing — as precise as the probe interval. */
  arrivedAt: string;
  /**
   * When the arrival went through the announce pass, or null while it has not.
   *
   * Stamped whether or not there was anything to say, which is what keeps an
   * environment that grows `arrival.comment` later from commenting on its whole
   * history on the boot after. → `docs/spec/24-environments.md#announcing-an-arrival`
   */
  announcedAt: string | null;
  /**
   * When the watch pass considered this arrival, or null while it has not.
   *
   * {@link announcedAt}'s stamp, for {@link announcedAt}'s reason and one more.
   * Stamped whether or not a window was opened, so the first pulse after the watch
   * ships — or after an operator adds a `watch` to an environment that has been
   * probing for a month — walks the history *once* and silently, rather than
   * opening a window on every goal that ever arrived.
   * → `docs/spec/29-post-deploy-watch.md#only-for-an-arrival-the-harness-watched`
   */
  watchedAt: string | null;
}

/**
 * What a goal's post-deploy watch is meant to be told, per check.
 *
 * A `signal` asks how many of a thing there are and is not trusted without a
 * `presence` query; a `measure` asks what one number is and is not trusted
 * without a threshold or a baseline. They fail in opposite directions and carry
 * opposite guards. → `docs/spec/29-post-deploy-watch.md#the-declaration`
 */
export type GoalWatchKind = 'signal' | 'measure';

/**
 * What the dry run learned about one declared check, and the three readings are
 * genuinely different facts about it.
 *
 * - `fires` — the query is proven live and the reported defect is proven real.
 *   This reading is the baseline.
 * - `zero` — the query resolves and matches nothing. Either the query is wrong or
 *   the ticket is, and the author is the only party that can tell which.
 * - `unknown` — the observation did not answer: it failed, timed out, printed
 *   nothing, or came back without the id echo. **Never folded into either of the
 *   others**, in `GoalReachStatus`' rule one layer up: an expired credential and a
 *   quiet release fail identically, and only one of them is about the work.
 */
export type WatchReadingVerdict = 'fires' | 'zero' | 'unknown';

/**
 * One check as its **author** writes it — a plan document's `watch` block, and the
 * goal page's form, which is the same declaration with one check in it.
 *
 * A separate shape from {@link GoalWatchInput}, and the difference is which way
 * round the two kinds are told apart: here by a `kind` the author states and an
 * `expect` a measure carries, there by a row of columns most of which are null for
 * whichever kind it is not. The store's shape is the one table's; this is the one
 * a person types, and refusing it is where a signal without a presence query and a
 * measure with nothing that could fail it are refused.
 *
 * `WatchCheckSchema` (`src/validation/watchDocument.ts`) is annotated with this,
 * so a field learned by one and not the other does not compile.
 * → `docs/spec/29-post-deploy-watch.md#the-declaration`
 */
export type GoalWatchDeclaration =
  | {
      kind: 'signal';
      /** Stable and author-chosen: every writer merges on it, so it must survive a replan. */
      id: string;
      title: string;
      query: string;
      /** The second query proving the code path runs. A signal is not declarable without one. */
      presence: string;
      /** The count it must not exceed. Almost always zero — the thing should not be happening. */
      tolerate: number;
      why?: string;
    }
  | {
      kind: 'measure';
      id: string;
      title: string;
      query: string;
      /** A threshold, a baseline comparison, or both. Never empty — see `WatchExpectSchema`. */
      expect: { under?: number; over?: number; noWorseThan?: 'baseline' };
      unit?: string;
      why?: string;
    };

/** One declared check, as a plan document's `watch` block hands it to the store. */
export interface GoalWatchInput {
  id: string;
  /** Position in the document. Display order only — the merge key is the id. */
  seq: number;
  kind: GoalWatchKind;
  title: string;
  query: string;
  /** The second query proving the code path runs. Required for a signal; null for a measure. */
  presence: string | null;
  /** The count a signal must not exceed. Zero and unread for a measure. */
  tolerate: number;
  /** A measure's ceiling — the number must stay below it. Null for a signal, and for a measure declaring none. */
  expectUnder: number | null;
  /** A measure's floor — the number must stay above it. */
  expectOver: number | null;
  /**
   * Whether the measure declared `noWorseThan: "baseline"`.
   *
   * **A measure that declared it and has no baseline is `unknown`, never clean.**
   * The baseline is taken at declaration, days before the arrival, and a
   * comparison with nothing to compare against is not a passing one.
   * → `docs/spec/29-post-deploy-watch.md#the-baseline-and-why-a-measure-is-not-trusted-without-one`
   */
  expectBaseline: boolean;
  /** What the number is in, drawn beside it. Never parsed — no arithmetic is done on a unit. */
  unit: string | null;
  why: string | null;
}

/** One declared check as it is stored, with whatever the dry run read against it. */
export interface GoalWatch extends GoalWatchInput {
  /** The goal, `issue:<n>` — the same `originRef` a plan carries. */
  originRef: string;
  /** The environment the dry run was put to, or null while none has run. */
  dryRunEnvironment: string | null;
  /** When it ran, or null. */
  dryRunAt: string | null;
  /** What the check's own query answered, or null while nothing has asked. */
  dryRunVerdict: WatchReadingVerdict | null;
  /** What the presence query answered. A signal is not readable without it. */
  dryRunPresence: WatchReadingVerdict | null;
  /** How many rows the check's query came back with, or null when it did not answer. */
  dryRunRows: number | null;
  /** What an operator is told, in words — the refusal for a `zero` or an `unknown`. */
  dryRunDetail: string | null;
  /**
   * A measure's **before**: what its query answered at declaration time, on the
   * same query and from the same source, before anything changed.
   *
   * Null means *never taken*, which is a fact and not a zero — a measure declaring
   * `noWorseThan: "baseline"` reads `unknown` while it is null, because it has
   * nothing to compare against. Cleared by a re-declaration for the dry run's
   * reason: a baseline is a reading of *that* query.
   */
  baselineValue: number | null;
  /** When the baseline was taken, or null while none has been. */
  baselineAt: string | null;
  /**
   * Whether this declaration is live — that is, whether the operator has accepted
   * it.
   *
   * False on a row an agent proposed through `watch_declare` and nobody has ruled
   * on yet. **A false row is never put to an environment**: the query runs inside
   * the operator's own command with the operator's own credential, and that
   * approval is the whole of the authorisation story.
   */
  live: boolean;
  /** An agent's pending amendment to this check, or null where none is outstanding. */
  proposal: GoalWatchProposal | null;
  /**
   * Who last wrote this declaration — the plan, or the operator on the goal page.
   *
   * **`operator` is what a replan does not touch**, and that is the whole of why
   * the field exists. A document speaks for the whole watch, so re-ingesting one
   * removes a check it stopped declaring and overwrites the text of one it still
   * does; both are right for a check the plan wrote, and both are somebody's edit
   * silently reverted for a check the operator did. So an operator's row is
   * neither swept nor overwritten, and the plan's version of that id is dropped
   * on the floor.
   * → `docs/spec/29-post-deploy-watch.md#the-operator-at-any-point`
   */
  authored: GoalWatchAuthor;
}

/**
 * Which writer a check's current text came from.
 *
 * Two rather than three, and `watch_declare` is neither: its output is a
 * {@link GoalWatchProposal} against a row that already has an author, and
 * accepting one applies text to that row without changing whose the row is. An
 * agent's amendment to a check the plan wrote is still the plan's, and a replan
 * is still entitled to replace it — which is the behaviour that was there before
 * this field, kept.
 */
type GoalWatchAuthor = 'plan' | 'operator';

/**
 * An agent's declaration, waiting on the operator.
 *
 * `watch_declare` writes one of these rather than the check itself, for the
 * reason the plan sheet is read-only: approving the plan is what authorises a
 * query to be run against the operator's telemetry with the operator's own
 * credential, and a query that arrived after the approval has not been approved.
 * Accepting applies it and re-runs the dry run; declining leaves the live check
 * exactly as it was.
 * → `docs/spec/29-post-deploy-watch.md#the-working-agent-at-conclude-time`
 */
export interface GoalWatchProposal {
  /** When the agent declared it. */
  at: string;
  /** Why the check is changing, in the agent's own words — what the operator reads. */
  note: string;
  /** The declaration itself, exactly as it is stored the moment it is accepted. */
  declaration: GoalWatchInput;
}

/**
 * What one open watch is: a goal's whole work confirmed in one environment, and
 * the period the harness spends asking that environment what happened next.
 *
 * One row per `(goalRef, environment)`, opened on an arrival and never on a
 * merge — between the two sit a release train and an approval gate, and a window
 * opened at merge would spend itself asking about code that is not running yet.
 * → `docs/spec/29-post-deploy-watch.md#opening`
 */
export interface WatchWindow {
  /** The goal, `issue:<n>`. */
  goalRef: string;
  /** The environment's name as the operator configured it. */
  environment: string;
  /** When the arrival opened it. */
  openedAt: string;
  /** When it is due to settle — `openedAt` plus the environment's `forMs`. */
  settlesAt: string;
  /**
   * When it settled, or **null while it is still watching**.
   *
   * A null that means something, which is the whole of why a column added to this
   * table later needs a backfill gated on `ensureColumns`' report: without one,
   * every settled window reopens on the boot an operator takes the build.
   * → `docs/spec/14-persistence.md#when-a-null-means-something`
   */
  settledAt: string | null;
  /**
   * When an operator last **extended** it, or null where nobody has.
   *
   * A window that ran out before the weekly job ran is the case this answers, and
   * extending re-opens *this* window rather than opening a second one — the goal's
   * readings are one series, and a second row keyed on the same
   * `(goal, environment)` is not a thing the table can hold anyway.
   *
   * Null here means **never extended**, which is the honest reading of every row
   * written before the column existed and is why it is the one column on this
   * table that needs no backfill. `settledAt` is the null that means something,
   * and this one is deliberately not.
   * → `docs/spec/29-post-deploy-watch.md#closing`
   */
  extendedAt: string | null;
}

/**
 * What one check's reading said, per environment, folded to the three verdicts.
 *
 * - `clean` — within what was declared, **with presence answering**.
 * - `regressed` — outside what was declared.
 * - `unknown` — the observation failed, or presence is silent.
 *
 * **`unknown` never folds to `clean`.** An expired credential, a missing binary,
 * a job that never ran and a genuinely quiet release all fail identically, and
 * only the last is about the work — read as clean they are indistinguishable on
 * the glass. `GoalReachStatus`' rule one layer up, and the same rule because it is
 * the same mistake. → `docs/spec/29-post-deploy-watch.md#the-verdict`
 */
export type WatchCheckVerdict = 'clean' | 'regressed' | 'unknown';

/** One reading of one check, in one window. Append-only; the newest is what the card draws. */
export interface WatchReading {
  goalRef: string;
  environment: string;
  /** The check's own slug, and the key it is folded against its declaration by. */
  checkId: string;
  readAt: string;
  verdict: WatchCheckVerdict;
  /** How many rows the check's own query matched, or null when the observation did not answer. */
  rows: number | null;
  /**
   * A measure's **now**: the one number its query answered with, or null for a
   * signal and for any observation that did not answer.
   *
   * Stored beside the verdict rather than derived from it, because the card draws
   * the number as well as the ruling — a p95 of 310ms means nothing alone and
   * everything beside the 8,400ms it replaced.
   */
  value: number | null;
  /** Why, in words — set for every verdict but `clean`, because the cockpit says it in words. */
  detail: string | null;
}

/**
 * The operator's answer to a goal that is never going to reach the environment
 * its obligations are gated on — a docs change, a config change, work whose
 * deployment nothing here can see.
 *
 * A row rather than a per-goal config key, and cleared by deletion, for
 * `IssueDelivery`'s reason: "not released" then keeps exactly one representation.
 * It lifts every gate on that goal at once — the case it exists for is work that
 * does not ship at all, not work that ships to three environments out of four.
 */
export interface EnvironmentGateRelease {
  /** The goal, `issue:<n>`. */
  goalRef: string;
  /** Why it is not waiting. Required — a release with no account of itself is the thing being avoided. */
  note: string;
  releasedAt: string;
}

/**
 * How a local run is going. Five states and no more, because the harness only
 * knows four things: that it asked, that the session finished asking, that it has
 * asked for it to be taken down, and that something ended.
 *
 * `running` is **presumed, not probed** — it means the session that was told to
 * bring the environment up finished its turn without failing, and its process is
 * still alive holding whatever it started. Nothing here opens a socket to check,
 * which is why the panel draws the URL as a link to try rather than as a reading.
 * A readiness probe is the honest way to close that gap and is a separate change.
 *
 * `stopping` is a **live** state, and that is the whole reason it exists rather than
 * the stop being instantaneous: taking a dev environment down is a session's turn
 * (`docker compose down` and whatever else the project needs), so for a minute or so
 * there is a run that is neither up nor over — and one that still holds the
 * environment, so nothing else may begin beside it.
 * → `docs/spec/23-local-runs.md`
 */
export type LocalRunStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/**
 * The one local run: which goal's code is in the machine's dev environment right
 * now, or was last.
 *
 * **One row at a time is the whole feature**, and it is the operator's own
 * constraint rather than a limit invented here — there is one dev environment on
 * the machine, exactly as there is one working copy behind the validation claim.
 * A second run started while one is live stops the first; the store write is what
 * makes that true rather than a check the caller is trusted to make.
 *
 * The row **outlives the run**, so a start that failed leaves its reason somewhere
 * to read. That is the difference between a panel that says `failed` and a panel
 * that says nothing, which is the case an operator actually hits.
 */
export interface LocalRun {
  id: string;
  /** The goal whose code this is, as `issue:<n>`. */
  originRef: string;
  /** The git ref the checkout was pointed at — a part's branch, or the integration branch. */
  ref: string;
  /** The checkout it is running in. `localRunRoot`, and never a pool slot. */
  dir: string;
  /**
   * The commit the checkout stands at, or null on a row from before this was
   * recorded.
   *
   * What a freshness reading is measured from: `ref` names a branch, and a branch
   * moves. Written by a start and rewritten by a refresh — `ensurePreview` is the
   * only thing that moves the checkout, and it reports where it put it.
   */
  commit: string | null;
  /**
   * The session process holding the environment up, or null once it is gone.
   *
   * Recorded because stopping the run means reaping *this* pid's whole subtree: the
   * dev server is its descendant, not the process itself.
   */
  pid: number | null;
  status: LocalRunStatus;
  /** `localRun.url` as it stood when the run started, so a later config edit does not rewrite history. */
  url: string | null;
  /** Why it stopped or failed, or what the session said when it came up. Null while starting. */
  note: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * When the harness holding this run went down, or null if nothing stamped it.
   *
   * Stamped by the fast stop on its way out, and cleared again when a resume brings
   * the run back. It is the age a resume is judged on: an environment nobody has been
   * near for hours is not one to spend a session bringing back, and `startedAt`
   * cannot answer that question — a run started on Monday and still in use at five
   * o'clock is not a stale one.
   *
   * **Null is not recent, it is "nobody wrote a line".** A kill, a power cut or a
   * closed console window takes the process with no shutdown at all, so the fallback
   * is {@link lastSeenAt}; with both null the age is genuinely unknown and a resume
   * refuses rather than guessing.
   */
  interruptedAt: string | null;
  /**
   * The last pulse on which the harness was holding this run, or null on a row no
   * process ever stamped.
   *
   * **What dates a force close** — `taskkill /F`, Task Manager's End task, a power
   * cut, a console window closed on Windows. None of those run a line on the way out,
   * so {@link interruptedAt} stays null and this is the only record of when the
   * environment was last true. Accurate to one heartbeat, which is all a two-hour
   * window needs.
   *
   * Stamped only by the process **actually holding the run**, never by a boot that
   * walked past a live row it declined to bring back.
   */
  lastSeenAt: string | null;
  /**
   * What the sessions behind this run have cost, and what they spent to do it.
   *
   * **Accumulated, not folded.** Every other usage figure the harness holds is a
   * session's own cumulative report written straight onto a row, because an
   * `agents` row has exactly one session behind it. A local run has up to two — the
   * one that brought the environment up, and the one spawned to take it down when
   * that one is gone — so a cumulative write would replace the bring-up's total
   * with the teardown's, downwards. `Store.addLocalRunUsage` adds deltas for that
   * reason. → [23](../docs/spec/23-local-runs.md#what-it-costs)
   *
   * **Null is unmeasured, never free**, the convention `Agent.costUsd` sets: a run
   * from before this was recorded reports nothing, and a PTY deployment reports
   * nothing ever, since only the stream runtime has a usage channel at all.
   */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The cached share of {@link LocalRun.inputTokens} — see {@link Agent.cacheReadTokens}. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
}

/**
 * One session's usage since its own last report — what {@link LocalRun} accumulates.
 *
 * The same fields as {@link AgentUsage} and deliberately a different type: that one
 * is a *cumulative* report and this is a *difference*, and the whole hazard here is
 * handing one to something expecting the other. A null field adds nothing and leaves
 * the column as it was, so a runtime that reports cost but no cache split does not
 * write a zero share.
 */
export type LocalRunUsageDelta = AgentUsage;

/**
 * Which turn the session holding a local run is in the middle of. `start` and `stop`
 * double the row's `starting`/`stopping`; `refresh` and `message` happen on top of a
 * `running` row, which is why the row's status cannot carry them.
 */
export type LocalRunTurn = 'start' | 'stop' | 'refresh' | 'message';

/**
 * What the local-run watch found on the machine's ports — a reading, taken on a
 * timer while a run is live, and the first thing here that *is* one.
 *
 * Both halves are three-valued. `declared` is null when no URL is configured or the
 * configured one has no port to speak of; `answering` is a TCP connect and nothing
 * more, so it says the port is held and not that the application behind it works.
 * `listening` is what the session's own process tree holds open, and null when the
 * lister could not say — never an empty list, which would read as "nothing".
 * Containers belong to the daemon and never appear here.
 * → `docs/spec/23-local-runs.md#watching-the-environment`
 */
export interface LocalRunPorts {
  checkedAt: string;
  declared: { url: string; host: string; port: number; answering: boolean } | null;
  listening: number[] | null;
}

/**
 * How far the checked-out commit has fallen behind, in the clone's opinion.
 *
 * `behindTip` counts the commits the run's own ref has that the checkout does not —
 * the branch moved since the start, so the preview is showing old code. `base` is
 * the branch this ref was cut from and how many of its commits the ref lacks, or
 * null on the integration branch, which has no base. Every count is null where the
 * clone cannot say — an unfetched ref, a commit it has never seen — and null is
 * never folded into zero. → `docs/spec/23-local-runs.md#watching-the-environment`
 */
export interface LocalRunFreshness {
  checkedAt: string;
  behindTip: number | null;
  base: { ref: string; behind: number | null } | null;
}

/** Both readings together, as the watch holds them and the snapshot ships them. */
export interface LocalRunReadings {
  ports: LocalRunPorts | null;
  freshness: LocalRunFreshness | null;
}

/**
 * How a local validation ended, or that it has not.
 *
 * `blocked` is the third answer and the reason there are three, exactly as
 * `validation_report`'s hand-back is: an agent that could not reach or confirm the
 * environment has learned nothing about the goal, and with only `passed` and
 * `failed` available its options are a lie and silence. A `blocked` row dispatches
 * no fix, because it carries no finding about the code to fix.
 *
 * `abandoned` is the harness's own answer rather than the agent's: the environment
 * the reading was pinned to went away — stopped, swapped to another goal, or moved
 * to a different commit — or the agent ended without reporting, or the operator
 * called it off. It is never a reading, and the note says which of those happened.
 * → `docs/spec/32-local-validation.md`
 */
export type LocalValidationStatus = 'pending' | 'dispatched' | 'passed' | 'failed' | 'blocked' | 'abandoned';

/**
 * One thing the validator found wrong, in its own words.
 *
 * `severity` is the agent's judgement and gates nothing — a `nit` beside a
 * `blocker` still reaches the fix agent, because a run worth fixing is worth fixing
 * all of. What it changes is what a person reads first.
 *
 * `screenshot` is a **file name**, never a path: the bytes live in the row's own
 * output directory and the name is what joins a finding to the file the cockpit
 * serves. A stored path would be wrong for the two readers that are not the
 * harness — `validationResourcePath`'s rule, one layer over.
 */
export interface LocalValidationFinding {
  title: string;
  detail: string;
  severity: 'blocker' | 'defect' | 'nit';
  /** The page it was found on, where there is one. */
  url: string | null;
  /** A file in the row's output directory, or null. */
  screenshot: string | null;
}

/**
 * One run of the fleet against the machine's own dev environment: an agent that
 * wrote a test plan for a goal's changes, drove the running application through
 * them, and said what it found.
 *
 * **Pinned to the run it was requested against**, and that pin is the whole
 * correctness of the reading. `runId` and `commit` record which environment the
 * plan was written for; the moment the live run is no longer that one — stopped,
 * swapped to another goal, refreshed onto a later commit — a `passed` or `failed`
 * answer would be a reading of code nobody asked about. The report tool refuses one
 * and the desk abandons the row, both through `validationRunStale`, so the two
 * cannot disagree about what counts as the same environment.
 *
 * **It is not a validation check** ([20](../docs/spec/20-validation.md)). A check is
 * a procedure somebody declared and a reading somebody took against the
 * *delivered* goal; this is an exploratory run against work still in flight, and it
 * writes no reading on any check. Its plan is its own artefact, and the goal's
 * checks are handed to it as input.
 */
export interface LocalValidation {
  id: string;
  /** The goal, as `issue:<n>`. */
  originRef: string;
  /** The `local_runs` row this was requested against. */
  runId: string;
  /** The git ref that run had checked out — what a fix agent is dispatched onto. */
  ref: string;
  /** The commit that checkout stood at, or null on a run from before that was recorded. */
  commit: string | null;
  status: LocalValidationStatus;
  requestedAt: string;
  /** When an agent actually spawned for it, or null while it is still queued. */
  dispatchedAt: string | null;
  endedAt: string | null;
  /** The validator's task, once one exists. */
  taskId: string | null;
  /** The fix dispatched for a failed reading. The once-only latch, so one failure buys one fix. */
  fixTaskId: string | null;
  /** The test plan, markdown, written before the environment was up. Null until it lands. */
  plan: string | null;
  /** What the agent concluded, in its own words. Null until it reports. */
  summary: string | null;
  findings: LocalValidationFinding[];
  /** The pages it opened, so a person can go and look at the same ones. */
  visited: string[];
  /** File names in the row's output directory — see {@link LocalValidationFinding.screenshot}. */
  screenshots: string[];
  /** Why it was abandoned, or what a `blocked` run could not reach. Null otherwise. */
  note: string | null;
}

/**
 * An MCP server one dispatch carries onto its launch **beside** the harness's own.
 *
 * The fleet's channel is fixed and per-agent ([11](../docs/spec/11-mcp-tools.md));
 * this is the exception that lets one kind of work bring a tool the rest of the
 * fleet has no use for — today a browser, for a local validation. It rides the same
 * single `--mcp-config` document, so there is still one file per launch and one
 * place the grants are derived from.
 *
 * `key` becomes the `mcpServers` key, which is what `mcp__<key>__<tool>` permission
 * names are derived from — so it is also the grant. It may never be
 * `MCP_SERVER_ID`: a launch whose extra server took the harness's own key would
 * connect and answer every one of the fleet's tool calls with somebody else's tools.
 */
export interface ExtraMcpServer {
  key: string;
  command: string;
  args: string[];
}

/**
 * One dated cost delta, whatever spent it — the shape a rolling window and the
 * spend timeline read.
 *
 * Sourceless on purpose. Two tables hold these (`usage_events` for agents,
 * `local_run_cost_deltas` for local runs) and a reader asking "what went out, and
 * when" has no use for the difference; the readers that *do* — the reliability
 * breakdown's per-pull-request CI cost — ask `listUsageEventsSince` for agent rows
 * they can join by id.
 */
export interface CostDelta {
  costUsd: number;
  at: string;
}

/** Which credential a tool call arrived on. Never summed across — see {@link McpCall}. */
export type McpChannel = 'fleet' | 'desktop';

/**
 * One recorded MCP tool call.
 *
 * The distinction the shape turns on is that a **channel** is not a detail of a
 * call, it is what the call *is*: the fleet's arrive on a per-agent credential
 * minted at dispatch and the operator's on a long-lived one in their home
 * directory, the tool sets are different lists, and `validation_report` is two
 * different tools with one name. A total that summed them would be a number about
 * nothing.
 *
 * `agentId` / `taskId` / `originRef` are null on a desktop call, which has no
 * dispatch behind it, and on a fleet call whose credential could not be resolved
 * — a refusal worth recording precisely because nothing else records it.
 */
export interface McpCall {
  id: string;
  channel: McpChannel;
  tool: string;
  agentId: string | null;
  taskId: string | null;
  /** The calling agent's origin as it was at call time, for the phase reading. */
  originRef: string | null;
  ok: boolean;
  /** The refusal in the tool's own words. Null on success. */
  error: string | null;
  durationMs: number;
  /** The arguments as JSON, or null — either none were passed, or {@link argsDropped}. */
  args: string | null;
  /** What the arguments measured, kept after the text itself is compacted away. */
  argsBytes: number;
  /** Whether the arguments were compacted away, as against never having existed. */
  argsDropped: boolean;
  createdAt: string;
}

/** What a caller states about a call; everything else on {@link McpCall} is the store's. */
export interface McpCallInput {
  channel: McpChannel;
  tool: string;
  agentId: string | null;
  taskId: string | null;
  originRef: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  /** Serialised by the store, so a caller never has to decide whether to keep them. */
  args: Record<string, unknown>;
}

/**
 * One row of surface reach: something a person did in the cockpit that no table
 * would otherwise hold.
 *
 * **Five fields and no more**, and the shape is the privacy position rather than
 * a summary of it. The subject and the verb are the registry's
 * (`src/usage/events.ts`); the place is a key from a closed vocabulary; `at` is an
 * instant; `arrival` is how the place was reached. There is no ref, no title, no
 * note, no free text — and **no identity column**, which is refused rather than
 * omitted: a fleet is an engineer, so the fleet id already carries whose
 * behaviour a row describes, and a second identifier would buy nothing while
 * turning every row into something the digest would have to withhold.
 *
 * → `docs/spec/34-usage-metrics.md#the-one-new-table`
 */
export interface SurfaceReach {
  subject: UsageSubject;
  verb: UsageVerb;
  place: PlaceKey;
  at: string;
  arrival: UsageArrival;
}

/** What a caller states; `at` is the store's, stamped as the batch lands. */
export type SurfaceReachInput = Omit<SurfaceReach, 'at'>;

// ---------------------------------------------------------------------------
// The cross-fleet pool (docs/spec/28-cross-fleet-pool.md)
//
// The distance above `fleet`: what one fleet has vouched for, carried to the
// others so a common problem is solved once rather than once per engineer, and a
// daily digest of what each fleet spent so a person can read where the money goes
// across a company rather than across a laptop.
//
// It is a **distribution** problem and not a measurement one. Nothing here
// measures anything new — `knowledge_facts`, `src/spendInsights.ts` and
// `src/remedyInsights.ts` already hold every figure. This moves what exists.
// ---------------------------------------------------------------------------

/**
 * Which document this is.
 *
 * The first two are the fleet's own standing documents, published on a clock and
 * tracked in `pool_publications`; a **pack** is neither. It is one pull request's
 * review pack, published because a person asked for that one to be shared and
 * pruned when its pull request has been closed long enough, so it has no dirty
 * flag, no content hash and no cadence.
 * → `docs/spec/31-review-packs.md#sharing-a-pack`
 */
type PoolDocumentKind = PoolClockKind | 'pack';

/**
 * The document a **clock** publishes. Named apart from {@link PoolDocumentKind}
 * so the publication bookkeeping — dirty, hash, checked — cannot be handed a pack,
 * which has none of those things and is published by a person.
 */
export type PoolClockKind = 'digest';

/**
 * What every pool document carries, whichever kind it is.
 *
 * `fleetId` is in the body **as well as in the address**, and a mismatch discards
 * the document: the address is the transport's, a text substrate may have none
 * that survives a round trip, and a fleet publishing under another fleet's name is
 * the single thing that can break one writer per namespace.
 */
interface PoolEnvelope {
  /** The schema version. Named `pool` so the field reads as what it versions. */
  pool: number;
  kind: PoolDocumentKind;
  fleetId: string;
  project: string;
  publishedAt: string;
  harnessVersion: string;
}

/**
 * One day's figure for one key, in one section.
 *
 * **Counts and dollars, never percentages** — a share summed across fleets is
 * meaningless, so the aggregator takes shares from summed counts. `costUsd` is
 * null where a window measured nothing at all, and never `$0.00` for it.
 */
export interface PoolDigestRow {
  /** A UTC day, `YYYY-MM-DD`. Never local midnight — see the spec's sharp edge. */
  day: string;
  /** The section's own key: a `SpendPhase`, a `kind/cause/guard` triple, a check name, or `''`. */
  key: string;
  /** Runs, accounts, or dispatches — whichever the section counts. */
  count: number;
  costUsd: number | null;
  /**
   * True for the origin's current day. **A partial day counts in a total and never
   * in an average** — otherwise every average on the page is dragged down by a day
   * that is not over, silently, on the newest and most-read number.
   */
  partial: boolean;
}

/**
 * A fleet's digest document: ninety UTC days of what it spent and what coming back
 * to a pull request cost it.
 *
 * There is no separate total: `PHASE_ORDER` includes `other`, so the phases
 * partition the fleet's spend and the total is their sum. A total shipped beside
 * them would be a second statement of one number, free to disagree with the one
 * that adds up.
 */
export interface PoolDigestDocument extends PoolEnvelope {
  kind: 'digest';
  /** Keyed by `SpendPhase`. */
  byPhase: PoolDigestRow[];
  /** Keyed by `<RemedyKind>/<RemedyCause>/<RemedyGuard>` — closed vocabularies, comparable by construction. */
  byCause: PoolDigestRow[];
  /**
   * Keyed by the check's own name. A **separate section**, because check names
   * cross within a project and never between: three fleets on one problem produce
   * three keys, and summed across projects that renders perfectly as a chart
   * saying no single check causes much pain.
   */
  byCheck: PoolDigestRow[];
  /** Return dispatches that filed no account. Not optional: without it every share is a share of a minority. */
  unaccounted: PoolDigestRow[];
  /** Runs that reported no usage at all. Without it a PTY fleet is drawn as a cheap fleet. */
  unmeasured: PoolDigestRow[];
  /**
   * What a person did, keyed by `<UsageSubject>.<UsageVerb>` — the registry's two
   * axes and nothing else (`src/usage/events.ts`).
   *
   * Both halves of the key are closed vocabularies the harness owns, so two fleets
   * on two providers produce comparable rows by construction. **The cockpit's place
   * key is deliberately not here**: it is the console's own layout, which a redesign
   * moves, and a cross-fleet series keyed on it would break at a release rather than
   * at a change of behaviour.
   *
   * `costUsd` is null on every row: what a person did has no dollar figure anywhere
   * in the harness, and deriving one here would be a new measurement invented for
   * the pool.
   * → `docs/spec/34-usage-metrics.md#the-digest-section`
   */
  byUsage: PoolDigestRow[];
  /**
   * Faults this fleet recorded, keyed by `ErrorLogEntry['source']` — a closed
   * vocabulary of five, and the same word the Faults panel draws.
   *
   * **It carries no cost and it is never mirrored**, which is what makes it a
   * different animal from the four sections above it: nothing at the far end reads
   * it, so it exists to be read in this fleet's own `digest.md` and nowhere else.
   * → `docs/spec/28-cross-fleet-pool.md#the-faults-section`
   */
  byFault: PoolDigestRow[];
}

/**
 * One shared review pack: the local document, whole and unedited, in an envelope.
 *
 * **It rides the transport and nothing else.** It is not a claim and takes none of
 * the claims arm: no corroboration, no vouch, no contradiction, no lifetime, and
 * nothing about it is ever injected into a prompt or read by a rule. The pack is
 * carried as it was written rather than restated, for the reason every other
 * rendering of one is downstream of the document: a second grammar for one fact is
 * free to disagree with the first, silently.
 * → `docs/spec/31-review-packs.md#sharing-a-pack`
 */
export interface PoolPackDocument extends PoolEnvelope {
  kind: 'pack';
  /** The pull request at the origin. Half the address, and never a ref: it points into a tracker the reader may not have. */
  prNumber: number;
  /** The head the pack was written against, copied off the document the way the local row copies it. */
  headSha: string;
  /** When the pack was written locally. Never the publish time, which is the envelope's. */
  writtenAt: string;
  pack: ReviewPack;
}

/** A document published on a clock, and tracked as one. The layer above splits on `kind`. */
export type PoolClockDocument = PoolDigestDocument;

/** One document, whichever kind. The layer above splits on `kind`; the transport stays opaque. */
export type PoolDocument = PoolClockDocument | PoolPackDocument;

/**
 * One fleet as the mirror last saw it — including the two readings that are not
 * "it has published nothing".
 *
 * `ahead` is a fleet whose document this build's schema version skips, and it is
 * drawn as such. *Could not reach the pool* is never folded into *nobody has
 * published anything*.
 */
export interface PoolFleetReading {
  fleetId: string;
  project: string | null;
  digestAt: string | null;
  ahead: boolean;
  seenAt: string;
}

/** What this fleet has published of one kind, and whether the store has moved since. */
export interface PoolPublication {
  kind: PoolClockKind;
  contentHash: string | null;
  publishedAt: string | null;
  /** A **hint**. The content hash is the truth; the slow clock re-derives and compares. */
  dirty: boolean;
  checkedAt: string | null;
}

// ---------------------------------------------------------------------------
// The obstacle board → `docs/spec/27-obstacles.md`

/**
 * What identifies an obstacle: a fact about the world, not a sentence about it.
 *
 * The three the harness can check something against — `check`, `test`, `path` —
 * bind. The two it cannot only ever suggest: a signature is a normalisation of
 * somebody else's output, and the thing being normalised is outside this
 * repository's control.
 */
export type ObstacleKeyKind = 'check' | 'test' | 'path' | 'signature' | 'cmd';

/** Where an obstacle is, and therefore who it reaches. → `src/obstacles/lifecycle.ts` */
export type ObstacleState = 'sighted' | 'standing' | 'owned' | 'resolved' | 'dormant' | 'muted';

/**
 * Whether a fix ends it. The discriminator is the one boolean an agent can always
 * answer, and it is the whole of what the intake asks about where a report goes.
 */
export type ObstacleKind = 'obstacle' | 'note';

/** One way into an obstacle. An obstacle may hold several. */
export interface ObstacleKey {
  id: string;
  obstacleId: string;
  kind: ObstacleKeyKind;
  /** The identity. Unique across the whole board, kind included in nothing. */
  value: string;
  /** Whether this key may resolve an obstacle. False for a suggestion. */
  binds: boolean;
  /** How often a suggestion on this key was confirmed — what a later promotion reads. */
  confirmations: number;
  createdAt: string;
}

/** One voice, and the words it said it in. */
export interface ObstacleSighting {
  id: string;
  obstacleId: string;
  agentId: string | null;
  taskId: string | null;
  /** The goal, collapsed from the dispatch origin. Null for a harness voice. */
  goalRef: string | null;
  sessionId: string | null;
  /** What the harness observed, for its own voice; null for an agent's. */
  transition: string | null;
  /** The reporter's own sentence, verbatim — never the claim restated. */
  words: string;
  /** Required at the intake and read by nobody but an operator. */
  whyNotMine: string | null;
  /** Why this landed here: `check:test (windows)`, or `fresh`. */
  matchedBy: string;
  createdAt: string;
}

/**
 * A row on the board with everything that reads it needs, assembled once.
 *
 * The voice count is the store's own (`obstacleVoices`), never a second fold of
 * the sightings: the number that carries a row to `standing` and the number a
 * repair dispatch is judged against are the same number.
 */
export interface ObstacleStanding {
  obstacle: Obstacle;
  /** Every way into it, suggestions included — the reader decides which bind. */
  keys: ObstacleKey[];
  /** How many independent voices have said it. */
  voices: number;
  /** The goals that have said it, deduplicated. A priority flag expands over these. */
  goalRefs: string[];
  /**
   * The voices in their **own words**, oldest first — the sentences behind the
   * one-line claim. Carried on the row because everything that puts an obstacle in
   * front of somebody wants them: a claim in somebody else's words is exactly what
   * this store exists because agents cannot match on.
   */
  words: string[];
}

/**
 * One goal parked behind an obstacle — the `blocked` verdict's row.
 *
 * Its own table rather than a fifth member of the verdict matrix
 * (`src/store/verdicts.ts`), and the distinction is what keeps it safe: the four
 * verdicts there all answer *is this goal's work finished*, and each clears the
 * ones it contradicts. This answers a different question — *can it be worked at
 * all right now* — and its exit is the **obstacle**, not the issue. Folding it in
 * would have a block clear a delivery, which is delivered work handed back to the
 * fleet (`docs/spec/20-validation.md#when-a-check-fails`, the same failure from
 * the other side).
 */
export interface ObstacleBlock {
  /** The goal, as `issue:<n>` — the origin every pickup gate keys on. */
  originRef: string;
  /** The obstacle that stopped it. The block ends when this one stops reaching agents. */
  obstacleId: string;
  /** The agent that could not finish, and its task. Null for neither, today. */
  agentId: string | null;
  taskId: string | null;
  /** What the agent said it could not get past. Required, as every conclusion's note is. */
  note: string;
  createdAt: string;
}

/** A row on the board. */
export interface Obstacle {
  id: string;
  /** One line, the reporter's words with its own frame stripped. */
  what: string;
  kind: ObstacleKind;
  state: ObstacleState;
  /** The ticket or repair dispatch fixing it; null while nothing is. */
  ownerRef: string | null;
  /** The reporter's clock, read only by the backstop. */
  until: string | null;
  createdAt: string;
  updatedAt: string;
  /** The newest sighting, which is what decay reads. */
  lastSeenAt: string;
  /**
   * What ended it, or null while nothing has — the terminal states' own record of
   * which of the four endings took the row.
   *
   * Null on every row a build before the endings wrote, and that is the honest
   * reading rather than a hole a backfill has to fill: nothing could write
   * `resolved` or `dormant` then, so no row that predates this column has ended at
   * all. → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
   */
  endedBy: ObstacleEnding | null;
}

/**
 * Which of the four endings took a row.
 *
 * Recorded because the four are not interchangeable to anybody reading the board
 * afterwards: a `condition` is the world saying it cleared, a `landing` is the
 * owner's work shipping, an `expiry` is a clock running out on something no
 * reading ever settled, and `decay` is nothing having said it for
 * `obstacleDormantMs`. Read by nothing that decides.
 *
 * `retired` is the operator's own, and it is a member here rather than a second
 * column for exactly the reason the other five are recorded: the board must never
 * say a clock or the world ended a row a person did. **Retiring is not
 * rejecting** — the row keeps its claim, its keys and its sightings, and a
 * matching report reopens it at `standing` like any other terminal row, which is
 * the whole difference from `muted`. → `docs/spec/27-obstacles.md#in-the-cockpit`
 */
export type ObstacleEnding = 'condition' | 'landing' | 'expiry' | 'decay' | 'written-down' | 'retired';

/**
 * A condition the harness can evaluate, written by the harness and **never by an
 * agent**.
 *
 * Settling one means reading a world object pulse after pulse, and the only party
 * that can promise to do that is the one already reading it — an agent naming a
 * condition would be naming something nothing watches.
 * → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
 */
export interface ObstacleCondition {
  id: string;
  obstacleId: string;
  /** One kind to start: the named check going green on the named branch. */
  kind: 'check-green';
  /** The provider's own check name — a binding `check` key of the row. */
  checkName: string;
  /** The branch the harness saw it failing on, as the world named it. */
  branch: string;
  /**
   * The first of the **two consecutive real world readings** a resolution needs, or
   * null while the condition is not currently met. A reading that finds it unmet
   * clears it, so "consecutive" is a fact about the column rather than a promise.
   */
  metAt: string | null;
  createdAt: string;
}

/**
 * A note being written into the repository: the documentation job opened for it,
 * and what became of that job.
 *
 * One row per note, ever — the primary key is the obstacle. A note whose write-up
 * was abandoned is not queued again: it stays `standing` and decays like anything
 * else, where a retry on every pulse would be this subsystem spending the fleet on
 * itself. → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
 */
export interface ObstacleWriteUp {
  obstacleId: string;
  jobId: string;
  /** The pull request the job opened, stamped as soon as the graph shows one. */
  prRef: string | null;
  /** `landed` or `abandoned`; null while the job is still going. */
  outcome: ObstacleWriteUpOutcome | null;
  createdAt: string;
  settledAt: string | null;
}

/** What became of a note's documentation change. `unknown` settles nothing and is never stored. */
export type ObstacleWriteUpOutcome = 'landed' | 'abandoned';

/**
 * What the model desk made of one row, as the store holds it.
 *
 * **It is a reading and never a ruling.** Nothing here moves a state, takes an
 * owner or resolves anything: the desk is the harness's secretary and deliberately
 * not its judge. What it holds is what a model may decide — what the row is *for*,
 * and the ticket prose that would be written from the sightings otherwise.
 * → `docs/spec/27-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not`
 */
export interface ObstacleDeskReading {
  obstacleId: string;
  /**
   * The row's own `lastSeenAt` as it stood when this was read, which is what makes
   * the inbox a comparison rather than a clock: a further voice landing words on a
   * row puts it back in the inbox, and a row nobody has said anything new about is
   * one already read.
   */
  readAt: string;
  takenAt: string;
  /** What the desk says the row is for, or null where it did not say. */
  purpose: ObstaclePurpose | null;
  /** The ticket's title and body, written from the sightings; null leaves the mechanical composition. */
  title: string | null;
  body: string | null;
}

/**
 * What an obstacle is *for*: a ticket somebody fixes, or a change to the
 * documentation.
 *
 * A model may decide it, because a wrong ticket is a ticket and a ticket is
 * visible. It is the same pair of doors the `kind` column already names — an
 * obstacle is fixed and a note is written down — so the desk writes the kind
 * rather than a second field nothing else reads.
 */
export type ObstaclePurpose = 'ticket' | 'docs';
