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
  /**
   * What the harness will do about each *failing* check, from the server's own
   * `classifyCiFailures` — the third verdict beside `health` and `attention`.
   *
   * Computed there rather than here on purpose: the alternative is shipping the
   * CI policy and re-matching in the browser, i.e. a second glob matcher and a
   * second first-match-wins ordering living nowhere near the rule they duplicate.
   * `actionable` with three empty lists is the provider reporting no per-check
   * detail — missing detail, not a clean bill of health.
   */
  ciVerdict?: CiVerdictView;
}
/** One failing check and the policy rule that claimed it (null = nothing matched). */
interface CiMatchView {
  name: string;
  /** Only `guidance` and `urgent` are of any use here; the glob is not a reading. */
  rule: { guidance?: string; urgent?: boolean } | null;
}
interface CiVerdictView {
  actionable: boolean;
  dispatch: CiMatchView[];
  escalate: CiMatchView[];
  ignored: CiMatchView[];
  urgent: boolean;
}
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  /**
   * The tracker's own workflow state (`Ready`, `In Review`, `Done`), unlike
   * {@link Issue.state} which collapses to open/closed. Absent on providers that
   * have no such notion (github/fake). It has always ridden the snapshot via the
   * spread — it was only ever undeclared here.
   */
  workItemState?: string | null;
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
    by: 'agent' | 'assessor' | 'operator' | 'plan' | null;
    note: string;
    at: string | null;
  };
  /**
   * An assessor's "this was worked and the goal is still not reached", beside the
   * other two and inside neither. Pickup says whether an agent would start next
   * cycle — and a shortfall's answer to that is "yes, and that is the point" — so
   * what this adds is *what* fell short and therefore what the harness has offered
   * to do about it. Null/absent means nothing has.
   */
  shortfall?: {
    cause: 'plan' | 'part' | 'goal' | null;
    partSlug: string | null;
    summary: string;
    by: 'assessor' | 'operator';
    decidedAt: string;
  } | null;
  /**
   * The positive mirror of `shortfall` — the assessor's "this goal is reached",
   * beside the other verdicts and inside none of them, for their reasons.
   *
   * It has to be its own field because it cannot be read off `conclusion`: after
   * the two-record split the assessor's *positive* verdict lives in
   * `issue_deliveries`, so `resolveIssueConclusion` never returns
   * `{by: 'assessor', verdict: 'done'}` — a delivered decomposed issue resolves to
   * `{by: 'plan'}`, which says every part merged and says nothing about whether
   * anyone checked the goal. Nor can it be read off `pickup.status`: the plan
   * `parts` arm answers before the delivery park, so a delivered *decomposed*
   * issue reports `planning`. Both readings are true; neither is this one.
   *
   * **Present only while the verdict still stands**, which is the same reading
   * `deliveryHold` gives rule 4 — a tracker move back into a pickup state or a
   * world transition since `decidedAt` ends it, and the field goes null with it.
   * So absent means "no standing goal check", never "there was never one": once
   * released the issue is back in play and rule 3e will assess it again, and a
   * floor still reading *Verified* beside a patch that is ready to mine would be
   * the contradiction this field exists to remove.
   */
  delivery?: {
    summary: string;
    by: 'assessor' | 'operator';
    decidedAt: string;
  } | null;
  /**
   * The intake verdict (#158), beside `conclusion` and `shortfall` and inside
   * `pickup` for none of their reasons: pickup answers "would an agent start next
   * cycle", the assay answers "is there anything here to start on".
   *
   * **Null is a third reading, not a synonym for `workable`.** A goal nothing has
   * assayed has no drill on its floor at all; a refused one has a drill that is
   * stopped and carries its reason. `pickup.reasons[0]` already holds that reason
   * as prose, and telling the two apart by reading a string written for a human is
   * exactly what `signalPolarity` refuses to do.
   */
  assay?: {
    verdict: 'workable' | 'unclear';
    summary: string;
    by: 'assayer' | 'operator';
    decidedAt: string;
    /**
     * The standing comment the assay desk keeps on this ticket, as a canonical
     * ref to look up in `refUrls` (#171) — the one thing the assay says to the
     * person who wrote the item, and the one outbound act it performs.
     *
     * Optional and null-able, and both mean *draw nothing*: an older server does
     * not send it, a verdict that never wrote a comment has none, and a provider
     * that cannot build a URL leaves it out of `refUrls`. A caption with no link
     * would assert a comment exists while giving nobody a way to read it, which
     * is the outcome #171 ruled out.
     */
    commentRef?: string | null;
  } | null;
  /**
   * The run's own write-up (rule 3h), once a goal has been delivered and written
   * up — the **reading**, not the writing. The document is fetched when a reader
   * opens it (`api.getRetrospective`), because this snapshot is polled and a
   * write-up per issue would be paid for on every poll.
   *
   * Absent and null both mean *nothing was written*, which the Manifest station
   * draws as such: a retrospective nobody wrote is silence, never an error.
   */
  retrospective?: { summary: string; hasDocument: boolean; updatedAt: string } | null;
  /**
   * The shared pad the agents on this goal left each other (`scratch_append`) —
   * how many entries, and when the last one landed. The entries themselves are
   * fetched on open (`api.getScratchpad`), for the reason the write-up is: this
   * snapshot is polled, and a pad is unbounded prose from every agent on the goal.
   *
   * Absent and null both mean *nobody has written anything*, which draws no way in
   * at all — a control that opened an empty pad would be a button whose only
   * answer is that there was nothing to see.
   */
  scratchpad?: { entries: number; updatedAt: string } | null;
  /**
   * Whether the operator is keeping this finished goal on the Goal Floor, and
   * whether they have dismissed it (issue #203). Three states off one optional
   * field: **absent** is a live goal (retention has said nothing), **present and
   * not dismissed** is a finished goal held on the floor until the operator clears
   * it, **present and dismissed** is one they have cleared — hidden unless it
   * re-enters production, which draws as live work regardless.
   *
   * The floor is otherwise built from the live world, so a completed goal would
   * drop off it the moment the tracker stops returning the issue (closed by hand)
   * or its watch tag comes off — taking the one way in to the run's report with
   * it. A goal whose issue the world has forgotten arrives in
   * {@link CockpitState.floorCompletions} instead, rebuilt from its stored record.
   */
  completion?: { at: string; dismissed: boolean };
}

/**
 * One entry on a goal's shared pad, fetched on open.
 *
 * `authorOriginRef` is the attribution and the interesting field: it says which
 * agent on the goal wrote this — a part, the planner, the assessor — and it is
 * taken from the credential rather than from anything the author typed.
 */
export interface ScratchEntryView {
  id: string;
  padRef: string;
  authorOriginRef: string;
  agentId: string;
  taskId: string;
  /** An optional scannable tag the author chose. */
  topic: string | null;
  note: string;
  createdAt: string;
}

/** A goal's retrospective in full, fetched on open. */
export interface RetrospectiveView {
  originRef: string;
  summary: string;
  /** Markdown. */
  document: string;
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
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
  /** What could go wrong with this decomposition, in the planner's own words. */
  risks: string | null;
  /** What the planner deliberately left out of every part. */
  outOfScope: string | null;
  /** The planner's full write-up, rendered as markdown in the modal's second tab. */
  document: string | null;
  /** True while a discussion agent is conversing about this plan — nothing is scheduled meanwhile. */
  discussing: boolean;
  /**
   * The one living status comment the plan reconciler maintains on the issue, as
   * a canonical ref (`issue:12:comment:456`) to look up in `refUrls` — or null
   * before it has written one.
   *
   * **Not the provider's comment id**, which is what the *store* keeps: an id is
   * meaningless outside the provider seam that round-trips it, and a bare number
   * reads as an issue number to anything that resolves refs. The server pairs it
   * with its issue on the way out (#171), so the two records that keep a comment
   * — this and an issue's `assay.commentRef` — reach the cockpit in one shape.
   *
   * Present but unresolved is a real state (no provider builds Azure URLs yet, and
   * the `fake` connector has no pages): the reading "a comment exists" still
   * stands, but nothing may offer a link for it.
   */
  statusCommentRef: string | null;
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
  /** Sibling slugs this part needs first: one to stack on it, several to rejoin them. */
  dependsOn: string[];
  /** Why this is its own PR rather than folded into a sibling. */
  rationale: string | null;
  /** What "done" looks like for this part, in the planner's own words. */
  acceptance: string | null;
  /**
   * 'code' | 'report' | 'determination' — what the planner expected this part to
   * produce. Null means unstated, which reads as code. Optional so an older server
   * degrades gracefully.
   */
  expectedKind?: string | null;
  /** What it actually produced, once concluded. Null until then; a merged part is code. */
  outcomeKind?: string | null;
  /** Optional evidence for a concluded part — 'flag:<id>' or 'finding:<id>'. */
  outcomeRef?: string | null;
  /** What the concluding agent found. Present on a concluded part. */
  outcomeSummary?: string | null;
  branch: string | null;
  prNumber: number | null;
  /** 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'concluded' | 'blocked' | 'retired'. */
  status: string;
  /**
   * Why the part is blocked, in the server's words — the only status that carries
   * its own reason, because a blocked part has no branch, PR or agent to be read
   * for one. Optional so an older server degrades to today's silence.
   */
  blockedReason?: string | null;
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
  /** The operator cleared this row: no tracker item is wanted for it. */
  ignored: boolean;
}
/**
 * One entry in the rule dispatcher's prompt book. Like {@link WorkNodeView} this
 * does not ride `/api/state` — it arrives from `/api/prompts`, fetched when the
 * panel is opened, because the book is read once at boot and cannot change while
 * the harness is up.
 */
export interface PromptTemplateView {
  id: string;
  /** What the prompt is for and when it fires. */
  doc: string;
  /** The `{token}`s this id may reference — i.e. what an override may use. */
  placeholders: string[];
  /** The **effective** text: the operator's override where there is one. */
  template: string;
  overridden: boolean;
}
/**
 * One configured value in the running config, from `/api/config` — fetched when
 * the settings modal is opened, for the prompt book's reason: `loadConfig` runs
 * once at boot, so polling it would be paying for a constant.
 */
interface RunningConfigEntry {
  /** Dotted path into the config object, e.g. `planning.requireApproval`. */
  path: string;
  value: unknown;
  /** Whether this is the built-in default — false means somebody chose it. */
  isDefault: boolean;
}
export interface RunningConfigGroup {
  title: string;
  entries: RunningConfigEntry[];
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
  /** 'reply_draft' | 'merge' | 'plan' | 'shortfall'. */
  kind: string;
  /** The act's subject, e.g. `pr:42:merge`, `issue:12:plan` or `issue:12:shortfall`. */
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
  | 'issue_linked';

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

/** What an operator can do with work that did not survive the last run. */
export type RecoveryVerdict = 'restore' | 'requeue' | 'remove';

/** One piece of work orphaned by a crash or a shutdown, awaiting a verdict. */
export interface OrphanedWork {
  /** The identity everywhere: the route, the card key, the verdict. Every candidate has one. */
  taskId: string;
  /** Null when the restart landed before an agent was ever spawned for the task. */
  agentId: string | null;
  title: string;
  kind: string;
  originRef: string | null;
  branch: string | null;
  /** The agent's working directory; null when no agent ever started. */
  cwd: string | null;
  /**
   * `crashed` — the process fell over; `interrupted` — it was shut down cleanly;
   * `never_started` — a task recorded by a dispatch the restart caught before its
   * agent was spawned, which left its origin and branch held shut.
   */
  died: 'crashed' | 'interrupted' | 'never_started';
  /** The question it was parked on when it went, if it was parked on one. */
  waitingReason: string | null;
  /** Its last `note_progress` line — the best account there is of how far it got. */
  note: string | null;
  /** When the agent started, or when the task was recorded if none ever did. */
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
  /**
   * Chains of stacked pull requests, derived from the world each pulse rather than
   * stored. A plan *adopts* a stack, so a chain someone opened by hand is drawn on
   * the same terms as one a plan produced. Optional so an older server draws none.
   */
  stacks?: Stack[];
  /**
   * Finished goals the operator is keeping on the Goal Floor whose issue the world
   * has forgotten (issue #203) — closed by hand, or the watch tag removed. Shipped
   * beside `world.issues` rather than mixed into it, so the Yard and world panels
   * stay a view of the live world while the floor merges these in to keep the way
   * in to a run's report. Each carries `completion` (never dismissed here — a
   * dismissed one is not retained). Optional so an older server draws none.
   */
  floorCompletions?: Issue[];
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
  recovery?: OrphanedWork[];
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

/** One pull request in a stack, bottom-first by `position`. */
export interface StackRung {
  prNumber: number;
  title: string;
  branch: string;
  /** The branch this rung targets — the rung beneath it, or the default branch. */
  base: string;
  /** 1-based, bottom-first. */
  position: number;
  /** The plan part this rung delivers, when a plan adopted the stack. */
  partSlug: string | null;
}

/** A chain of stacked pull requests. Mirrors `src/stacks/stack.ts` by hand — the web bundle imports no server code. */
export interface Stack {
  ref: string;
  issueNumber: number | null;
  issueTitle: string | null;
  planId: string | null;
  rungs: StackRung[];
}
