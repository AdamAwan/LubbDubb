/**
 * The cockpit wire contract — the shape of what the HTTP routes ship and what the
 * SPA reads back, declared **once** so the producer and the consumer are the same
 * type rather than two hand-maintained copies of one.
 *
 * They were two copies, and the drift was silent in one direction only:
 * `buildStateSnapshot` had no declared return type, `AppState` was a standalone
 * ~30-key mirror of whatever it inferred, and the two met at a single unchecked
 * `json<AppState>(r)` assertion in `web/src/api.ts`. Rename or re-nest a key in
 * the builder and `typecheck`, `typecheck:web` and `knip` all stayed green while
 * the panel rendered empty at runtime. The tests were the visible symptom —
 * several cast a real snapshot through `unknown` to a locally re-declared shape,
 * a third copy drifting independently of the other two.
 *
 * **Type-only, and that is what makes it safe to share.** The "web bundle imports
 * no server code" constraint is about *runtime*: `import type` is erased before
 * anything is bundled, so a declaration both sides name adds nothing to the SPA.
 * `test/wireContract.test.ts` asserts that structurally — this module and the
 * modules it names must contribute no runtime — rather than leaving it to be
 * remembered.
 *
 * **The domain types are reused, never re-declared.** A wire type here either *is*
 * the server's own type or `extends` it, so the 26 hand-copied literal unions the
 * cockpit used to carry — three different widening strategies in one file, with no
 * rule for which — are gone. `Job.status` is `JobStatus`, not `string`, so the
 * cockpit's `j.status === 'queued'` is checked against the union the server
 * actually writes; `Proposal.action` is the validated `Action`, not an
 * index-signature bag.
 *
 * **Every key is required unless the value is genuinely conditional.** The
 * optional-for-an-older-server hedging the cockpit's copy carried is what a shared
 * contract removes the need for: the SPA is built from this tree by
 * `npm run web:build`, so there is one version of the wire and a dropped key is a
 * bug, not a deployment skew to tolerate. A key that may be *absent* is optional;
 * a key that is always sent but may be empty is `| null`.
 */

import type { PlanDiff } from './plans/planDiff.js';
import type { AcceptanceCriterion } from './plans/parts.js';
import type { PlanningPolicy } from './plans/planning.js';
import type { CiPolicyDescription } from './ci/describeCiPolicy.js';
import type { CiVerdict } from './ci/ciPolicy.js';
import type { IssuePickupStatus } from './dispatcher/issuePickup.js';
import type { DispatchRule } from './dispatcher/rules.js';
import type { QueueItem } from './dispatcher/dispatcher.js';
import type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
import type { OrphanedWork } from './agents/crashRecovery.js';
import type { FileOverlap } from './fileOverlap.js';
import type { UnrecordedWork } from './graph/unrecorded.js';
import type { PrAttention } from './prAttention.js';
import type { PrHealth } from './prHealth.js';
import type { ControlState } from './runtimeControl.js';
import type { RunningConfigGroup } from './server/runningConfig.js';
import type { ReliabilityInsights, RunTally } from './reliabilityInsights.js';
import type { SpendInsights } from './spendInsights.js';
import type { SpendTrend } from './spendTrend.js';
import type { Stack } from './stacks/stack.js';
import type {
  AccountRateLimits,
  Agent,
  AgentFile,
  AgentFlag,
  AssayAuthor,
  BugFiling,
  ConclusionAuthor,
  Decision,
  DeliveryAuthor,
  ErrorLogEntry,
  Escalation,
  Finding,
  GoalAssayVerdict,
  HumanTask,
  IssueConclusionVerdict,
  IssueRunOutcome,
  IssueState,
  IssueSpend,
  Issue as WorldIssue,
  Job,
  JobAttachment,
  JobSchedule,
  Plan,
  PlanPart,
  PlanRevision,
  Proposal,
  PullRequest as WorldPullRequest,
  Retrospective,
  ScratchEntry,
  ShortfallAuthor,
  ShortfallCause,
  StackLanding,
  Task,
  ValidationCheck,
  ValidationResource,
  ValidationVerdict,
  WorkNode,
  WorldEvent,
  WorldSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// The enriched world (`/api/state` → `world`)
// ---------------------------------------------------------------------------

/**
 * A pull request as the cockpit receives it: the world's own row plus the
 * verdicts the server folds for it.
 *
 * The three are computed here rather than in the browser for one reason each
 * states in its own module — `ciVerdict` most sharply, since re-matching
 * `config.ci` client-side would mean a second glob matcher and a second
 * first-match-wins ordering sitting nowhere near the rule they duplicate.
 *
 * They are optional **on this type** because the recently-closed list carries
 * none of them: nothing acts on a dead PR, so nothing folds a verdict for one.
 * The open list ships {@link OpenPullRequest}, where all three are required — so
 * a builder that stopped computing one is a compile error at the site that
 * caused it, while a component that renders either list stays honest about the
 * closed case.
 */
export interface PullRequest extends WorldPullRequest {
  /** Why the PR is stuck — *can this merge*. Empty reasons = healthy. */
  health?: PrHealth;
  /** Whose turn it is — a different question from {@link PullRequest.health}, with different right answers. */
  attention?: PrAttention;
  /** What the harness will do about each *failing* check, from `classifyCiFailures`. */
  ciVerdict?: CiVerdict;
}

/** An open pull request, where all three verdicts are always folded. */
export interface OpenPullRequest extends PullRequest {
  health: PrHealth;
  attention: PrAttention;
  ciVerdict: CiVerdict;
}

/**
 * An issue as the cockpit receives it. Every verdict below sits *beside* `pickup`
 * and inside none of the others, because each answers a different question:
 * pickup says what the harness would do next cycle, and the rest say what anybody
 * has concluded about the goal itself.
 */
export interface Issue extends WorldIssue {
  /** What the harness is doing with this item — or why it is leaving it alone. */
  pickup: IssuePickupStatus;
  /**
   * Whether anyone has said this issue is finished. `undeclared` is a value and
   * not the absence of one — see `resolveIssueConclusion`.
   */
  conclusion: {
    verdict: IssueConclusionVerdict | 'undeclared';
    by: ConclusionAuthor | 'plan' | null;
    note: string;
    at: string | null;
  };
  /** An assessor's "this was worked and the goal is still not reached". Null when nothing has. */
  shortfall: {
    cause: ShortfallCause | null;
    partSlug: string | null;
    summary: string;
    by: ShortfallAuthor;
    decidedAt: string;
  } | null;
  /**
   * The positive mirror of {@link Issue.shortfall}, present **only while the
   * verdict still stands** — the same reading `deliveryHold` gives rule
   * `issue-pickup`. Absent means "no standing goal check", never "there was never
   * one".
   */
  delivery: {
    summary: string;
    by: DeliveryAuthor;
    decidedAt: string;
  } | null;
  /**
   * The intake verdict (#158). Null is a third reading, not a synonym for
   * `workable`: a goal nothing has assayed has no drill on its floor at all.
   */
  assay: {
    verdict: GoalAssayVerdict;
    summary: string;
    by: AssayAuthor;
    decidedAt: string;
    /**
     * The standing comment the assay desk keeps on the ticket, as a canonical
     * ref to look up in {@link CockpitState.refUrls} (#171) — null when no
     * comment was written, and absent from `refUrls` when the provider builds no
     * URLs. Both draw nothing: a caption with no link would assert a comment
     * exists while giving nobody a way to read it.
     */
    commentRef: string | null;
    /**
     * The model profile the assayer proposed for this goal's work (#342), and
     * whether it is still waiting on an answer. Null profile = it named none,
     * which is every `unclear` verdict and every deployment with no profiles.
     *
     * `awaiting` is the gate itself, shipped as a fact rather than re-derived in
     * the browser: it is the difference between a chip that explains why nothing
     * is being dispatched and a row that silently sits still.
     */
    proposedProfile: string | null;
    awaitingProfileAnswer: boolean;
  } | null;
  /**
   * The profile this goal's work is pinned to (#342) — the tag on its ticket —
   * and any model tags on it that name nothing.
   *
   * Null profile is "not pinned", which is not a synonym for the default: the
   * cockpit draws an unpinned goal as running on its rules, and a pinned one as
   * carrying a decision somebody made. `ignoredTags` is what a mistyped label
   * looks like from here — the pin falls back to the rule rather than parking
   * anything, so the only way it is not silent is being drawn.
   */
  modelPin: { profile: string | null; ignoredTags: string[] };
  /** The run's own write-up — the *reading*; the document is fetched on open. */
  retrospective: { summary: string; hasDocument: boolean; updatedAt: string } | null;
  /** The shared pad — how much is there and when, never the trail itself. */
  scratchpad: { entries: number; updatedAt: string } | null;
  /**
   * The harness's run at this goal (issues #203, #234): minted the first pulse it
   * had work under it, finished when the goal was first observed reached, and
   * ended only by the operator's dismissal. **Absent** is a goal never worked —
   * four states off one optional field, and the dismissal is terminal for the
   * dispatcher as well as for the card.
   */
  run?: { startedAt: string; completedAt: string | null; outcome: IssueRunOutcome | null; dismissed: boolean };
  /**
   * Whether this goal's validation plan is settled (`validationVerdict`), and by
   * how much it is not. **Null is "no checks", not "clear"** — a goal nobody wrote
   * a validation plan for is drawn with no chip at all, where a clear verdict is
   * drawn as one that was earned.
   *
   * Folded on the server rather than counted in the browser for the reason the CI
   * verdict is: the close-out obligation, the ticket comment and this chip all
   * read one function, and a second count is a second opinion about what `unrun`
   * and `deferred` mean.
   */
  validation: ValidationVerdict | null;
  /**
   * What this goal has cost so far, over every agent under it — its planner, its
   * assay, its parts, and the agents its pull requests pulled in (`rollUpIssueSpend`).
   *
   * **Null is "nothing was ever measured", not zero.** PTY agents report no usage
   * at all, so a goal worked entirely in that mode has no spend row; drawing it as
   * `$0.00` would report a free goal where the truth is an unmeasured one.
   */
  spend: IssueSpend | null;
}

/** The world as `/api/state` ships it: the baseline, with both lists enriched. */
export interface CockpitWorld extends WorldSnapshot {
  pullRequests: OpenPullRequest[];
  /** Absent when the retention window is disabled or the baseline predates it. */
  closedPullRequests?: PullRequest[];
  issues: Issue[];
}

// ---------------------------------------------------------------------------
// `/api/state`
// ---------------------------------------------------------------------------

/**
 * A plan part with the two readings the sheet needs and the row cannot carry.
 *
 * Both are derived rather than stored, and both are derived **here** rather than
 * in the browser: the criteria because their text is the key a tick is stored
 * under, so a second split is a second opinion about that key; the drift because
 * it is a join across `agent_files` and `tasks` that the cockpit does not hold and
 * should not have to.
 */
export interface PlanPartView extends PlanPart {
  /**
   * How deep in the stack this part sits — `partDepth`, the longest path to a part
   * with no dependencies, which is also the wave the sheet's map draws it in.
   *
   * Shipped rather than recomputed in the browser because it is the dispatcher's
   * own ordering: a second implementation could draw a rejoin in a wave before the
   * thing it waits for and be internally consistent while disagreeing with what
   * actually runs.
   */
  depth: number;
  /** {@link PlanPart.acceptance} as a checklist, with each criterion's confirmation folded in. */
  acceptanceCriteria: AcceptanceCriterion[];
  /**
   * Paths this part's agents wrote that its `touches` did not declare. Always
   * empty when it declared none — an undeclared part has not been contradicted.
   */
  outsideScope: string[];
}

/**
 * A validation resource with the one reading the row cannot carry: where it
 * actually is on this machine.
 *
 * Resolved on the server because the path is `validationRoot` joined with the
 * goal's directory, and `validationRoot` is config the browser does not hold —
 * and because "is it there" is a filesystem question. Both are shipped so a
 * missing fixture is a stated fact rather than a check that fails for a reason
 * nobody can see.
 */
export interface ValidationResourceView extends ValidationResource {
  /** Absolute, on the machine the harness runs on — which is the operator's own. */
  path: string;
  present: boolean;
}

/**
 * What `GET /api/plans/:id/history` ships: every verdict a plan has had, and the
 * last amendment read as a change.
 *
 * Its own route rather than a field on the state snapshot, for the reason the work
 * graph and the retro have theirs: it is read when a sheet is opened, not every
 * pulse, and the write-ups it carries are the largest prose the store holds. A
 * plan with one verdict still answers — with one revision and a null diff, which
 * is the honest shape of "nothing has been amended".
 */
export interface PlanHistory {
  revisions: PlanRevision[];
  diff: PlanDiff | null;
}

/**
 * The last cycle's ordered pickup plan (issue #69) — "what's next as of this
 * pulse". A projection recomputed every cycle, not a persisted queue; `at` is the
 * world snapshot it was planned against.
 *
 * Declared here rather than beside the `Harness` that caches it because the
 * cockpit is its only reader: `harness.upcoming` exists to be shipped.
 */
export interface UpcomingPlan {
  cycleId: string;
  at: string;
  items: QueueItem[];
}

/**
 * An audited decision, plus the one external thing it is *about* as a canonical
 * ref (`issue:13`, `pr:42`) — the shift log's Ref column.
 *
 * The ref is computed on the server by `decisionSubjectRef` and shipped rather
 * than derived in the browser from `action`, which the cockpit does hold. That is
 * deliberate: the same answer keys `refUrls` and is looked up in it, and a second
 * reading of the action bag is a second chance to key one shape and look up
 * another — a failure that shows up only as a ref rendering plain, on exactly the
 * action types the two readings disagree about.
 *
 * Null is a real reading: an escalation, a note to an agent naming no origin and
 * a no-op have no external subject, and the column draws a dash.
 */
export interface CockpitDecision extends Decision {
  subjectRef: string | null;
}

/**
 * What the rack needs to draw the "land the stack" control on one chain: whether
 * it may be offered, and what the operator has already authorized.
 *
 * `offer` is decided on the server and shipped rather than re-derived in the
 * cockpit, for the reason `PrAttention` is: a client-side second opinion about
 * whether a merge may be authorized is exactly the drift that outlives the change
 * that introduces it. The route asks the same function again before recording,
 * because a disabled button is a courtesy and not a gate.
 */
interface StackLandingView {
  /** The stack this concerns, as `/api/state` is currently deriving it. */
  ref: string;
  /** Whether every rung is clear, so the click may be offered at all. */
  offer: boolean;
  /** The first thing withholding the button, for the sentence beside it. */
  blockedBy: string | null;
  /** The operator's standing (or stopped) intent over this chain, if there is one. */
  landing: StackLanding | null;
  /** How many of `landing.rungs` have merged — the "1" in "landing 1 of 3". */
  landed: number;
}

/** The frozen half of the running config the cockpit needs to draw itself. */
interface CockpitConfig {
  heartbeatIntervalMs: number;
  maxConcurrentAgents: number;
  /** `${labelPrefix}-watch` — the tag the watch toggle sets and that marks an item watched. */
  watchLabel: string;
  /** `${labelPrefix}-ignore` — the tag the ignore toggle sets and that marks an item ignored. */
  ignoreLabel: string;
  /**
   * The model profiles a goal or a part may be pinned to (#342), cheapest first,
   * with what each is for.
   *
   * Shipped for `containerTypes`' reason: the order is a policy the operator set
   * (`rank`), and the cockpit re-deriving one would be a second opinion about
   * which profile is deeper. Empty turns every profile control off — a deployment
   * with no `agentModels` has nothing to choose between, which is not the same as
   * a choice with no options.
   */
  profiles: { name: string; description: string }[];
  /**
   * `agentModels.default` — what an unpinned dispatch falls back to, so a pin can
   * be drawn as the departure from it that it is. Null when none is configured.
   */
  defaultProfile: string | null;
  /**
   * `issueContainerTypes` — the work-item types that hold work rather than being
   * it. Shipped because the backlog draws a container as a *heading* over its
   * children rather than as a row beside them, and that is a decision about the
   * item's type made before any verdict: `pickup.status` cannot answer it, since
   * an ignored container reports `ignored` and a container under a gate-off
   * deployment reports something else again. Read the policy, not a symptom.
   */
  containerTypes: string[];
  /**
   * Whether a real tracker is configured to file into — gates "File ticket" on a
   * finding and "File a work item" on unrecorded work, off the same predicate
   * both routes refuse on.
   */
  canFileTickets: boolean;
}

/** Account-level Claude usage: the rolling cost windows, plus real limits when captured. */
interface CockpitUsage {
  windows: { fiveHourCostUsd: number; sevenDayCostUsd: number };
  /** Pro/Max only, via the PTY status-line capture. Null => the UI falls back to cost. */
  rateLimits: AccountRateLimits | null;
  /**
   * Spend that belongs to no goal — an operator's job the graph never linked to an
   * issue, or an agent dispatched against no origin at all. The counterpart to
   * {@link Issue.spend}: with it, the per-goal figures read as a partition of what
   * the fleet has spent; without it, they read as complete while a remainder no
   * card shows grows behind them.
   */
  unattributedCostUsd: number;
}

/**
 * The whole `/api/state` payload — `buildStateSnapshot`'s declared return type and
 * the cockpit's `AppState`, which is now the same type rather than two.
 */
export interface CockpitState {
  config: CockpitConfig;
  /** Live, mutable dispatch controls — the current cap and pause state. */
  control: ControlState;
  /**
   * When `world` was observed. The cockpit's world is the baseline the last pulse
   * persisted, not a live provider read, so its age is shown rather than implied.
   * Null before the first cycle, when the world is empty.
   */
  worldObservedAt: string | null;
  world: CockpitWorld;
  /**
   * Work the previous run left orphaned, each awaiting a restore / requeue /
   * remove. **A non-empty list means the harness is running no cycles at all**,
   * which is why the cockpit draws it as a blocking banner rather than a panel.
   */
  recovery: OrphanedWork[];
  /**
   * Runs whose issue the world has forgotten (issues #203, #234) — rebuilt from
   * the run's own snapshot and enriched through the same path as a live issue, so
   * a retained card and a live one cannot disagree. The same list the dispatcher
   * unions into its issue view, which is what makes a goal drawn here one the
   * harness can still act on.
   */
  retainedRuns: Issue[];
  /** The multi-PR plan graph: one plan per planned issue, and every plan's parts. */
  plans: Plan[];
  planParts: PlanPartView[];
  /**
   * Every plan's validation checks and the resources they name, keyed to a plan
   * by `planId` exactly as the parts are.
   *
   * Superseded checks ride along rather than being filtered here: the sheet draws
   * them greyed as the record of what a plan withdrew, and a filter on the wire
   * would leave the browser unable to say the difference between a check that was
   * dropped and one that was never written.
   */
  validationChecks: ValidationCheck[];
  validationResources: ValidationResourceView[];
  /**
   * The funnel's policy, as the harness is actually running it.
   *
   * Shipped because approving a decomposition is agreeing to a *rate* as well as a
   * shape — `maxConcurrentPartsPerIssue` is how many of its parts run at once, and
   * the plan sheet states it on the button that performs the approval. The
   * settings modal reads the same values through the running-config route; this is
   * the one the sheet needs on every draw.
   */
  planning: PlanningPolicy;
  /**
   * Chains of stacked pull requests, derived from the world each pulse rather
   * than stored — a plan *adopts* a stack, so a hand-opened chain is drawn on the
   * same terms as one a plan produced.
   */
  stacks: Stack[];
  /**
   * One entry per chain in {@link stacks}: whether "land the stack" may be
   * offered, and the operator's standing intent over it if there is one.
   *
   * Beside `stacks` rather than folded into it, because `buildStacks` is a pure
   * fold over the world and an intent is a stored row — and because the two are
   * joined by *rung membership*, not by ref: `Stack.ref` names the bottom rung,
   * which is the first thing to merge, so a match on it would lose the intent at
   * the very moment the operator most needs to see it progressing.
   */
  stackLandings: StackLandingView[];
  tasks: Task[];
  /** Operator-launched jobs, newest first — the queue and its recent history. */
  jobs: Job[];
  /**
   * Recurring blueprints, oldest first — every one the operator has written,
   * enabled or not. What a firing produces is an ordinary entry in {@link jobs},
   * so the queue above is where a recurrence becomes visible as work.
   */
  schedules: JobSchedule[];
  agents: Agent[];
  /**
   * The ids of agents parked because the *account's* usage limit is spent, rather
   * than because they asked anything (issue #318). They are ordinary `waiting` rows
   * in {@link agents} — the reason is on the row — and this is what tells the two
   * parks apart, so the cockpit offers "resume" where a reply box would be a dead
   * end: nobody can answer a limit, and the session is usually gone with it.
   *
   * A list of ids rather than a field on the row, because the park is a fact about
   * the *fleet this process is holding*, not about the row: a restart drops every
   * one of them, at which point the same rows are the recovery desk's question and
   * resuming them is its verdict, not this button.
   */
  parkedOnLimit: string[];
  /** Artifacts agents surfaced mid-run, grouped by agentId in the UI. */
  flags: AgentFlag[];
  /**
   * Flag id → the URL to open that artifact by navigation, carrying its per-flag
   * capability. An http(s) flag is absent here — the cockpit links those directly.
   */
  artifactUrls: Record<string, string>;
  /**
   * Images an operator attached to a blueprint (issue #249), every ref in one
   * list. The cockpit filters by `targetRef`: `job:<id>` while the blueprint is
   * queued, `issue:<n>` once it has been filed as a ticket.
   *
   * The domain type, `path` and all — the same absolute-paths-are-shipped stance
   * `AgentFile` and `Agent.cwd` already take, and it is what lets the operator
   * match a thumbnail against the path their agent was told to read.
   */
  attachments: JobAttachment[];
  /** Attachment id → the URL to load its bytes from, carrying its capability. */
  attachmentUrls: Record<string, string>;
  /** Every file agents wrote (file-events hook), for the drawer's "files changed" list. */
  files: AgentFile[];
  /** Paths two concurrently-running agents both wrote (issue #113). */
  overlaps: FileOverlap[];
  /** What agents noticed outside their own tasks, newest first. */
  findings: Finding[];
  /**
   * Bugs the operator raised from a story row, oldest first — `filing` while the
   * desk agent writes one, `filed` with a ref once it exists.
   *
   * Several per story is normal: a story can be wrong in more than one way, and
   * each is its own bug. The row groups them by `originRef`.
   */
  bugFilings: BugFiling[];
  /**
   * Work only a person can do, newest first — open ones and a settled tail.
   *
   * Beside `findings` rather than inside `escalations`, because it is not an
   * alert: no agent is parked on one, and it outlives every agent that asked.
   */
  humanTasks: HumanTask[];
  escalations: Escalation[];
  /** Acts put to a human, newest first. */
  proposals: Proposal[];
  decisions: CockpitDecision[];
  /**
   * The dispatcher's "Up next" queue from the last pulse — null until a cycle has
   * run. A per-pulse projection, recomputed from the world every cycle, never a
   * persisted FIFO.
   */
  upcoming: UpcomingPlan | null;
  worldEvents: WorldEvent[];
  /** Recorded failures, newest first — the Errors panel. */
  errors: ErrorLogEntry[];
  usage: CockpitUsage;
  /**
   * How the fleet's runs have ended, all-time. Six counts rather than the whole
   * reliability breakdown, for `usage`'s reason exactly: this is what the Yield
   * gauge needs to *draw*, and the reading behind it rides on `/api/reliability`,
   * which walks a fortnight of CI transitions as well. Both come from
   * `tallyRunOutcomes`, so the gauge and the panel cannot disagree.
   */
  runOutcomes: RunTally;
  /**
   * External reference → web URL, built entirely by the source-control provider
   * (never string-built in the cockpit). Missing key ⇒ render as plain text.
   */
  refUrls: Record<string, string>;
  /**
   * The rule book, keyed by the rule id a decision carries. The Decision log looks
   * `decision.rule` up here; a missing key ⇒ no rule identity to show.
   */
  dispatchRules: Record<string, DispatchRule>;
}

// ---------------------------------------------------------------------------
// The routes that are fetched rather than polled
// ---------------------------------------------------------------------------

/**
 * `/api/work` and `/api/work/:ref`. The durable work graph never forgets, so
 * shipping the forest on every poll would be the wrong shape: the roots are read
 * once on mount and a subtree when one is opened.
 */
export interface WorkRootsPayload {
  roots: WorkNode[];
  unrecorded: UnrecordedWork[];
  refUrls: Record<string, string>;
}

export interface WorkSubtreePayload {
  nodes: WorkNode[];
  refUrls: Record<string, string>;
}

// -- The Tickets tab (issue #329) -------------------------------------------

/**
 * The harness's reading of an item, and the tracker's — the two axes the tab
 * filters on, and deliberately two rather than one.
 *
 * `watch` is a label an operator sets and the dispatcher's gate reads; `state` is
 * the tracker's own word. Folding them would make "nobody has triaged this" and
 * "this is finished" the same kind of answer, which is exactly the distinction the
 * tab exists to let someone ask about.
 */
export type TicketWatchFilter = 'any' | 'watched' | 'unwatched' | 'ignored';
export type TicketStateFilter = 'any' | 'open' | 'closed';
/** By tracker id descending (arrival order), or by what the fleet spent under it. */
export type TicketOrder = 'added' | 'cost';

/** One row of the Tickets tab. */
export interface TicketRow {
  number: number;
  title: string;
  state: IssueState;
  /** Three-valued: an untagged item is `unwatched`, not `ignored`. → `src/watchLabels.ts` */
  watch: TicketWatchFilter & ('watched' | 'unwatched' | 'ignored');
  labels: string[];
  /**
   * Dollars spent under this goal, or **null** where the fleet never ran on it.
   * Null rather than `0`: never worked and worked for free are different facts.
   */
  costUsd: number | null;
  /**
   * The harness's own outcome for a goal it worked — `delivered`, `fell short`,
   * `concluded`, `abandoned` — or null for one it never reached a verdict on.
   * Row information, not a third filter: it answers a different question from
   * either axis, and a third control would make the filter row a cube.
   */
  outcome: string | null;
  /** The tracker's creation instant — what the `added` ordering is a proxy for. */
  addedAt: string;
  /** The tracker's last-modified instant. */
  changedAt: string;
}

/**
 * `/api/tickets` — one page of the mirror, fetched on open and again as the list
 * is scrolled. Never on `/api/state`: that endpoint comes round every couple of
 * seconds and this list is all-time.
 */
export interface TicketsPayload {
  rows: TicketRow[];
  /** Rows matching the filters, all of them — what makes "40 of 906" sayable. */
  total: number;
  /**
   * The whole mirror, unfiltered — the size of the history itself.
   *
   * Separate from `total` because they answer different questions and a surface
   * that showed one as the other would state a shrinking history every time
   * someone narrowed the list. The head names this; the filter row names `total`.
   */
  kept: number;
  /** What the whole filtered set cost, not the page. */
  totalCostUsd: number;
  /** Where the next page starts, or null at the foot of the list. */
  nextCursor: string | null;
  /**
   * One month before the first sweep, frozen. The floor under the history, stated
   * because it is a cap: a list that simply stopped would read as one that failed
   * to load rather than as one that has reached the beginning.
   */
  anchorAt: string;
  /**
   * True while the first sweep is still filling the mirror — the one slow read,
   * and the difference between an empty tab and a broken one.
   */
  backfilling: boolean;
  /**
   * Reference → web URL, resolved off the connector rather than read from the
   * snapshot's map: `buildRefUrls` is built from the world, and most rows here
   * have long left it.
   */
  refUrls: Record<string, string>;
}

/** `/api/retrospectives/:ref` — the document itself, fetched when a reader opens it. */
export interface RetrospectivePayload {
  retrospective: Retrospective | null;
}

/** `/api/scratchpads/:ref` — a goal's shared pad in full, fetched on open. */
export interface ScratchpadPayload {
  padRef: string;
  entries: ScratchEntry[];
}

/**
 * `/api/spend` — the breakdown behind the cost indicators: the same money split
 * by phase, by goal and over time. Fetched on open for the work graph's reason —
 * it reads every agent the harness has ever run.
 */
export interface SpendPayload {
  insights: SpendInsights;
}

/**
 * `/api/spend/trend` — the same money on a week axis, cohorted by the goals that
 * closed. Fetched on the trend tab's *first visit* rather than with the
 * breakdown: it reads two months of world events on top of the same all-time
 * agent walk, and the tab an operator never opens should cost nothing.
 */
export interface SpendTrendPayload {
  trend: SpendTrend;
}

/**
 * `/api/reliability` — what the spending bought: run outcomes all-time, and CI
 * health over the last fortnight. Fetched on open for `SpendPayload`'s reason.
 */
export interface ReliabilityPayload {
  insights: ReliabilityInsights;
}

/**
 * `/api/prompts` — the rule dispatcher's prompt book. Fetched on open for the
 * opposite reason to the work graph: it is read once at boot, so polling it would
 * be paying for a constant.
 */
export interface PromptsPayload {
  dir: string | null;
  templates: PromptTemplateDescription[];
}

/** `/api/config` — the running config, fetched on open for the prompt book's reason. */
export interface RunningConfigPayload {
  groups: RunningConfigGroup[];
}

/**
 * `/api/ci-policy` — the effective per-check CI policy, fetched on open for the
 * running config's reason. Separate from {@link RunningConfigPayload} because it
 * is a *derivation* and not a reading: `ci.checks` is already on that payload as
 * a raw JSON leaf, and what this adds is what the leaf does not say — the
 * inherited `ignore`, the unmatched `dispatch`, and which policy kinds become
 * checks at all.
 */
export interface CiPolicyPayload {
  policy: CiPolicyDescription;
}

// ---------------------------------------------------------------------------
// The cockpit's import surface
// ---------------------------------------------------------------------------

/**
 * Everything above names types that live in the module that computes them, and
 * the cockpit needs those names too. Re-exporting them here rather than having
 * `web/src/types.ts` reach into a dozen server modules keeps the SPA's view of
 * the harness to **one** import path — so "what does the cockpit see" has a
 * single answer, and adding a field to a panel cannot quietly widen that surface.
 */
export type {
  Agent,
  AgentAskQuestion,
  AgentFile,
  AgentFlag,
  BugFiling,
  Decision,
  ErrorLogEntry,
  Escalation,
  Finding,
  HumanTask,
  IssueRelative,
  IssueSpend,
  Job,
  JobAttachment,
  JobAttachmentInput,
  JobSchedule,
  Plan,
  PlanEvidence,
  PlanNarrative,
  PlanPart,
  PlanPartInput,
  PlanRevision,
  Proposal,
  Retrospective,
  ScratchEntry,
  StackLanding,
  Task,
  ValidationCheck,
  ValidationCheckState,
  ValidationResource,
  ValidationResourceKind,
  ValidationVerdict,
  WorkNode,
  WorldEvent,
  WorldEventKind,
} from './types.js';
export type { RecoveryVerdict, OrphanedWork } from './agents/crashRecovery.js';
export type { CiPolicyDescription, CiRuleDescription, PolicyKindDescription } from './ci/describeCiPolicy.js';
export type { QueueItem } from './dispatcher/dispatcher.js';
export type { DispatchRule } from './dispatcher/rules.js';
export type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
export type { FileOverlap } from './fileOverlap.js';
export type { UnrecordedWork } from './graph/unrecorded.js';
export type { RunningConfigGroup } from './server/runningConfig.js';
export type {
  CiHealth,
  CiSubject,
  ReliabilityInsights,
  RunOutcome,
  RunOutcomeTotal,
  RunPhaseHealth,
  RunRepeat,
  RunTally,
} from './reliabilityInsights.js';
export type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun } from './spendInsights.js';
export type {
  SpendTrend,
  SpendTrendComparison,
  SpendTrendPeriod,
  SpendTrendPhaseShift,
  SpendTrendWeek,
} from './spendTrend.js';
export type { ChecksSpend, TaskTypeSpend } from './taskTypeSpend.js';
export type { Stack } from './stacks/stack.js';
export type { PlanDiff } from './plans/planDiff.js';
export type { AcceptanceCriterion } from './plans/parts.js';
export type { PlanningPolicy } from './plans/planning.js';
export type { ValidationPolicy } from './validation/policy.js';
