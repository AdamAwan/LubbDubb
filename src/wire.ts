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

import type { FilingTarget } from './sink/actionSink.js';
import type { SetupReading } from './setup/reading.js';
import type { SetupResolution } from './setup/resolve.js';
import type { PlanDiff } from './plans/planDiff.js';
import type { AcceptanceCriterion } from './plans/parts.js';
import type { RunwayReading } from './supply/runway.js';
import type { PlanningPolicy } from './plans/planning.js';
import type { PetRules } from './pets/rules.js';
import type { CiPolicyDescription } from './ci/describeCiPolicy.js';
import type { CiVerdict } from './ci/ciPolicy.js';
import type { IssuePickupStatus } from './dispatcher/issuePickup.js';
import type { PlacementAsk } from './intake/placement.js';
import type { DispatchRule } from './dispatcher/rules.js';
import type { QueueItem } from './dispatcher/dispatcher.js';
import type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
import type { OrphanedWork } from './agents/crashRecovery.js';
import type { BuildReading } from './selfUpdate/upgradePlan.js';
import type { FileOverlap } from './fileOverlap.js';
import type { UnrecordedWork } from './graph/unrecorded.js';
import type { PrAttention } from './prAttention.js';
import type { PoolStatus } from './pool/poolDesk.js';
import type { PoolRollup } from './pool/aggregate.js';
import type { PrHealth } from './prHealth.js';
import type { PrPackStanding } from './reviewPacks/standing.js';
import type { PrReviewState } from './review/prReviewState.js';
import type { ControlState } from './runtimeControl.js';
import type { RunningConfigGroup } from './server/runningConfig.js';
import type { ConfigChange } from './configApply.js';
import type { ReliabilityInsights, RunTally } from './reliabilityInsights.js';
import type { ReviewCalibration } from './reviewPacks/calibration.js';
import type { RemedyInsights } from './remedyInsights.js';
import type { AllowanceInsights } from './allowanceInsights.js';
import type { SpendInsights } from './spendInsights.js';
import type { McpInsights } from './mcpInsights.js';
import type { SpendTrend } from './spendTrend.js';
import type { Stack } from './stacks/stack.js';
import type { LocalRunOption } from './localRun/ref.js';
import type {
  AccountRateLimits,
  Agent,
  AgentFile,
  AgentFlag,
  AppraisalAuthor,
  BugFiling,
  CiStatus,
  ConclusionAuthor,
  Decision,
  DeliveryAuthor,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  ErrorLogEntry,
  Escalation,
  GoalArrival,
  GoalAppraisalVerdict,
  GoalEnvironmentReach,
  GoalReachStatus,
  HumanTask,
  IssueConclusionVerdict,
  IssueInstruction,
  IssueRelative,
  IssueRunOutcome,
  IssueState,
  IssueSpend,
  Issue as WorldIssue,
  Job,
  JobAttachment,
  Pet,
  PetActionKind,
  PetFlaw,
  PetProvenance,
  PetRarity,
  PetSpecies,
  PetStage,
  PetWallet,
  JobSchedule,
  AgentStatus,
  LocalRun,
  LocalValidation,
  LocalRunFreshness,
  LocalRunPorts,
  LocalRunTurn,
  ObstacleSighting,
  ObstacleStanding,
  Plan,
  PlanAmendmentAuthor,
  PlanPart,
  FeatureSummary,
  PlanRevision,
  Proposal,
  PrState,
  PullRequest as WorldPullRequest,
  ReadyingAction,
  Retrospective,
  ReviewAttention,
  ReviewMark,
  ReviewPackRecord,
  ReviewPackShare,
  ScratchEntry,
  ShortfallAuthor,
  ShortfallCause,
  StackLanding,
  GoalWatch,
  GoalWatchKind,
  WatchReading,
  WatchWindow,
  PoolFleetReading,
  StallPark,
  TaskSummary,
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
  /**
   * Whether this pull request has a **review pack**, and whether it is about the
   * head — the mark on its row (`src/reviewPacks/standing.ts`). Absent means no
   * pack and nobody writing one, which is what draws no mark.
   *
   * A standing rather than the pack: the pack is a document, read over its own
   * route by the page that draws it, and shipping twenty of them on every pulse to
   * answer one bit per row is the trade this field exists not to make.
   * → `docs/spec/31-review-packs.md#on-the-row`
   */
  pack?: PrPackStanding;
  /**
   * Where this pull request stands with the fleet's own reviewer — the mark on
   * its row and the card on its page (`src/review/prReviewState.ts`).
   *
   * Optional for a reason the three above do not share: it is **absent on a
   * deployment with the review off**, which is the default, and absent is what
   * draws no mark. It rides the closed and archived rows too, where the other
   * three do not: those are verdicts about what happens next, and nothing happens
   * next on a merged pull request — this is a record of what was already read,
   * and the page that asks why a diff merged with findings on it is exactly the
   * page reached after the merge.
   */
  review?: PrReviewState;
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
   * Set on a **retained run** and on nothing else — the one thing that tells a
   * goal the tracker has stopped returning from a live one, on the wire
   * (`docs/spec/03-world-model.md`). The tracker's fields above (title, body,
   * labels, `workItemState`) are the harness's copy from `lastSeenAt`, the last
   * pulse the item was in the open set, and may no longer be what the tracker
   * says. Every other reading on this object — the run, the plan, the pull
   * requests, the spend, the pad, the instructions — is the harness's own record
   * and is as current as any live goal's.
   *
   * `tracker` is the ticket mirror's reading of the item's own word since —
   * `Resolved`, `Closed`, or still open with the watch tag gone — and when the
   * tracker last changed it. Null where the deployment keeps no mirror, or the
   * item closed before the mirror's floor: the cockpit then says only that the
   * item left, not why.
   */
  stale?: {
    lastSeenAt: string;
    tracker: { state: IssueState; workItemState: string | null; changedAt: string } | null;
  };
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
   * `workable`: a goal nothing has appraised has no drill on its floor at all.
   */
  appraisal: {
    verdict: GoalAppraisalVerdict;
    summary: string;
    by: AppraisalAuthor;
    decidedAt: string;
    /**
     * The standing comment the appraisal desk keeps on the ticket, as a canonical
     * ref to look up in {@link CockpitState.refUrls} (#171) — null when no
     * comment was written, and absent from `refUrls` when the provider builds no
     * URLs. Both draw nothing: a caption with no link would assert a comment
     * exists while giving nobody a way to read it.
     */
    commentRef: string | null;
    /**
     * The model profile the appraiser proposed for this goal's work (#342), and
     * whether it is still waiting on an answer. Null profile = it named none,
     * which is every `unclear` verdict and every deployment with no profiles.
     *
     * `awaiting` is the gate itself, shipped as a fact rather than re-derived in
     * the browser: it is the difference between a chip that explains why nothing
     * is being dispatched and a row that silently sits still.
     */
    proposedProfile: string | null;
    awaitingProfileAnswer: boolean;
    /**
     * Where the appraiser says this goal belongs on the backlog, for the questions
     * that are **still open** — the appraiser proposed a value, the operator has
     * not said it does not apply, and the live work item still lacks the field.
     * Empty is the ordinary case, and covers a flat tracker entirely.
     *
     * Derived server-side on every snapshot rather than stored, which is what
     * makes it end by itself: an operator who sets the parent in the tracker by
     * hand drops the row on the next world read, with no timer and no dismissal.
     * The browser must not re-derive it — it has neither the area tree nor the
     * root node that says what "unclassified" means.
     */
    placement: PlacementAsk[];
    /**
     * When the operator answered the parent question — accepting the proposal,
     * supplying a container of their own, or saying this goal wants none.
     *
     * Shipped where {@link placement} is derived, and it is the one half of the
     * pair that could not be: `placement` says a question is *open*, and an
     * orphan with none open is either a goal nobody proposed anything for or one
     * whose answer was "it wants none". The cockpit draws those two differently
     * — the second is a decision somebody made — and the stamp is the only thing
     * that tells them apart.
     *
     * Scoped to this appraisal row, so a re-appraisal against rewritten goal text
     * arrives null and the question reads as open again. That is the same reading
     * `parentSettledAt` has server-side, carried rather than reinterpreted.
     */
    parentSettledAt: string | null;
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
  /**
   * The operator marked this goal a priority, and when. Null is not flagged.
   *
   * Beside the verdicts rather than inside `pickup`, because it is not one: every
   * other reading here says something about the goal, and this one says something
   * about the **queue** — which of the things the harness could do next it does
   * first. It changes no gate, so a flagged goal that is held is still held.
   */
  priority: { since: string } | null;
  /** The run's own write-up — the *reading*; the document is fetched on open. */
  retrospective: { summary: string; hasDocument: boolean; updatedAt: string } | null;
  /** The shared pad — how much is there and when, never the trail itself. */
  scratchpad: { entries: number; updatedAt: string } | null;
  /**
   * What the operator has told the fleet to do on this goal and no agent has
   * concluded yet, oldest first — shipped whole where the pad above ships a
   * count, because these are the operator's own short words and the cockpit's job
   * is to show them what is still standing.
   *
   * Empty is the normal state and is not a synonym for "nothing was ever asked":
   * an instruction is settled by the conclusion that answers it.
   */
  instructions: IssueInstruction[];
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
   * The goal's latest local validation — the fleet driving this machine's dev
   * environment and saying whether the changes work — or null for a goal nobody has
   * asked about.
   *
   * The **latest**, not a list: it is a button an operator presses, and what they
   * want back is what happened the last time they pressed it. The rows before it are
   * history nothing draws.
   */
  localValidation: LocalValidationView | null;
  /**
   * What this goal has cost so far, over every agent under it — its planner, its
   * appraisal, its parts, and the agents its pull requests pulled in (`rollUpIssueSpend`).
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
  /**
   * The open containers a goal with no parent could be hung off — `candidateParents`'
   * answer over the whole world, one list per snapshot rather than one per goal.
   *
   * Shipped rather than re-derived because the browser cannot derive it. The list
   * is the union of two things: the container-typed items in `issues`, and the
   * **parents of other items** — and on Azure, where the item list is narrowed by
   * tag and assignee, it is almost entirely the second. A picker filtering `issues`
   * by type alone therefore offers nothing on the deployments that raise the
   * question, which is a warning with no way to answer it.
   *
   * Empty on a tracker with no hierarchy, and on a world whose items name no open
   * container. `ParentPicker` draws no list at all in that case rather than an
   * empty select.
   */
  parentCandidates: IssueRelative[];
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

/**
 * The local run as the cockpit reads it.
 *
 * `LocalRun` plus the one derived fact, and the derivation is here rather than in
 * the cockpit for the reason every reading is: "is this going" is a rule about which
 * statuses count as live, and a cockpit re-deriving it would be a second opinion
 * able to disagree with the runner about whether to draw a Stop button.
 *
 * **The output is not here.** The tail is up to two hundred lines and the snapshot
 * is polled; it has its own route, fetched when the panel opens, on the same
 * argument that keeps the work graph and the prompt book off the snapshot.
 */
/**
 * What has happened on **one ref** — the branch a local run is on, or the branch a
 * candidate would be run at.
 *
 * The whole point of the type is the word *one*. A pull request is a fact about a
 * branch and not about a goal: a goal's work can sit on an integration branch that
 * combines several parts and is itself never opened as a PR, and a goal can have
 * three PRs none of which describe the ref you are about to check out. So `pr` is
 * the pull request **on this ref** or null, and a null is drawn as "no pull request
 * of its own" beside what *did* land there — never filled in from a sibling.
 *
 * Derived server-side, from the world baseline and the plan the harness holds. The
 * cockpit could match a branch to a PR itself; what it could not do is decide which
 * of a goal's PRs describes a ref, which is the mistake this type exists to make
 * impossible to make twice.
 */
export interface LocalRunRefFacts {
  ref: string;
  /** This is the integration branch, because the goal had no part branch to offer. */
  isDefaultBranch: boolean;
  /** The plan part whose branch this is, and where it sits. Null for the integration branch. */
  part: { slug: string; title: string; seq: number; total: number; status: PlanPart['status'] } | null;
  /** The pull request **on this branch**, or null — see the note above. */
  pr: {
    number: number;
    state: PrState;
    ciStatus: CiStatus;
    /** Named checks the CI policy classified as failing — its verdict, not a second reading of it. */
    failing: string[];
    approved: boolean;
    unresolved: number;
  } | null;
  /** How many of the goal's parts have merged, which is what "in the integration branch" means. */
  mergedParts: number;
  /**
   * An agent is working on this branch **now** — so what a run of it shows is a
   * moving target, and the panel says so rather than leaving it to be discovered.
   */
  agentOnIt: boolean;
  /**
   * When the harness last did anything on this branch: the newest task row's
   * `updatedAt`, or null if no task has ever named it.
   *
   * Task activity and **not** a commit date, which is what it would be if there
   * were a cheap way to ask: the snapshot is built synchronously on every `dirty`,
   * and git is not on that path. Drawn in those words, because "last commit 3d ago"
   * would be a claim about the branch that nothing here checked.
   */
  lastActivityAt: string | null;
}

/**
 * One goal the local run could be pointed at: where it would run, and what else it
 * could run instead.
 *
 * Keyed on `originRef` rather than joined onto {@link WorldIssue} for
 * {@link GoalReachView}'s reason — and the title is deliberately *not* here, because
 * the panel already draws the goal list and a second copy of a title is a second
 * thing to keep in step.
 */
/**
 * How far a local validation has got, derived on the server.
 *
 * Derived here and not in the browser, `Issue.validation`'s reason: the words come
 * off three facts that live in three different places — the row's status, whether a
 * plan has landed, and what the live local run is doing — and a cockpit that folded
 * them itself would be a second opinion about what "validating" means, free to
 * disagree with the row it is drawn beside.
 *
 * Null once the row is settled: there is a status to draw then, and a phase as well
 * would be two answers to one question.
 */
export type LocalValidationPhase = 'queued' | 'planning' | 'environment' | 'driving';

/** One file in a validation's own directory, and where the cockpit may fetch it. */
interface LocalValidationFile {
  /** The name a finding refers to. */
  name: string;
  /**
   * Where to fetch it — minted by the server, never built by the browser.
   *
   * A capability URL like the attachments', and for the identical reason: an
   * `<img src>` carries no bearer header, so a path the cockpit assembled would 401
   * on every authenticated deployment while working perfectly on an open one.
   */
  url: string;
}

/** One agent behind a validation, as the cockpit needs it to draw a door to it. */
export interface LocalValidationAgentView {
  id: string;
  status: AgentStatus;
}

/**
 * A goal's latest local validation, as the cockpit draws it.
 *
 * Extends the domain row rather than restating it, `src/wire.ts`'s rule, and adds
 * only what the browser cannot work out for itself: the phase (above), the served
 * URLs for the screenshots, and the agents to open.
 */
export interface LocalValidationView extends LocalValidation {
  phase: LocalValidationPhase | null;
  /**
   * The screenshots, with somewhere to fetch each.
   *
   * A second field rather than a widening of {@link LocalValidation.screenshots},
   * which stays the list of names a finding joins against: a wire type either *is*
   * a domain type or extends it, and rewriting a `string[]` as objects would be the
   * re-declaration that rule exists to refuse.
   */
  files: LocalValidationFile[];
  /** The agent that ran it, while there is one to open. */
  agent: LocalValidationAgentView | null;
  /** The agent dispatched to fix what it found. */
  fixAgent: LocalValidationAgentView | null;
}

export interface LocalRunTargetView {
  originRef: string;
  issueNumber: number;
  /** Where a start with no override goes: the tip of the stack. */
  target: LocalRunRefFacts;
  /** Every branch this goal may be run at, in plan order — the panel's expander, and the allow-list. */
  options: { option: LocalRunOption; facts: LocalRunRefFacts }[];
  /**
   * This goal has a branch of its own to look at.
   *
   * What the panel's default filter keeps. A goal nothing has started resolves to
   * the integration branch, which is the same thing every other such goal resolves
   * to — a list of them is a list of one choice repeated.
   */
  runnable: boolean;
}

export interface LocalRunView extends LocalRun {
  live: boolean;
  /** What has happened on the branch that is up. Null when nothing has ever run. */
  refFacts: LocalRunRefFacts | null;
  /**
   * What the session last said it was doing — its newest `phase:` line — or null
   * before it has said, and once the run has settled.
   *
   * Here rather than left for the cockpit to find in the tail for `live`'s reason:
   * which of a session's lines counts as a stage is one rule, and a component
   * re-deriving it could caption the panel with something its own log contradicts.
   */
  phase: string | null;
  /**
   * Which turn is in flight on the held session, or null between turns. What the
   * stage line is captioned with, and what says a `running` environment is in the
   * middle of a refresh or a message rather than idle.
   */
  turn: LocalRunTurn | null;
  /**
   * Whether this harness holds a session for the run. False after a restart that
   * could not bring it back: the row is live, the environment may well be up, and
   * there is nobody to type to — so the panel offers no message box.
   */
  holdsSession: boolean;
  /** The watch's port reading, or null while nothing is live or nothing has been taken yet. */
  ports: LocalRunPorts | null;
  /** The watch's freshness reading, null on the same terms. */
  freshness: LocalRunFreshness | null;
}

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
  /**
   * The change waiting on the operator, if there is one — a plan that is running
   * *and* has a correction pending against it.
   *
   * Here rather than on the plan itself because it belongs with the other reading
   * of what an amendment did: the sheet draws the pending one immediately above
   * "what changed", and the two are the same question asked either side of a
   * decision. Null is the ordinary case, and there is at most one — a second
   * pending amendment is refused where it is proposed.
   */
  pending: PendingPlanAmendment | null;
}

/**
 * A pending amendment as the plan sheet reads it: why, and what it would change.
 *
 * The diff is `proposedPlanDiff` — the *server's* reading, and the same one
 * `latestPlanDiff` gives for an amendment already applied, so a change looks the
 * same before and after it is accepted. The document itself is not shipped: it is
 * the largest prose the store holds and the operator decides on the diff, which is
 * what the approval card carries too.
 */
export interface PendingPlanAmendment {
  id: string;
  /** Why the plan must change — the author's own words, and the whole of the case. */
  note: string;
  author: PlanAmendmentAuthor;
  createdAt: string;
  /** Null when the plan has no revision to compare against. → `proposedPlanDiff` */
  diff: PlanDiff | null;
  /** What applying it would leave standing that its author may not have meant. */
  warnings: string[];
}

/**
 * What `GET /api/proposals/:id/comment-draft` ships: a comment an operator may
 * edit and post when they close a ticket from the plan approval card.
 *
 * A draft and never a default — nothing posts it, and the back-out refuses a close
 * with no words at all. It is a route of its own for {@link PlanHistory}'s reason:
 * it quotes the plan's prose, and it is read when somebody asks for it rather than
 * every poll.
 */
export interface ProposalCommentDraft {
  draft: string;
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
  /**
   * `${labelPrefix}-watch` — the one tag the watch toggle writes and every gate
   * reads. Empty = the gate is off, and everything is worked. There is no second
   * tag: an item without this one is unwatched, which is the whole model.
   */
  watchLabel: string;
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
   * `repoRoot` — the checkout a `claude://code/new` deep link opens the operator's
   * own Claude Code on, so Discuss and the desktop validation control land in the
   * repository the goal is about rather than wherever that client was last.
   *
   * A path on the wire and deliberately so: the browser builds the link, and the
   * server building the whole URL instead would put a fact about Claude Code's
   * deep-link shape in the harness, which is not where it belongs.
   */
  desktopFolder: string;
  /**
   * `localRun.instruction` is set to something, so a start has something to run.
   *
   * The **fact**, not the text: the instruction is several sentences of operator
   * prose that only the session needs, and the cockpit's whole question is whether
   * to offer a start or to say what is missing. It is here rather than on
   * {@link LocalRunView} because a deployment that has never started anything has no
   * run to hang it off, and that is exactly when it matters.
   */
  localRunConfigured: boolean;
  /**
   * `localRun.stopInstruction` is set, so a stop can actually take the environment
   * down rather than only killing the session that started it.
   *
   * Its own flag beside {@link CockpitConfig.localRunConfigured} because the two fail
   * differently and the panel says different things: with no start instruction there
   * is nothing to offer, and with no stop instruction there is a Stop button that
   * works and does less than it looks like it does.
   */
  localRunStopConfigured: boolean;
  /**
   * `localRun.refreshInstruction` is set, so a refresh tells the session the
   * project's own steps as well as what moved. Blank is supported — a hot-reloading
   * dev server needs nothing said — so this only words the control's hint.
   */
  localRunRefreshConfigured: boolean;
  /**
   * `localValidation.browser` is set, so a validating agent can open a page.
   *
   * Its own flag rather than folded into {@link CockpitConfig.localRunConfigured},
   * which stays the gate on the control: a deployment with no browser validates
   * perfectly well through the API and the logs, and hiding the button over it would
   * withhold a feature that works. What this words is the empty state, so an
   * operator who wonders why nothing was clicked knows there was nothing to click
   * with.
   */
  localValidationBrowserConfigured: boolean;
  /**
   * `issueContainerTypes` — the work-item types that hold work rather than being
   * it. Shipped because the backlog draws a container as a *heading* over its
   * children rather than as a row beside them, and that is a decision about the
   * item's type made before any verdict: `pickup.status` cannot answer it, since
   * an unwatched container reports `unwatched` and a container under a gate-off
   * deployment reports something else again. Read the policy, not a symptom.
   */
  containerTypes: string[];
  /**
   * Whether a real tracker is configured to file into — gates "File ticket" on a
   * finding and "File a work item" on unrecorded work, off the same predicate
   * both routes refuse on.
   */
  canFileTickets: boolean;
  /**
   * `issueStateColours` — the operator's colour for each tracker state, as
   * `#rrggbb`. Display only, and shipped rather than guessed at: which of a
   * tracker's dozen state words are worth telling apart is a thing the operator
   * knows and the harness has no reading of. Empty means every chip draws as it
   * did before there were colours. Read through `stateColour`, which folds the
   * key — the tracker's punctuation is not the operator's.
   */
  stateColours: Record<string, string>;
  /**
   * `issueBoardStates` — the tracker's state words in the order the card view draws
   * them as columns. Empty means the cockpit falls back to the state facets' own
   * order, which is the one thing the server must not decide for it: the fallback is
   * a statement about a screen, and an order invented here would be a policy no
   * config file states.
   */
  boardStates: string[];
  /**
   * Whether the provider can write a work item's state — the board's drag, and
   * nothing else, depends on it.
   *
   * A flag rather than left to the cockpit to infer from the provider name, for
   * `canFileTickets`' reason: the one place that decides is the one the route asks.
   * False means no card is draggable and the board says so once, above the columns,
   * rather than every drag failing separately and teaching nothing each time.
   */
  canSetWorkItemState: boolean;
  /**
   * Whether the provider can close a tracker item — the close-out row's **Close
   * the ticket** button, and nothing else, depends on it.
   *
   * Asked of the connector for `canSetWorkItemState`'s reason, and shipped for the
   * same one: `closeIssue` throws where no integration implements it, so a button
   * drawn off the provider's *name* would be a control that fails on exactly the
   * deployments nobody tested. False draws no button, and the row still reads the
   * way it always did — close it in the tracker, and the sweep settles it.
   */
  canCloseIssue: boolean;
  /**
   * Whether the provider can close a **pull request** — the plan sheet's "restart
   * this part", and nothing else, depends on it.
   *
   * Asked of the connector for `canCloseIssue`'s reason, and shipped for the same
   * one: `closePr` throws where no integration implements it, and a restart that
   * could not close the pull request would take the part back to `ready` only for
   * the reconciler to read the still-open PR and put it back into review — having
   * deleted its branch on the way. False draws no control, the way the board draws
   * no drag where `canSetWorkItemState` is false.
   * → `docs/spec/08-planning.md#restarting-a-part`
   */
  canClosePr: boolean;
  /**
   * Whether the provider can hang one work item off another — the parent half of a
   * placement, which is what the missing-parent warning offers to fix.
   *
   * Asked of the connector for `canSetWorkItemState`'s reason, and shipped for the
   * same one. It is deliberately **not** {@link featureBoard}: that field is the
   * conjunction with the operator's own flag, and the flag is about wanting the
   * tier above one's stories drawn as a *tab*. Gating the warning on it meant an
   * operator who had never asked for that tab was never told which of their goals
   * roll up to nothing — a different question, and one whose answer their tracker
   * could take (issue #683). Where this is false the warning would be a dead end
   * and is drawn nowhere, which is the half of the old conjunction that carried the
   * argument.
   */
  canPlaceWorkItem: boolean;
  /**
   * Whether this deployment has a feature board — the operator's `featureBoard`
   * flag **and** a provider with a container hierarchy to roll up.
   *
   * The conjunction rather than the flag, and shipped rather than left to the
   * cockpit to work out, for `canSetWorkItemState`'s reason: the one place that
   * decides is the one the route asks — `featureBoardOn` in
   * `src/server/routes/features.ts`, read by that route's refusal and by this
   * field. False draws no tab at all, which is what keeps a stale `?tab=features`
   * URL from landing on a page whose every fetch 404s.
   */
  featureBoard: boolean;
  /**
   * The project's area nodes, as the harness last read them from the tracker —
   * what the cockpit offers when the operator answers a placement question with a
   * value of their own.
   *
   * Shipped rather than left to the browser to guess, for the reason the appraiser
   * is offered them rather than free-typing one: an area path has to match a node
   * exactly, and a plausible near-miss is refused by the provider and visibly
   * wrong to nobody until then. Empty for a tracker with no such tree, and then
   * the whole question is absent.
   */
  areaPaths: string[];
  /**
   * The state words the three work-item rules act on, so a column header can say
   * what dropping there disturbs.
   *
   * `pickup` is the **effective** set (`effectivePickupStates`), which is what makes
   * this a quotation of the dispatcher's gate rather than a second opinion about it:
   * `issueInProgressState` is folded in there and deliberately not listed in
   * `issuePickupStates`, so a board built from the raw key would warn that dropping
   * onto the state work is *in* stops the fleet. `returnsTo` is where
   * `work-item-back-to-pickup` sends an item — the first configured pickup state,
   * read the way that rule reads it.
   *
   * Null when `issuePickupStates` is unset, because all three rules are switched out
   * entirely by the registry's `workItemStates` condition then: there is nothing a
   * drop can disturb, and an object of nulls would invite the board to imply there is.
   */
  stateRules: { pickup: string[]; inProgress: string | null; inReview: string | null; returnsTo: string | null } | null;
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
 * The named groups `/api/state` can be asked for, and the units a `dirty` frame
 * invalidates.
 *
 * A **partition** of `CockpitState`, not a menu: every key of the wire type
 * belongs to exactly one of these, and `refUrls`, which belongs to all of them,
 * rides every response. `test/stateSections.test.ts` holds that against the type,
 * so a key added to the wire and to no section is a failing test rather than a
 * field that silently stops being shipped.
 *
 * The lines are drawn by **what invalidates them**, never by what draws them: a
 * section is worth having exactly when some frequent signal touches it and leaves
 * the rest alone. `fleet` and `goals` are the pair that matters — an agent's usage
 * report, its progress note and every file it writes are all `fleet`, and none of
 * them can change a goal's pickup verdict.
 */
export type StateSection = 'harness' | 'control' | 'goals' | 'plans' | 'fleet' | 'queue' | 'inbox' | 'activity';

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
   * Where the running build stands against its own upstream, and how far along a
   * deliberate upgrade of it is — the `Build` gauge in the top bar and the panel
   * it opens. The repo it describes is the one LubbDubb is *installed* in, never
   * the one the fleet is working on.
   */
  build: BuildReading;
  /**
   * Runs whose issue the world has forgotten (issues #203, #234) — rebuilt from
   * the run's own snapshot and enriched through the same path as a live issue, so
   * a retained card and a live one cannot disagree. The same list the dispatcher
   * unions into its issue view, which is what makes a goal drawn here one the
   * harness can still act on.
   */
  retainedRuns: Issue[];
  /**
   * Every pull request the world has ever reported closed, as it was last read.
   *
   * `world.closedPullRequests` is a **window** — `closedPrWindowMs` wide — so the
   * goal page's closed rows drawn off it alone disappeared a few hours after the
   * work merged, and the page of a goal delivered last month said no pull request
   * had ever named it. These rows are the same pull requests kept past the window,
   * out of `pr_archive`.
   *
   * **Stale by construction, and only ever drawn.** Nothing re-fetches an archived
   * pull request and no rule reads this list; the folds the open list carries
   * (`health`, `attention`, `ciVerdict`) are absent here for the reason they are
   * absent on `world.closedPullRequests` — nothing acts on a dead pull request, so
   * nothing folds a verdict for one.
   *
   * Beside `world` rather than inside it: the world is one instant as the connector
   * reported it, and an all-time list folded into it would make every reader that
   * takes `closedPullRequests` for "recently" wrong at once.
   * → `docs/spec/14-persistence.md#the-closed-pull-request-archive`
   */
  archivedPullRequests: PullRequest[];
  /** The multi-PR plan graph: one plan per planned issue, and every plan's parts. */
  plans: Plan[];
  /**
   * The vivarium (`docs/spec/22-pets.md`), or **null** when `pets.enabled` is off
   * or `pets.visible` is — which is what the cockpit reads to draw nothing at all,
   * rather than an empty enclosure that looks like a deployment nobody has used.
   * The two spell one null on purpose: nothing the cockpit draws differs between
   * a feature that is off and one that is merely out of sight.
   *
   * Rides on the snapshot rather than a route of its own so the corner of the rail
   * updates on the same socket as the queue above it.
   */
  pets: PetState | null;
  /**
   * The machine's one dev environment (`docs/spec/23-local-runs.md`), or **null**
   * when nothing has ever been started — which the cockpit draws as a quiet
   * indicator rather than as nothing, because "no environment is up" is the reading
   * an operator opens this to get.
   *
   * The **last** run rides here once it has ended, not only a live one: a start that
   * failed is the case somebody actually hits, and its reason has to be somewhere to
   * read after the process is gone.
   *
   * On the snapshot rather than a route of its own for `pets`' reason — the
   * indicator sits in the same reads row as the rest and updates on the same socket.
   */
  localRun: LocalRunView | null;
  /**
   * What the local run could be pointed at, one entry per goal in the world.
   *
   * Beside {@link CockpitState.localRun} rather than inside it, because it describes
   * what is *not* running: the panel draws it whether an environment is up or not,
   * and it stands when `localRun` is null.
   */
  localRunTargets: LocalRunTargetView[];
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
   * Every goal's post-deploy watch — what its plan declared a running system would
   * have to show, and what the dry run read against each check.
   *
   * Keyed to a goal by `originRef`, the way the validation checks are, because a
   * watch belongs to the goal rather than to any one plan of it.
   *
   * Absent (rather than empty) on a deployment where no environment declares
   * telemetry, and the cockpit draws nothing for it: null is not clean, so a goal
   * that declared no checks must render as no surface rather than as an empty one.
   */
  goalWatches: GoalWatch[];
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
   * Where each goal's landed work has got to, one entry per goal that has landed
   * anything or has a merge nothing could attribute. Empty whenever no environment
   * is configured, which is what the cockpit reads to draw no environment row at
   * all — rather than a row of question marks on a deployment that never asked for
   * one. → `docs/spec/24-environments.md#the-lens`
   */
  environmentReach: GoalReachView[];
  /**
   * What each environment's own health check last said, in the operator's own
   * order — one entry per environment that declares a `health` command.
   *
   * Empty where none does, which is what the cockpit reads to draw no health
   * surface at all rather than a row of question marks on a deployment that never
   * asked for one. An environment whose `health` has since been removed keeps its
   * stored row and is dropped here: the configuration is what says whether the
   * question is still being asked. → `docs/spec/24-environments.md#is-the-environment-well`
   */
  environmentHealth: EnvironmentHealthReading[];
  /**
   * Every open or settled post-deploy watch, one entry per `(goal, environment)`.
   *
   * Empty whenever no environment declares a `watch`, which is what the cockpit
   * reads to draw no watch surface at all — not an empty card, not a row of
   * question marks. A goal that declared no checks has no entry here either, for
   * the same reason: null is not clean.
   * → `docs/spec/29-post-deploy-watch.md#in-the-cockpit`
   */
  goalWatchWindows: GoalWatchView[];
  /**
   * The goals whose whole work has arrived somewhere, newest first — the
   * environments half of the Activity feed, capped like every other feed on this
   * surface.
   *
   * **Not a {@link WorldEvent}, deliberately.** Those are derived by diffing
   * consecutive world snapshots, and a delivered goal's standing hold is expired
   * by *any* world event on its issue ref (`deliveryHold`) — so an arrival written
   * as one would lift the delivery park on the goal it announced and hand the work
   * straight back to the fleet to do again. Its own list has no such reader.
   * → `docs/spec/24-environments.md#in-the-cockpit`
   */
  environmentArrivals: GoalArrival[];
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
  /**
   * The tasks {@link agents} were dispatched on, newest first — **without
   * prompts**, and **only those**.
   *
   * {@link TaskSummary}, not `Task`, and that is the whole point: a rendered
   * agent prompt is kilobytes, no cockpit surface reads one, and on a real
   * deployment they were 17.4 MB of this payload's 24 MB — built, serialised,
   * transferred and parsed on every refresh, then discarded. No route ships a
   * task's prompt, because no surface asks for one; adding a surface that does
   * means adding a per-row route beside `/api/agents/:id/transcript`, never
   * widening this back to `Task`. → `docs/spec/16-http-api.md#bulk-text`
   *
   * Narrowed to the shipped agents rather than capped on its own, because every
   * cockpit read of a task starts from an agent — `taskFor(agent)`,
   * `agentOnBranch`, `agentOnGoal`, the needs-you rows. A task row with no agent
   * to reach it from is a row nothing can draw.
   * → `docs/spec/16-http-api.md#bulk-collections`
   */
  tasks: TaskSummary[];
  /** Operator-launched jobs, newest first — the queue and its recent history. */
  jobs: Job[];
  /**
   * Recurring briefs, oldest first — every one the operator has written,
   * enabled or not. What a firing produces is an ordinary entry in {@link jobs},
   * so the queue above is where a recurrence becomes visible as work.
   */
  schedules: JobSchedule[];
  /**
   * Every agent still out, and the tail of the ones that have ended — newest
   * first.
   *
   * **Not the all-time list.** `agents` was one of the two collections here with
   * no cap on it, over a table nothing deletes from, re-serialised on every
   * `dirty` — so what it cost grew for the life of the deployment. The bound is
   * on history only: a live agent is always here whatever the fleet has been
   * doing, because the console's fleet card must never be a sample of what is
   * running. → `docs/spec/16-http-api.md#bulk-collections`
   *
   * A goal's whole run history is `GET /api/issues/:number/agents`, fetched when
   * its page opens — the same shape as the transcript and the files list.
   */
  agents: Agent[];
  /**
   * How many agents have ended in all — including the ones older than the tail
   * above.
   *
   * Shipped as a count so the fleet card's "N shifts ended" answers how many
   * there have been rather than how many travelled: read off `agents.length` it
   * would report the cap forever on a deployment that had run twenty thousand,
   * and nothing about the number would look wrong.
   */
  endedAgents: number;
  /**
   * Actions the executor is working on that have not become agents yet — a
   * dispatch waiting on the worktree pool to hand a slot over, an outbound act
   * waiting on the authorization read.
   *
   * On the fleet section because the fleet card is where it is drawn and because
   * it moves on the fleet's clock, but it is **not** part of any fleet count: the
   * cap counts agents, and these are not agents. Empty on every snapshot taken
   * between cycles, which is nearly all of them — the list is non-empty only while
   * `ActionExecutor.execute` is inside an await.
   *
   * In-memory server-side and shipped whole rather than as a count, because the
   * reading an operator opens the card for is *which* work is being readied and
   * for how long. → `docs/spec/09-execution.md#what-is-being-readied`
   */
  readying: ReadyingAction[];
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
  /**
   * The agents parked on an *unannounced stop* — they ended a turn saying neither
   * "done" nor what they needed, were nudged, and did not settle it — each with the
   * moment its park expires and the harness records it done itself.
   *
   * A list of pairs for `parkedOnLimit`'s reason and one more: the park is a fact
   * about the fleet this process is holding, dropped by a restart, and it is drawn
   * as a countdown, which needs the end as well as the fact.
   */
  stallParks: StallPark[];
  /** Artifacts agents surfaced mid-run, grouped by agentId in the UI. */
  flags: AgentFlag[];
  /**
   * Flag id → the URL to open that artifact by navigation, carrying its per-flag
   * capability. An http(s) flag is absent here — the cockpit links those directly.
   */
  artifactUrls: Record<string, string>;
  /**
   * Images an operator attached to a brief (issue #249), every ref in one
   * list. The cockpit filters by `targetRef`: `job:<id>` while the brief is
   * queued, `issue:<n>` once it has been filed as a ticket.
   *
   * The domain type, `path` and all — the same absolute-paths-are-shipped stance
   * `AgentFile` and `Agent.cwd` already take, and it is what lets the operator
   * match a thumbnail against the path their agent was told to read.
   */
  attachments: JobAttachment[];
  /** Attachment id → the URL to load its bytes from, carrying its capability. */
  attachmentUrls: Record<string, string>;
  /** Paths two concurrently-running agents both wrote (issue #113). */
  overlaps: FileOverlap[];
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
  /**
   * The escalations still waiting on a person, newest first — **open only**.
   *
   * Not the all-time list: every surface that reads this filters to `open`, and
   * each row carries a transcript tail in `context.recentOutput`, so shipping
   * the settled ones was half a megabyte a refresh spent on rows nothing draws.
   * A settled escalation is still reachable one at a time on the server; it is
   * not something the cockpit asks for. → `docs/spec/16-http-api.md#bulk-text`
   */
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
  /**
   * Whether there is work left for the fleet, and whether the reason there is not
   * is upstream of it — the band under Fleet.
   *
   * A domain type shipped whole rather than a widened copy: the pulse's desk and
   * this take the same reading through the same function, and a wire shape that
   * dropped a field would let the card and the bench row describe one fleet
   * differently. Never null — an empty card still draws, and `unknown` is the
   * reading for a deployment with no history rather than an absence.
   */
  runway: RunwayReading;
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
/**
 * One goal's standing across every configured environment, in the order the
 * operator declared them.
 *
 * Keyed on the goal ref rather than joined onto {@link Issue}, because the goals
 * with landings and the goals in the world are different sets: work lands, its
 * ticket closes, and the tracker stops listing it long before the release carrying
 * it reaches production. Folded into the issue, a goal's environment row would
 * vanish at exactly the point somebody wants to know where it went.
 */
export interface GoalReachView {
  /** The goal, as `issue:<n>`. */
  goalRef: string;
  environments: GoalEnvironmentReach[];
  /**
   * Why this goal's `validate` and `close_out` rows are being withheld, or null
   * when nothing is withholding them.
   *
   * Non-null **only for a goal that is delivered and gated right now**, so the
   * cockpit can read it as "the harness is waiting, and here is what for" without
   * re-deriving a verdict the server already made. A hold is otherwise the
   * quietest thing here: nothing is filed, so a delivered goal with an empty
   * bench looks exactly like a finished one.
   * → `docs/spec/24-environments.md#what-an-arrival-means`
   */
  gateHold: string | null;
  /** The operator's "this one is not waiting on an environment", when they have said so. */
  released: EnvironmentGateRelease | null;
}

/**
 * One goal's post-deploy watch in one environment: the window an arrival opened,
 * and what each declared check last said inside it.
 *
 * Beside {@link GoalReachView} and keyed the same way, because it is the layer
 * above the same question — reach says the work is *there*, this says what the
 * running system has done since. Shipped as its own list rather than folded into
 * the reach row so the two cannot disagree about which environment a reading came
 * from: the card draws this inside the reach row it names.
 *
 * **Not a {@link WorldEvent}, deliberately**, for the reason {@link GoalArrival}
 * is not: `deliveryHold` expires a standing delivery verdict on any world event
 * matching the goal's issue ref, so a reading written as one would un-park the
 * goal it just reported on. → `docs/spec/29-post-deploy-watch.md#a-reading-is-never-a-worldevent`
 */
export interface GoalWatchView extends WatchWindow {
  /** Every check the goal declared, in document order — drawn whether or not anything is wrong. */
  checks: GoalWatchCheckView[];
}

/** One declared check as the goal page draws it: what it asked for, and what it last read. */
export interface GoalWatchCheckView {
  /** The author's own slug, and the merge key its declaration is folded on. */
  checkId: string;
  title: string;
  /**
   * Which question this check asks, because the card phrases the two differently:
   * a signal's expectation is a row count, and a measure's is a number against a
   * threshold or against what the same query read before the work arrived.
   */
  kind: GoalWatchKind;
  /** The count the check declared it must not exceed. Read for a signal only. */
  tolerate: number;
  /** A measure's ceiling, floor, and whether it declared `noWorseThan: "baseline"`. */
  expectUnder: number | null;
  expectOver: number | null;
  expectBaseline: boolean;
  /** What the number is in, drawn beside it. */
  unit: string | null;
  /**
   * A measure's **before** — what its query read at declaration, or null where no
   * baseline was ever taken.
   *
   * Carried so the card can draw expected / before / now, which is what makes it
   * worth looking at: a p95 of 310ms means nothing alone and everything beside the
   * 8,400ms it replaced. Null is *never taken*, which the fold already reads as
   * `unknown` rather than as a comparison that passed.
   */
  baselineValue: number | null;
  /**
   * The newest reading, or **null while the window has not been read yet**.
   *
   * Null is a third fact and not a synonym for clean, exactly as a check nothing
   * has put to an environment is not a check that passed.
   */
  reading: WatchReading | null;
}

/**
 * One agent's transcript, or the tail of it — `GET /api/agents/:id/transcript`.
 *
 * **Ranged, because the drawer polls it.** The socket carries an agent's output
 * the moment it happens, but only for what it produced *since the drawer opened*
 * — so a run already deep into its transcript has nothing on the wire that can be
 * appended to the copy the cockpit fetched, and the pane sat frozen at its seed
 * for as long as it was watched (issue #639). The fix is the drawer re-reading
 * this every few seconds, and re-reading it whole would ship the entire
 * transcript per poll — megabytes on a long run, per open drawer.
 *
 * `from` is the caller's count of the characters it already holds, echoed back
 * **clamped to `total`** so a client that asks past the end learns where the end
 * is rather than guessing. `transcript` is the slice from there on, so a poll on
 * a quiet run costs an empty string.
 */
export interface AgentTranscript {
  agentId: string;
  /** Where {@link transcript} starts — the requested offset, clamped to {@link total}. */
  from: number;
  /** The whole transcript's length in characters, whatever slice was asked for. */
  total: number;
  /** Everything from {@link from} to the end. */
  transcript: string;
}

/**
 * The files one agent wrote, for the drawer's "files changed" list.
 *
 * Its own route, fetched when a drawer opens, for the reason the transcript above
 * is: the rows are bulk text about **one** agent, and the whole-fleet list they
 * used to ride on was 87% of the state snapshot — every file every agent ever
 * wrote, built, serialised and parsed on every refresh so that one open drawer
 * could read one agent's slice of it. → `docs/spec/16-http-api.md#bulk-text`
 */
export interface AgentFilesPayload {
  agentId: string;
  files: AgentFile[];
}

/**
 * Every agent that has worked one goal, and the tasks they were dispatched on.
 *
 * Its own route, fetched when a goal page opens, for the transcript's and the
 * files list's reason: the goal page is the one surface that draws a goal's whole
 * run history, and the snapshot's `agents` list is bounded to the fleet's recent
 * tail. Reading it off the snapshot instead would mean shipping every agent the
 * deployment has ever run, on every refresh, so that one open page could take one
 * goal's slice. → `docs/spec/16-http-api.md#bulk-collections`
 *
 * `tasks` is here rather than left to the snapshot for the same reason the agents
 * are: the row draws its task's title, and a title looked up in a bounded list
 * would go blank on exactly the old runs this route exists to show.
 */
export interface GoalAgentsPayload {
  /** The goal, as `issue:<n>` — echoed so a late response cannot land on another page. */
  ref: string;
  agents: Agent[];
  tasks: TaskSummary[];
}

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
export type TicketWatchFilter = 'any' | 'watched' | 'unwatched';
/**
 * What the *harness* is doing about an item, which is not the same question as
 * what the tracker calls it.
 *
 * `frozen` is an item that has left the tracker's open set: the mirror keeps every
 * field it last saw and stops enriching it from the world. Two axes rather than
 * one, because a provider with native states closes an item several ways —
 * `Closed` and `Removed` are both frozen and are not the same fact — and one
 * control folding them would state a triage nobody made.
 */
export type TicketTrackingFilter = 'any' | 'live' | 'frozen';
/**
 * The tracker's own word, free-form because it is the tracker's: `any`, or a
 * provider-native state exactly as the provider spells it. Never a hardcoded
 * ladder — the first customised Azure process template would put items in a state
 * no filter could reach, and nothing would say so.
 */
export type TicketStateFilter = string;
/** By tracker id descending (arrival order), by last change, or by what the fleet spent under it. */
export type TicketOrder = 'added' | 'changed' | 'cost';

/** One state the mirror has actually seen, and how many rows carry it. */
export interface TicketStateFacet {
  state: string;
  count: number;
  /**
   * How many of those rows are still live — **zero** for a state every one of
   * whose items has left the tracker's open set, which on a provider with native
   * states is every closing state it has.
   *
   * Beside `count` because the two filter axes are near-disjoint there: `Closed`
   * is a real state the mirror holds and it appears on no live row, so a pick of
   * it under the `live` narrowing would return nothing. The cockpit reads this to
   * widen the tracking axis on exactly those picks rather than drawing a control
   * that answers empty. → `docs/spec/17-cockpit.md#three-axes-because-they-are-three-questions`
   */
  live: number;
  /** True where `pickupStates` lets this state through — config, not a guess. */
  pickup: boolean;
}

/**
 * One feature the mirror's rows hang off, for the legend that is also the filter.
 *
 * `slot` is an index into the cockpit's fixed hue ladder, not a colour: the palette
 * belongs to the stylesheet, and a hex here would be a second opinion about it that
 * no theme could reach.
 */
export interface TicketFeatureFacet {
  number: number;
  title: string;
  slot: number;
  count: number;
}

/** One row of the Tickets tab. */
export interface TicketRow {
  number: number;
  title: string;
  state: IssueState;
  /** Two-valued: an item is watched only if it carries the tag. → `src/watchLabels.ts` */
  watch: TicketWatchFilter & ('watched' | 'unwatched');
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
  /**
   * `frozen` says the item has left the tracker's open set and the mirror has
   * stopped enriching it. The row's controls are inert on a frozen row: there is
   * nothing in the tracker left to tag.
   */
  tracking: 'live' | 'frozen';
  /** The provider's own state word, or null where the provider has none. */
  workItemState: string | null;
  /** `Feature` / `Task` / …, or null on a flat tracker. */
  issueType: string | null;
  /**
   * The feature this hangs off. Three values, and the third is why the key is
   * optional rather than merely nullable: **absent** means the link was never
   * resolved (no hierarchy, or a read that failed), where `null` means the tracker
   * says there is no parent. Collapsing them would tell a reader an item belongs to
   * no feature when the truth is that we could not tell.
   */
  parent?: { number: number; title: string } | null;
  /** The parent's hue slot, so a row can be drawn in its feature's colour. */
  featureSlot: number | null;
}

/**
 * `GET /api/issues/filing-target` — whether a report about LubbDubb can be filed
 * right now, where it would land, and as whom (issues #413, #449).
 *
 * A **union rather than four independent fields**, because the two readings are
 * not the same row with blanks in it: an available target always names itself and
 * an unavailable one always says why, and a shape that allowed
 * `{available: true, target: null}` would leave the compose modal free to draw a
 * head naming nowhere.
 *
 * Never on `/api/state`: it costs a round trip to the `gh` CLI, and the only reader
 * is a modal that opens rarely.
 *
 * `available: false` is an ordinary **200**, not a 5xx: "the CLI is logged out" is
 * an answer to the question that was asked, and a status code would make it look
 * like the probe itself broke.
 */
export type FilingTargetProbe =
  | ({
      available: true;
      reason: null;
      /**
       * Whether offering the watch label would mean anything — true only where this
       * fleet works LubbDubb's own repo (issue #449).
       *
       * The label is what makes a fleet pick an issue up, and a fleet only sweeps
       * the tracker it is configured for. On every other deployment the report lands
       * somewhere its own agents never look, so the checkbox is not drawn rather
       * than drawn and inert.
       */
      watchable: boolean;
    } & FilingTarget)
  | {
      available: false;
      target: null;
      identity: null;
      /** Plain prose for the modal to show — the CLI's own message, or the gate that refused. */
      reason: string;
    };

/**
 * `POST /api/issues` — the report that was just filed on LubbDubb's own tracker
 * (issues #413, #449).
 *
 * A **URL and not a `ref`**, unlike every other filing on this wire. `issue:314`
 * is the harness's vocabulary for an item in the tracker *the fleet is pointed at*,
 * and the cockpit resolves it against that tracker — so a ref here would draw a
 * link to whichever issue of the customer's repo happened to share the number. The
 * one destination the cockpit cannot name from config is the one this route files
 * into, so the route hands over the address itself.
 */
export interface IssueFiled {
  ok: true;
  /** The new issue's number in LubbDubb's repo — what the modal shows as `#449`. */
  number: number;
  url: string;
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
   * How many of the mirror's rows are still live. Beside `kept` rather than
   * instead of it: a work surface's population and the size of the history it sits
   * on are different numbers, and one shown as the other would report a history
   * that shrinks every time an item closes.
   */
  live: number;
  /**
   * The states the mirror has actually seen, with counts — **empty** for a
   * provider with no native states, which is what tells the cockpit not to draw the
   * second filter tier at all. A control offering states the provider cannot
   * produce is one that always returns nothing.
   */
  states: TicketStateFacet[];
  /**
   * The features the filtered set hangs off, for the legend. Ordered by count so
   * the ladder's colours land on the features a reader actually sees.
   */
  features: TicketFeatureFacet[];
  /** How many rows have no parent at all — the legend's "no feature" bucket. */
  orphanCount: number;
  /**
   * Reference → web URL, resolved off the connector rather than read from the
   * snapshot's map: `buildRefUrls` is built from the world, and most rows here
   * have long left it.
   */
  refUrls: Record<string, string>;
}

// ---------------------------------------------------------------------------
// `/api/features` — the feature board
// ---------------------------------------------------------------------------

/**
 * How one of a Feature's children stands, folded from the verdicts the harness
 * already holds.
 *
 * Six words rather than a done/not-done pair, because the four that are not
 * "delivered" answer different questions and a reader acts on each differently:
 *
 * - `unwatched` is the one that is not a delay at all. The item carries no watch
 *   tag, so no agent has ever read it, nothing was appraised and nothing was
 *   spent — it is **unseen**, not late, and it wins over every other reading
 *   precisely because a board that drew it as `queued` would report a fleet
 *   working on something it cannot see. → `docs/spec/06-issue-pickup.md`
 * - `inFlight` is a run the harness minted and has not finished. It outranks the
 *   outcome words below it because a re-picked goal carries the verdict of its
 *   *last* attempt while an agent is working its next one, and the board is a
 *   reading of now.
 * - `fellShort` is an assessor's "this was worked and the goal is still not
 *   reached" — a decision waiting on somebody, and never the same fact as queued.
 * - `settled` is `concluded` or `abandoned`: finished, with nobody having
 *   declared it delivered. Folded into `delivered` it would overstate the
 *   Feature; folded into `queued` it would understate it for ever.
 */
export type FeatureChildStanding = 'delivered' | 'inFlight' | 'queued' | 'fellShort' | 'settled' | 'unwatched';

/** One of a Feature's children, as the board draws its row. */
export interface FeatureChildRow {
  number: number;
  title: string;
  /** `User Story` / `Bug` / … — the tracker's own word, null where it has none. */
  issueType: string | null;
  standing: FeatureChildStanding;
  /**
   * The harness's own outcome word (`ticketOutcomes`), or null where it never
   * reached a verdict. Beside `standing` rather than folded into it: `standing`
   * says where the item is now, and this says what was concluded — a re-picked
   * goal is `inFlight` and still carries `fell short`.
   */
  outcome: string | null;
  /** The provider's own state word, or null where the provider has none. */
  workItemState: string | null;
  /** Dollars spent under this goal, or **null** where the fleet never ran on it. */
  costUsd: number | null;
  changedAt: string;
}

/** How many of a Feature's children stand each way. */
export interface FeatureCounts {
  delivered: number;
  inFlight: number;
  queued: number;
  fellShort: number;
  settled: number;
  unwatched: number;
  /** Every child counted above — the denominator the board's bar is drawn against. */
  total: number;
}

/**
 * Where a Feature's work has got to in one environment, folded across its goals.
 *
 * The fold is `rollUpReach`, the **same function** a goal's own landings are
 * folded with (`src/environments/reach.ts`) — a Feature is to its goals what a
 * goal is to its landings. That is what keeps `unknown` from collapsing into
 * `absent` one tier up, which is the whole reason the verdict is three-valued.
 * → `docs/spec/24-environments.md#the-three-verdicts`
 */
export interface FeatureReach {
  environment: string;
  status: GoalReachStatus;
  /** Children this environment confirmedly holds, out of those with anything landed. */
  goals: number;
  total: number;
}

/** One of a Feature's goals with a run the harness minted and has not finished. */
export interface FeatureWorkingRow {
  number: number;
  title: string;
  /** When that run started — a stamp, drawn as an age and never judged. */
  since: string;
}

/**
 * One goal a delivery verdict stands on, with the sentence its author wrote.
 *
 * The summary is quoted, never paraphrased and never assembled from the counts:
 * it is the one line somebody who read the work committed to, and a board that
 * reworded it would be asserting something nobody said.
 */
export interface FeatureReportRow {
  number: number;
  title: string;
  summary: string;
  /** Who cast it — `assessor`, `planner` or `operator`, the verdict row's own word. */
  by: string;
  at: string;
}

/**
 * Why a blocked goal is blocked, and the two are not the same call.
 *
 * - `question` is an agent parked on an escalation nobody has answered: the fleet
 *   is stopped and the thing it needs is a reply.
 * - `fellShort` is an assessor's verdict that the work did not reach the goal:
 *   nothing is stopped, and what it needs is a decision about what happens next.
 *
 * Folded into one word a reader could not tell "answer me" from "decide", which
 * are the two different things a person is being asked for.
 */
export type FeatureBlockKind = 'question' | 'fellShort';

/** One thing standing between a Feature's work and the next step, in its author's words. */
export interface FeatureBlockRow {
  number: number;
  title: string;
  kind: FeatureBlockKind;
  /** The agent's question, or the assessor's shortfall summary. Quoted. */
  summary: string;
  /** When it was raised — a stamp, drawn as an age and never judged stale. */
  since: string;
}

/**
 * The briefing: what is happening under a Feature, what of it is done, and what
 * is stopping the rest — the three questions somebody outside the fleet asks
 * before they ask anything else.
 *
 * **Every line of it is a quotation.** The working rows are the same `inFlight`
 * reading the bar is drawn from, the done rows carry `IssueDelivery.summary` as
 * its author wrote it, and the blocking rows carry an escalation's prompt or a
 * shortfall's summary. Nothing here is composed, scored or forecast — the board
 * ships no verdict about a Feature ({@link FeatureRollup}), and a briefing that
 * wrote its own sentence would be exactly that verdict wearing an agent's voice.
 *
 * Each list is bounded and says how many it stood for, because a list that simply
 * stopped would read as the whole Feature.
 * → `docs/spec/17-cockpit.md#the-briefing`
 */
export interface FeatureBriefing {
  /** Goals being worked now, newest run first. Bounded by `FEATURE_BRIEFING_ROWS`. */
  working: FeatureWorkingRow[];
  /** How many goals are being worked in all — the same number as `counts.inFlight`. */
  workingTotal: number;
  /**
   * Goals a delivery verdict stands on, newest first. Only `delivered`, never
   * `settled`: a delivery says *this was done and here is what it was*, where a
   * conclusion is an agent closing a goal and asserts nothing about usable work.
   */
  delivered: FeatureReportRow[];
  deliveredTotal: number;
  /** Questions first, then shortfalls; newest first inside each. */
  blocking: FeatureBlockRow[];
  blockingTotal: number;
}

/** One Feature, with its children folded. */
export interface FeatureRollup {
  number: number;
  title: string;
  /** The hue slot, from the same persisted ladder the Tickets tab's legend draws. */
  slot: number;
  /**
   * The Feature's own state word, and its type — **null when the mirror does not
   * hold the container itself**, which is the ordinary case on a tracker whose
   * assignment filter returns only the work. The identity above always resolves
   * (it is the parent link on a child); these two do not, and a blank is the
   * honest reading rather than a guess at the container's state.
   */
  workItemState: string | null;
  issueType: string | null;
  counts: FeatureCounts;
  /**
   * What is happening, what is done and what is blocked, in the words of whoever
   * said it. Above `children` because it is the answer to the question the card
   * is opened with; the rows below it are the evidence.
   */
  briefing: FeatureBriefing;
  children: FeatureChildRow[];
  /**
   * What the fleet has spent across every child, or **null** where it never ran
   * on any of them. Null rather than `0` for {@link TicketRow.costUsd}'s reason:
   * never worked and worked for free are different facts.
   */
  costUsd: number | null;
  /** Empty on a deployment with no environments configured — the whole column is then absent. */
  reach: FeatureReach[];
  /**
   * The account rule `feature-summary` had written of this Feature, or null where
   * none has been written yet — a Feature nobody has been on, or one whose
   * summariser has not landed.
   *
   * **The one thing on this board that is prose**, and it is a quotation like
   * every other reading here: the card draws the agent's four fields as they were
   * submitted, and composes no sentence of its own. The board still ships no
   * verdict about a Feature — this is somebody's account, stamped and attributed,
   * which is a different thing from the harness asserting a status.
   * → `docs/spec/17-cockpit.md#the-feature-summary`
   */
  summary: FeatureSummary | null;
  /**
   * When any of this Feature's goals last landed a commit, or null for one that
   * has landed nothing. A **stamp, never a verdict**: how old is too old is a
   * policy no config file states, so the board draws the age and says nothing
   * about it.
   */
  lastLandingAt: string | null;
}

/**
 * `/api/features` — the feature board (issue #—).
 *
 * **Fetched, never polled**, for the Tickets tab's reason: it reads the whole
 * mirror and the list is all-time.
 *
 * A lens. Nothing here decides anything, every reading it carries is quoted from
 * the module that owns it, and no rule under `src/dispatcher/` reads it.
 * → `docs/spec/17-cockpit.md#the-feature-board`
 */
export interface FeatureBoardPayload {
  /** Ordered by what wants a person first, then by size. See `buildFeatureBoard`. */
  features: FeatureRollup[];
  /**
   * The work the tracker says hangs off no container at all — counted the same
   * way, because a fifth of a fleet's effort answering to no Feature is the one
   * thing a roll-up page must not hide. Null where there is none.
   *
   * There is no summary among them, and the omission is the point rather than a
   * gap: a summary says where a *Feature* has got to, and the orphan bucket is not
   * one — it is every item the tracker says answers to nothing, which share no
   * goal for anybody to have got anywhere with.
   */
  orphans: Omit<
    FeatureRollup,
    'number' | 'title' | 'slot' | 'workItemState' | 'issueType' | 'reach' | 'summary'
  > | null;
  /**
   * Items whose parent link was **never resolved** — no hierarchy, or a read that
   * failed. Neither a Feature's nor an orphan's, and counted separately for the
   * reason {@link TicketRow.parent} is optional rather than nullable: putting them
   * in the orphan bucket would tell a reader the tracker says they have no parent
   * when the truth is that nobody could tell.
   */
  unresolved: number;
  /** The configured environment names, in the operator's own order. Empty turns the column off. */
  environments: string[];
  /** True while the first sweep is still filling the mirror — an empty board versus a broken one. */
  backfilling: boolean;
  /** Reference → web URL, resolved off the connector for the Tickets tab's reason. */
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
 * `GET /api/prs/:number/review-pack` — a pull request's current review pack with
 * what the reviewer did to it: the one shape the cockpit renders and takes marks
 * against. The document is the domain type unchanged, because the cockpit, the
 * companion and the store read one shape and there is one declaration of it
 * (`docs/spec/31-review-packs.md#a-pack-is-data-and-rendering-is-downstream`).
 */
export interface ReviewPackPayload extends ReviewPackRecord {
  /** Every mark on the pull request, keyed to hunks; the renderer draws each on whichever idea owns them. */
  marks: ReviewMark[];
  /**
   * The pull request's head as the harness last saw it, or null for a pull
   * request no longer in the world — where {@link stale} cannot be decided and is
   * left null too, which a reader must not fold into "current".
   */
  head: string | null;
  /**
   * Set when the head has moved past the pack's `headSha`: the pack is shown, not
   * regenerated, and says how far behind it is. `commitsBehind` is what the clone
   * counts between the two, or null where it cannot say — an unfetched head — in
   * which case the pack is stale by sha alone.
   * → `docs/spec/31-review-packs.md#when-a-pack-is-made`
   */
  stale: { headSha: string; commitsBehind: number | null } | null;
  /**
   * Whether the checker is on the pull request right now. A pack whose every
   * verdict is null is either being checked or was left unchecked — a paused
   * fleet, a checker that failed — and a reader must be able to tell which
   * without guessing. → `docs/spec/31-review-packs.md#the-check`
   */
  checking: boolean;
  /**
   * Whether this pack is in the pool, and whether there is a pool to put it in.
   * Sharing is a second, deliberate act — never on the ask, never by default — so
   * the page draws a control of its own from this.
   * → `docs/spec/31-review-packs.md#sharing-a-pack`
   */
  sharing: ReviewPackSharing;
}

/**
 * What has become of one pull request's share, and the answer
 * `POST /api/prs/:number/review-pack/share` gives.
 *
 * `share` is null where nobody has asked — the ordinary state, and the honest
 * one. `available` is false on a deployment with no pool selected or no fleet
 * name: there is nowhere to publish to, which a page must say rather than
 * offering a control that would 409.
 */
export interface ReviewPackSharing {
  available: boolean;
  share: ReviewPackShare | null;
}

/**
 * The 404 `GET /api/prs/:number/review-pack` answers with when there is no pack:
 * `writing` says whether an author is on its way, so "not asked for" and "on its
 * way" read differently on the pull request's row.
 * → `docs/spec/31-review-packs.md#when-a-pack-is-made`
 */
export interface ReviewPackAbsence {
  error: string;
  writing: boolean;
}

/**
 * `POST /api/prs/:number/review-pack/ideas/:id/read` — a reviewer marking an
 * idea read, or unread again. Recorded against the hunks the idea owns, never
 * the idea's id, which the next pack mints afresh.
 * → `docs/spec/31-review-packs.md#what-a-reviewer-does-is-not-part-of-the-pack`
 */
export interface ReviewReadBody {
  read: boolean;
}

/**
 * `POST /api/prs/:number/review-pack/ideas/:id/attention` — a reviewer
 * overriding the checker's label on an idea, or clearing the override with null.
 * Never shown to the checker on a later pack.
 */
export interface ReviewAttentionBody {
  attention: ReviewAttention | null;
}

/**
 * `POST /api/prs/:number/review-pack/ideas/:id/seen` — a reviewer taking the
 * finding on an idea's false claim, or putting it back. The third mark, keyed
 * exactly as the other two are: to the hunks the idea owns, never to its id.
 * → `docs/spec/31-review-packs.md#whether-prominence-works`
 */
export interface ReviewSeenBody {
  seen: boolean;
}

/**
 * What the three mark routes answer with: every mark on the pull request after
 * the write, exactly as the read ships them — so the page re-lays them over the
 * ideas from one shape rather than patching a local copy.
 */
export interface ReviewMarksPayload {
  marks: ReviewMark[];
}

/**
 * `GET /api/review-calibration` — what the packs say about the agents that wrote
 * them: the overrides, the plumbing ratio and whether false claims get read.
 * The Insights page's Review tab, and the only reading that aggregates across
 * packs. Never shown to the checker and never fed back into a prompt.
 * → `docs/spec/31-review-packs.md#the-operators-reading`
 */
export interface ReviewCalibrationPayload {
  calibration: ReviewCalibration;
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
 * `/api/allowance` — the account's usage percentage over time, the agent runs
 * beside it, its apportionment to the goals that spent it, and the weekly
 * burn-down.
 *
 * A route of its own rather than a field on {@link SpendPayload}, for
 * {@link SpendTrendPayload}'s reason: it walks the readings history on top of the
 * same all-time agent walk, and the tab an operator never opens should cost
 * nothing. Fetched on the Allowance tab's first visit for a given window.
 */
export interface AllowancePayload {
  allowance: AllowanceInsights;
  /**
   * Tracker URLs for the goals this window names, resolved off the connector
   * rather than read from the snapshot's map.
   *
   * `refUrls` in `/api/state` is built from the *world*, and a goal that spent
   * inside this window has very often left it — which is exactly the row whose
   * title reads `no longer on the tracker`. Without these the tab draws that
   * goal's number as plain text: a correct-looking row that is a dead end, which
   * is the cockpit's most repeated bug. The `TicketsPayload` and
   * `FeatureBoardPayload` fields of this name exist for the same reason.
   */
  refUrls: Record<string, string>;
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
 * `/api/mcp/usage` — the tool channel as a reading, behind the Insights MCP tab.
 *
 * A route of its own rather than a field on `SpendPayload`, and for the trend's
 * reason rather than the remedies': it folds a table nothing else reads and joins
 * it against every task prompt the window dispatched, which is the one query in
 * the harness that touches the `prompt` column in bulk. An operator who opened
 * Insights to read the phase table should not pay for it.
 */
export interface McpUsagePayload {
  insights: McpInsights;
}

/**
 * `/api/reliability` — what the spending bought: run outcomes all-time, and CI
 * health over the last fortnight. Fetched on open for `SpendPayload`'s reason.
 */
export interface ReliabilityPayload {
  insights: ReliabilityInsights;
  /**
   * Why the fleet came back, over the same fortnight and out of the same usage
   * events — the Causes reading.
   *
   * On this payload rather than a route of its own because it is a section of
   * this panel and shares its window: two fetches for one modal would be two
   * chances for the two halves to describe different fortnights, which is exactly
   * the disagreement the shared `since` in the route exists to prevent.
   */
  remedies: RemedyInsights;
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

/**
 * `/api/config` — the running config, fetched on open for the prompt book's
 * reason and re-fetched after a save.
 *
 * `revision` fingerprints the file the groups were built from and rides back on
 * the save: a form whose baseline has moved (an editor, or Claude, wrote the file
 * meanwhile) is refused rather than allowed to clobber it. `pending` is what has
 * reached the file and is waiting for a restart — the same list a hand edit
 * produces, because both go through one apply path.
 */
/**
 * `GET /api/setup` — what the harness can say about its own configuration without
 * being asked anything, plus the two prefills the first screen opens with.
 *
 * A reading rather than a verdict: none of it gates anything, because the harness
 * running on the shipped mock is a supported posture and not a broken one. The
 * cockpit decides how loudly to draw it. → `docs/spec/26-setup.md`
 */
export type SetupPayload = SetupReading;

/**
 * `POST /api/setup/resolve` — the two answers, read into everything they imply.
 *
 * Read-only despite the verb: it takes a body, and it writes nothing. The keys it
 * derives are handed to `POST /api/config/preview` and `POST /api/config` like any
 * other edit, so there is exactly one path that writes `lubbdubb.config.json`.
 */
export type SetupResolvePayload = SetupResolution;

/** Re-exported so the cockpit names one module for the whole setup contract. */
export type { SetupCheck, SetupFix, SetupVerdict } from './setup/reading.js';
export type { RemoteTarget } from './setup/remote.js';

export interface RunningConfigPayload {
  groups: RunningConfigGroup[];
  /** Absolute path of the file a save writes — the operator's own. */
  file: string;
  /**
   * Absolute path of the targeted project's shared config, or null when that
   * repository carries none.
   *
   * A save never writes here: this file belongs to the team and is changed by
   * committing to the project. It is on the payload so a cockpit showing a value
   * an operator did not choose can name the file that did.
   */
  projectFile: string | null;
  /** The file's current text, for the raw editor and the review diff. */
  text: string;
  revision: string;
  pending: readonly ConfigChange[];
  /** Whether this process can restart itself — false when no supervisor launched it. */
  canRestart: boolean;
}

/**
 * `POST /api/config/preview` — the same ladder a save walks, stopping short of the
 * write: the bytes that would be written, and what applying them would do.
 *
 * The review step draws its diff from `text` rather than computing the candidate
 * in the browser, which is what lets it promise anything about the file: the
 * splice that preserves comments and key order is server code, and a second
 * implementation of it in the cockpit would be free to disagree with the one that
 * actually writes.
 */
export interface ConfigPreviewPayload {
  ok: true;
  text: string;
  changes: readonly ConfigChange[];
}

/** `POST /api/config` — what a save answers with, so the form can settle without a refetch. */
export interface ConfigSavePayload {
  ok: true;
  revision: string;
  /** Every change the save made, each saying whether it took effect or is waiting. */
  changes: readonly ConfigChange[];
  pending: readonly ConfigChange[];
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
  EnvironmentGate,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  EnvironmentHealthState,
  EnvironmentHealthTier,
  ErrorLogEntry,
  Escalation,
  GoalArrival,
  GoalEnvironmentReach,
  GoalReachStatus,
  HumanTask,
  IssueRelative,
  IssueSpend,
  Job,
  JobAttachment,
  JobAttachmentInput,
  JobSchedule,
  Obstacle,
  LocalValidation,
  LocalValidationFinding,
  LocalValidationStatus,
  ObstacleKey,
  ObstacleSighting,
  ObstacleStanding,
  ObstacleState,
  Plan,
  PlanAmendmentAuthor,
  PlanCaveat,
  PlanEvidence,
  PlanNarrative,
  PlanPart,
  PlanPartInput,
  PlanRevision,
  PrReviewThread,
  PrThreadMessage,
  PrThreadState,
  Pet,
  PetActionKind,
  PetFlaw,
  PetRarity,
  PetSpecies,
  PetStage,
  PetWallet,
  FeatureSummary,
  Proposal,
  ReadyingAction,
  ReadyingStep,
  Retrospective,
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewFinding,
  ReviewIdea,
  ReviewMark,
  ReviewNote,
  ReviewPack,
  ReviewPackShare,
  ReviewRange,
  ReviewVerdict,
  ScratchEntry,
  GoalWatch,
  GoalWatchDeclaration,
  GoalWatchInput,
  GoalWatchKind,
  GoalWatchProposal,
  StackLanding,
  StallPark,
  TaskSummary,
  ValidationCheck,
  ValidationCheckState,
  ValidationResource,
  ValidationResourceKind,
  ValidationVerdict,
  ViewerAssignment,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchWindow,
  WorkNode,
  WorldEvent,
  WorldEventKind,
} from './types.js';
export type { RecoveryVerdict, OrphanedWork } from './agents/crashRecovery.js';
export type { BuildReading, UpgradeAction } from './selfUpdate/upgradePlan.js';
export type { BuildStanding } from './selfUpdate/buildStanding.js';
export type { CiPolicyDescription, CiRuleDescription, PolicyKindDescription } from './ci/describeCiPolicy.js';
export type { QueueItem } from './dispatcher/dispatcher.js';
export type { DispatchRule } from './dispatcher/rules.js';
export type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
export type { FileOverlap } from './fileOverlap.js';
export type { UnrecordedWork } from './graph/unrecorded.js';
export type { RunningConfigGroup } from './server/runningConfig.js';
export type { RunningConfigEntry } from './server/runningConfig.js';
export type { ConfigChange } from './configApply.js';
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
export type {
  ReviewCalibration,
  ReviewOverridePair,
  ReviewOverrideReading,
  ReviewPlumbingPack,
  ReviewPlumbingReading,
  ReviewProminenceReading,
} from './reviewPacks/calibration.js';
export type { RemedyCauseTotal, RemedyInsights, RemedyKindHealth, RemedyRow } from './remedyInsights.js';
export type { RemedyCause, RemedyGuard, RemedyKind } from './types.js';
export type { McpChannel } from './types.js';
/**
 * One CI check as its provider names it. On the wire because the cockpit's checks
 * mark draws the list `ciStatus` folds — a re-export rather than a re-declaration,
 * so the chip names exactly what the policy matched.
 * → `docs/spec/17-cockpit.md#the-checks-mark`
 */
export type { CiCheck } from './types.js';
/**
 * One unanswered review thread as the provider reported it. On the wire because
 * the cockpit's comments mark quotes whose question is outstanding — a re-export
 * rather than a re-declaration, so the mark names exactly what the rules read.
 * → `docs/spec/17-cockpit.md#the-comments-mark`
 */
export type { PrComment } from './types.js';
// The pool's own shapes. A wire type either **is** a domain type or `extends` it,
// so these are re-exports rather than re-declarations — the cockpit reads exactly
// what the store holds. → `docs/spec/28-cross-fleet-pool.md`
export type { PoolClockKind, PoolDigestRow, PoolFleetReading, PoolPublication } from './types.js';
export type { PoolStatus } from './pool/poolDesk.js';
/** The fleet review as the cockpit draws it. → `docs/spec/07-pull-requests.md#the-fleet-review` */
export type { PrReviewState, PrReviewStatus } from './review/prReviewState.js';
/** Whether a pull request has a review pack. → `docs/spec/31-review-packs.md#on-the-row` */
export type { PrPackStanding } from './reviewPacks/standing.js';
export type { PoolRollup, PoolRollupRow } from './pool/aggregate.js';
/** What `POST /api/issues/:number/dismiss-run` stopped on its way out. */
export type { RunClearOut } from './floor/endRun.js';
export type {
  AllowanceApportionment,
  AllowanceGoal,
  AllowanceInsights,
  AllowanceLane,
  AllowanceProjection,
  AllowanceReading,
} from './allowanceInsights.js';
export type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun } from './spendInsights.js';
export type { LocalRunFreshness, LocalRunPorts, LocalRunTurn } from './types.js';
export type {
  McpChannelUsage,
  McpInsights,
  McpNaming,
  McpNamingTotal,
  McpPhaseUsage,
  McpQuietTool,
  McpRefusal,
  McpSilentRun,
  McpToolUsage,
} from './mcpInsights.js';
export type { InsightsWindow, InsightsWindowView } from './insightsWindow.js';
export type {
  SpendTrend,
  SpendTrendComparison,
  SpendTrendPeriod,
  SpendTrendPhaseShift,
  SpendTrendBucket,
} from './spendTrend.js';
export type { ChecksSpend, TaskTypeSpend } from './taskTypeSpend.js';
export type { Stack } from './stacks/stack.js';
export type { PlanDiff } from './plans/planDiff.js';
export type { AcceptanceCriterion } from './plans/parts.js';
export type { SupplyState } from './supply/runway.js';
export type { PlanningPolicy } from './plans/planning.js';
export type { PetRules } from './pets/rules.js';
export type { ValidationPolicy } from './validation/policy.js';
export type { LocalRunOption } from './localRun/ref.js';

/**
 * One pet as the cockpit draws it: the stored record, plus everything about it
 * the catalogue decides.
 *
 * **Extends the domain type rather than re-declaring it.** `rarity`, `display`,
 * `stage` and `beatsToNextStage` are all pure functions of `species` and `fed`,
 * computed once here — because two implementations of one arithmetic is how a
 * card comes to read `JUVENILE` above a sprite drawn as an adult, with nothing
 * red to say so.
 */
export interface PetView extends Pet {
  rarity: PetRarity;
  /** The species' own name, which is what an unnamed pet is called. */
  display: string;
  stage: PetStage;
  /** Beats still owed to the next stage, or null for an adult. */
  beatsToNextStage: number | null;
  /**
   * Why this one does not verify against the record of what you did, or null when
   * it does.
   *
   * Computed server-side on every snapshot, for the same reason `stage` is: the
   * check is a re-roll of the pet's own origin, and a cockpit that did it too
   * would be a second implementation of the arithmetic that decides whether a
   * creature is real. → `docs/spec/22-pets.md#authenticity`
   */
  flaw: PetFlaw | null;
  /**
   * What the origin was, in words — the escalation's question, the ask's title,
   * the plan's title, the landing's goal, the job's title, the finding's claim,
   * or the short sha an upgrade was applied at.
   *
   * **Derived per snapshot, never stored.** A label read from the source row at
   * draw time is the name that thing has *now*; a copy taken at hatch would
   * disagree with it the first time a job is renamed or an escalation reworded.
   * Null when the source row is gone, which is not a flaw and never reaches the
   * attestation — the card falls back to the ref it has always shown.
   * → `docs/spec/22-pets.md#the-sources`
   */
  originLabel: string | null;
  /**
   * What kind of build hatched it: an official one, one running uncommitted
   * changes, or no reading at all.
   *
   * Descriptive, never a verdict. `unknown` is what every pet from before the
   * stamp existed reports, and what a deployment that is not a git checkout always
   * will. → `docs/spec/22-pets.md#authenticity`
   */
  provenance: PetProvenance;
}

/**
 * One species as the Pets page draws it: what it is, what it costs, and how often
 * it turns up.
 *
 * Every number here is **derived from the catalogue and the rules**, never a
 * second copy of them — `share` is the roll walked over every action and every
 * hour, and `juvenileAt` / `adultAt` come from the same `beatsToNextStage` a
 * `PetView` does. A page that recomputed any of it from a copied threshold is how
 * a card comes to advertise a price the harness does not charge, with nothing red.
 * → `docs/spec/22-pets.md#the-pets-page`
 */
export interface PetCatalogueEntry {
  species: PetSpecies;
  /** The species' own name, which is what an unnamed pet of it is called. */
  display: string;
  rarity: PetRarity;
  /** The multiplier on both stage thresholds and on what a duplicate blends back into. */
  growth: number;
  /** Beats fed to reach each stage — the same arithmetic `PetView.beatsToNextStage` runs. */
  juvenileAt: number;
  adultAt: number;
  /** What dissolving a duplicate of this species hands back. */
  blend: number;
  /**
   * Share of all drops, over an even mix of the seven actions and a uniform hour.
   *
   * Each action is weighted by its own `dropChance` rather than counted evenly,
   * because since #427 the rate is priced against how often the action comes up —
   * an upgrade is one in five and a job one in sixty-six, so counting them evenly
   * would describe a deployment nobody runs.
   *
   * It is still an assumption and the page says so: no deployment takes the seven
   * actions in equal numbers. It is the only figure that can be stated about a
   * species rather than about a species-and-an-action, which is why
   * {@link PetCatalogueSource} ships the exact per-action answer beside it.
   */
  share: number;
  /** The actions that can draw it, in pool order. */
  kinds: PetActionKind[];
  /**
   * The hours it may be drawn in, or null for any hour.
   *
   * Shipped as the hours themselves rather than as a `nightOnly` flag, because the
   * gate is a property of the pool rather than of a name: a second species gated on
   * a different window needs no wire change, and nothing outside
   * `src/pets/catalogue.ts` has to know which species is the nocturnal one.
   */
  hours: number[] | null;
}

/**
 * What one action's roll of one tier actually resolves to.
 *
 * The step-down is invisible anywhere else in the cockpit, and it is the rule that
 * decides the most: settling a task can never produce a rare, because `human-task`
 * holds none and the roll walks *down*. → `docs/spec/22-pets.md#the-pets-page`
 */
export interface PetCatalogueSource {
  kind: PetActionKind;
  /** The tier the global table rolled. */
  rolled: PetRarity;
  /** The tier it landed on after any step down — never above `rolled`. */
  landed: PetRarity;
  /** What it may draw there, at an hour that admits every species. */
  members: PetSpecies[];
}

/** Everything the Pets page draws that is not the operator's own collection. */
export interface PetCatalogue {
  /** The one table, on every deployment — the page's whole claim to be worth reading. */
  rules: PetRules;
  /**
   * The tiers commonest-first, which is both the order the page bands them in and
   * the direction a roll steps *down*. Shipped rather than re-declared in the
   * cockpit: a fifth tier added to the catalogue would otherwise render nowhere.
   */
  rarities: PetRarity[];
  species: PetCatalogueEntry[];
  sources: PetCatalogueSource[];
}

/** The whole vivarium, as it rides on the state snapshot. */
export interface PetState {
  pets: PetView[];
  wallet: PetWallet;
  /** How many pets stand in the enclosure at once, so the cockpit refuses the fifth in the same words the server does. */
  slots: number;
  /**
   * When this vivarium started counting, or null on a deployment whose first
   * enabled scan has not run yet.
   *
   * Shipped so the cockpit can *say* it. Nothing an operator can see otherwise
   * distinguishes a harness that pays nothing for a year of escalations, jobs and
   * findings from one that is simply broken — the actions are on record, the
   * enclosure is empty, and the page's own rates argue that something should have
   * dropped by now. The date is the whole answer, and it only exists here.
   *
   * Null is a real state rather than a placeholder, and it lasts one boot: the
   * start is stamped by the keeper's first scan, not by the `Store`, so a
   * deployment sitting with pets turned off does not burn a date it cannot use.
   * A surface draws nothing at all rather than a sentence about a boundary that
   * has not been decided.
   */
  startedAt: string | null;
}

/**
 * `/api/mcp` — how to point the operator's own Claude Code at this harness, and
 * what it gets when they do.
 *
 * Every field is read off the running channel rather than written down in the
 * cockpit: the bridge path is resolved from the server's own module URL, the
 * paths come from `validation.*`, and the tools are the ones `tools/list` would
 * answer with. A tab that restated any of it would be a second copy of the
 * install instructions, correct on the day it was written.
 */
export interface McpChannelPayload {
  /**
   * Whether the channel bound its socket at boot. False is a real state, not an
   * error — a live socket on the stable path belongs to another harness, and the
   * registration below is then a command that would connect to that one.
   */
  running: boolean;
  /** The key the server is registered under, and the prefix of every qualified tool name. */
  serverId: string;
  /** The one-off registration, as an argv the cockpit renders into a paste-able command. */
  registration: { command: string; args: string[] };
  /** Where the bearer credential is written (`0600`), reminted at every start. */
  credentialPath: string;
  /** The `/lubbdubb` skill the harness rewrites on every start. */
  skillPath: string;
  /** The tools the desktop channel advertises, in the order `tools/list` gives them. */
  tools: { name: string; description: string }[];
}

/**
 * `/api/pool` — the cross-fleet pool as this fleet sees it: its own side, and the
 * mirror of everybody else's.
 *
 * A route of its own rather than a field on the state snapshot, for
 * {@link McpUsagePayload}'s reason: the mirror is other teams' prose plus ninety
 * days of rows per fleet, and the snapshot comes round every couple of seconds for
 * every open cockpit.
 *
 * → `docs/spec/28-cross-fleet-pool.md#in-the-cockpit`
 */
export interface PoolStatePayload {
  /**
   * Null on the `fake` default, and that null is load-bearing: a deployment with no
   * pool and a pool that has never published are different facts, and drawing the
   * second for the first says in the operator's words that something is broken.
   */
  status: PoolStatus | null;
  /** Every fleet the mirror has heard from — including the ones ahead of this build. */
  fleets: PoolFleetReading[];
}

/**
 * `/api/pool/insights` — the shared page: everybody's digests folded across fleets.
 *
 * `rollup.byCheck` is null unless the request named a project, and that is the
 * shape rather than a flag: a reader that forgot the filter would sum two unrelated
 * pipelines, and null makes that unreachable rather than merely wrong.
 */
export interface PoolInsightsPayload {
  rollup: PoolRollup;
  /** The projects the mirror actually holds, so the picker offers what exists. */
  projects: string[];
  fleets: PoolFleetReading[];
}

// ---------------------------------------------------------------------------
// The obstacle board (`/api/obstacles`) → `docs/spec/27-obstacles.md#in-the-cockpit`

/**
 * One row of the board as the tab draws it: the standing the harness already
 * assembles, plus the voices in their authors' own words.
 *
 * `extends ObstacleStanding` rather than a shape of its own, so the claim, the
 * keys, the voice count and the goals it cost are the store's own reading and not
 * a second one — the number that carries a row to `standing` and the number the
 * page prints have to be one number.
 *
 * The sightings ride on the row rather than behind a second fetch, and that is a
 * reading about size rather than a shortcut: a board is tens of rows of one
 * sentence each, where `KnowledgeFactPayload` is fetched per row because the
 * evidence behind one claim is thousands of characters. It also makes the fold
 * that opens a row a *fold* — no request, no spinner, no half-open row on a
 * dropped socket — which matters here because that fold is the only place the
 * matcher can be seen working or getting it wrong.
 */
export interface ObstacleBoardRow extends ObstacleStanding {
  /** Every voice, oldest first — each with its goal and why it landed here. */
  sightings: ObstacleSighting[];
}

/**
 * The four figures the page draws, and **only** figures something counted.
 *
 * *Turns an agent did not spend* is the figure everyone wants and nothing
 * measures, so it is not here and must not be added: a number invented to sit
 * beside four real ones is the one thing on the page that would be a lie, and it
 * would be the one quoted. → `docs/spec/27-obstacles.md#in-the-cockpit`
 */
export interface ObstacleBoardCounts {
  /** Every voice on every row, the harness's own included. */
  sightings: number;
  /** Distinct goals that have reported something, across the whole board. */
  goals: number;
  /**
   * Mid-session notices actually sent, over all time — `obstacle_notices`, which
   * is the only *telling* this subsystem keeps a record of. Dispatch-time delivery
   * appends a paragraph to a prompt and writes nothing, so the two are never summed
   * and the page says which one this is.
   */
  told: number;
  /** How the call rate was measured. Sent so the page states its own window. */
  window: ObstacleCallRate;
}

/**
 * Whether agents call the intake at all — the one thing
 * [27](docs/spec/27-obstacles.md#what-is-not-settled) leaves unsettled, as a number
 * rather than an impression.
 *
 * Three counts and the span they were taken over, rather than a rate computed
 * here: a ratio hides its own denominator, and the denominator is the interesting
 * half. `agents` counts the agents that reached the tool channel **at all**, which
 * is the honest denominator for *did an agent that could call it, call it* — an
 * agent whose `mcp__lubbdubb__*` grants were dropped never could, and is a
 * different fault the MCP tab already draws.
 */
export interface ObstacleCallRate {
  /** The start of the span, ISO. */
  since: string;
  /** Calls to `raise` on the fleet channel inside it. */
  calls: number;
  /** Agents that made at least one of those calls. */
  callers: number;
  /** Agents that made any fleet tool call at all inside it. */
  agents: number;
}

/**
 * `GET /api/obstacles` — the whole board, its four counted figures, and the two
 * facts the page needs to draw a row honestly.
 *
 * A route of its own rather than a field on the state snapshot, for
 * {@link PoolStatePayload}'s reason: this is every sighting's prose for every row,
 * and the snapshot comes round every couple of seconds for every open cockpit.
 */
export interface ObstacleBoardPayload {
  /** Every row, newest-seen first — the store's own order. */
  rows: ObstacleBoardRow[];
  counts: ObstacleBoardCounts;
  /**
   * `config.obstacleDormantMs`, so the dimmed section can say **when** a row goes
   * dormant rather than that it eventually will. Sent rather than assumed, because
   * it is a deployment's setting and a cockpit-side constant would be a second
   * statement of it that goes stale silently.
   */
  dormantMs: number;
  /**
   * Whether a tracker is configured. The *own it* control names a ticket the
   * operator is already using, so it is the same gate the filing arms ask — and
   * with no tracker there is no ref to name.
   */
  canFileTickets: boolean;
}
