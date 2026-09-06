import type { DispatchContext } from '../dispatcher.js';
import type { AdmissionId, DispatchRuleId } from '../rules.js';
import type { CooldownPolicy } from '../dispatchCooldown.js';
import type { IssuePickupPolicy } from '../issuePickup.js';
import type { PromptTemplates } from '../promptTemplates.js';
import type { RuleHeld } from '../admission.js';
import type { CiPolicy } from '../../ci/ciPolicy.js';
import type { PrReviewPolicy } from '../../review/policy.js';
import type { PrReviewCharters } from '../../review/prReview.js';
import type { PlanningPolicy } from '../../plans/planning.js';
import type { LocalValidationPolicy } from '../../localValidation/policy.js';
import type { SequenceableFeature } from '../../sequence/sequence.js';
import type {
  FeatureSequence,
  Issue,
  IssueAppraisal,
  IssueConclusion,
  IssueRelative,
  IssueShortfall,
  LocalRun,
  LocalValidation,
  ObstacleStanding,
  Plan,
  PrReview,
  PrReviewRoute,
  PullRequest,
  TaskSummary,
  ValidationCheck,
} from '../../types.js';
import type { PlanRouteVerdict } from '../../plans/planning.js';
import type { PrRefStyle } from '../../prRef.js';

/**
 * The state a pipeline stage runs against: a stage takes exactly this and reaches back into
 * nothing. Carries the operator's policy objects rather than a handle on the dispatcher.
 *
 * **`appraising` and `assessing` are written by one stage and read by later ones** — outputs of
 * `issue-appraisal` / `issue-assess`, inputs downstream, the mechanism behind `superseded`. Moving
 * either rule below its readers compiles fine and silently puts two agents on one issue. Nothing
 * else here is order-dependent.
 */
export interface StageContext {
  /** The cycle's world + fleet, verbatim. */
  ctx: DispatchContext;
  /** "Now" for cooldown arithmetic — the snapshot's own ISO timestamp, not wall-clock at decision time. */
  now: string;
  /** Actions that claim no headroom, emitted directly. Append-only. */
  raw: unknown[];
  /** Ranked agent-dispatch candidates, in pipeline order. Append-only; the headroom cut runs after the whole walk (rank-then-slice, issue #69). */
  candidates: Candidate[];
  /** Origins with an active task. The cut adds to this as it dispatches. */
  activeOrigins: Set<string>;
  /** `agentId::origin` pairs already delivered as a note (see `notifiedOriginsByAgent`). */
  notified: Set<string>;
  /** `branch::signal` pairs a dispatch already put in an agent's prompt. */
  dispatchedSignals: Set<string>;
  /** Every open PR the world knows about, including ones the operator's ignore tag hid — here only so "no PR" can't be mistaken for "merged". */
  openPrs: PullRequest[];
  /**
   * Is this pull request's reading older than the fleet's own last act on it? PR concerns gate on
   * facts an agent changes *out there*, so a stale cached reading would otherwise re-dispatch on
   * work already done. True holds this PR's concerns for one cycle; nothing is lost.
   * → `refsFinishedSince` in `src/world/readPlan.ts`, [04](docs/spec/04-harness-cycle.md#the-local-cycle)
   */
  readingBehindFleet: (prNumber: number) => boolean;
  /** The plan funnel's memory, keyed on `issue:<n>`, read by work-item, plan and pickup rules alike so none can disagree. Empty with the funnel off. */
  plansByOrigin: Map<string, Plan>;
  /** Standing "is this issue finished" verdicts, on the same origin. */
  conclusions: Map<string, IssueConclusion>;
  /** The negative half of that verdict, on the same origin. */
  shortfallsByOrigin: Map<string, IssueShortfall>;
  /** Standing goal appraisals, on the same origin again (issue #158). */
  appraisals: Map<string, IssueAppraisal>;
  /**
   * Issues in the world that are **retained runs**, not the tracker's answer — a goal worked,
   * forgotten by the tracker, not yet dismissed. Exactly two rules may act on one (`issue-assess`,
   * `issue-retro`); **every other rule skips them explicitly**, never by relying on `closed` state.
   */
  retained: Set<number>;
  /** The world issue with this number, **unless it is a retained run**. Null for both absences. */
  liveIssue: (issueNumber: number) => Issue | null;
  /** Is this issue decomposed — i.e. owned by the part scheduler, not by pickup? */
  partsPlanFor: (issueNumber: number) => Plan | null;
  /** Is a standing `delivered` verdict parking this issue? */
  deliveryParked: (issue: Issue) => boolean;
  /** Is a standing goal appraisal parking this issue — refused, or awaiting a profile answer? */
  appraisalParked: (issue: Issue) => boolean;
  /**
   * The profile a dispatch on this origin is pinned to, or null. Three levels, narrowest first: the
   * operator's override on this queue row, the plan's part profile, the goal's tag. Applied in
   * exactly one place, since a forgotten pin is invisible — only the bill says which profile ran.
   */
  pinFor: (originRef: string | null) => string | null;
  /** The operator's own profile overrides, keyed on origin — the narrowest level {@link StageContext.pinFor} consults. Empty until one is set. */
  profileOverrides: ReadonlyMap<string, string>;
  /** Open, watched, un-parked issues with no open PR, in label-encoded priority order. Shared by every issue-side rule wanting the narrowed list (three deliberately don't). */
  eligibleIssues: { issue: Issue; weight: number }[];
  /** The open containers an item with no parent could belong to — the *suggestion* beside an orphan flag. Empty on a tracker with no hierarchy. */
  parentCandidates: IssueRelative[];
  /** Which arm of the plan funnel each eligible issue is on, keyed by issue number. Shared by `issue-plan` and `issue-pickup` so the two can't disagree. */
  routes: Map<number, PlanRouteVerdict>;
  /**
   * The stories an accepted order is holding, and what each waits behind — keyed by issue number,
   * absent for a story nothing holds. Derived **once** so `issue-plan` and `issue-pickup` can't
   * disagree. Empty with `issueSequencing` off (the default, every fail-open arm).
   * → `docs/spec/33-story-sequencing.md`
   */
  sequenceWaits: ReadonlyMap<number, number[]>;
  /** The Features rule `feature-sequence` could ask about. Empty below level `full`, and for a Feature with one story or more than `issueSequenceMaxChildren`. */
  sequenceableFeatures: readonly SequenceableFeature[];
  /** Every order on file, keyed on the Feature's own `issue:<n>` — one map, so proposer and gate can't disagree. */
  sequences: ReadonlyMap<string, FeatureSequence>;
  /** Every goal's validation checks, keyed by the goal's origin ref — read by `validate-check` and nothing else. */
  validationChecks: Map<string, ValidationCheck[]>;
  /** The obstacle board — every row with its keys, voice count and reporting goals. Read by rule `obstacle-repair` only; empty until wired. */
  obstacles: readonly ObstacleStanding[];
  /** The checks failing on a branch other open pull requests are **based on**. The ownership desk asks the same set, so the two can't disagree. */
  redBaseChecks: ReadonlySet<string>;
  /** Issues `issue-appraisal` claimed this cycle. Written by it, read after it — see the class doc. */
  appraising: Set<number>;
  /** Issues `issue-assess` claimed this cycle. Written by it, read after it — see the class doc. */
  assessing: Set<number>;
  /**
   * Throttle a persistent concern: a finished agent that didn't clear its origin cools down instead
   * of re-dispatching every cycle, and escalates once attempts are spent. Escalations claim no
   * headroom; a cooling candidate stays in the queue greyed.
   */
  consider: (candidate: Candidate, onEscalate: (attempts: number) => RawAction) => void;

  // ---- The operator's policy, rather than a handle on the dispatcher. -------
  pickup: IssuePickupPolicy;
  cooldown: CooldownPolicy;
  templates: PromptTemplates;
  planning: PlanningPolicy;
  ci: CiPolicy;
  /** The fleet review's policy. `pr-review` is switched via `review.enabled` in two places reading this field, since the PR concerns register under one id. */
  review: PrReviewPolicy;
  /** The project's review charters — how to choose a mode, and what each looks for — read once at boot. Text, never a filesystem path. */
  reviewCharters: PrReviewCharters;
  /** The fleet reviews already recorded, keyed by pull request — one map for the rule and the merge gate, so the two can't disagree. */
  prReviews: ReadonlyMap<number, PrReview>;
  /** How triage decided each pull request should be read, keyed by pull request. Absent means unrouted — `pr-review`'s fail-open default, `pr-review-triage`'s work to do. */
  prReviewRoutes: ReadonlyMap<number, PrReviewRoute>;
  /** Pull requests a check outside the harness reported already reviewed (`Store.prsReviewedElsewhere`). Empty where unconfigured. */
  prReviewedElsewhere: ReadonlySet<number>;
  /** The base a PR is assumed to target when the provider doesn't report one. */
  defaultBranch: string;
  /** The sigil the configured provider reads as "pull request" in prose, so summaries name a PR the way the agent's own description must. → `src/prRef.ts` */
  prRefStyle: PrRefStyle;
  /** What a planner is told about the post-deploy watch, already rendered, **appended** to whatever prompt it got — a finished string since `src/dispatcher/` may not import the lens. → `src/plans/planning.ts` */
  watchNote: string;
  /** What a **working** agent is told about the post-deploy watch, already rendered and appended. A separate string from {@link watchNote}: the two parties are told opposite things. → `src/plans/planning.ts` */
  watchDeclareNote: string;
  /** Where a goal's validation resources live, so `validate-check` can tell an agent which directory to look in. The dispatcher only phrases it. */
  validationRoot: string;
  /** The local run that is up right now, or null — read by `local-validation` to ask whether the requested environment is still the one on the machine. A snapshot, so the rule stays pure. */
  liveLocalRun: LocalRun | null;
  /** Local validations the pipeline still has something to do about: open ones a validator may be dispatched for, and failed ones a fix may be. One list, since filtering here would mean the dispatcher deciding what each rule sees. */
  localValidations: LocalValidation[];
  /** `localValidation`, read by rule `local-validation` when composing a dispatch. Held by reference so a corrected instruction reaches the next validation with no restart. */
  localValidation: LocalValidationPolicy;
  /** `validation.desktopClaimMinutes`, so `validate-check` and the desktop tools agree when a claim has expired. */
  validationClaimMinutes: number;
  /** The two work-item rules' config, narrowed to non-null once. Null when the operator hasn't configured both a review state and pickup states — also what switches the rules off. */
  workItemStates: { inReviewState: string; pickupStates: string[] } | null;
  /** Rule `work-item-in-progress`'s config, narrowed the same way. `pickupStates` is the *effective* list, so the rule sees its own written state and is idempotent by exclusion. */
  workItemInProgress: { inProgressState: string; pickupStates: string[] } | null;
}

/**
 * One thing a stage emits that isn't routed through the candidate list. `rule` names what
 * **proposed** the action and `admission` what **became** of it. `rule` is nullable for exactly one
 * emission — the branch note, which has no single proposer (see `prCiFailing`).
 */
export type RawAction = Record<string, unknown> & {
  type: string;
  reason: string;
  rule: DispatchRuleId | null;
  admission?: AdmissionId;
};

/** A ranked agent-dispatch candidate awaiting the headroom cut. */
export interface Candidate {
  origin: string;
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  reason: string;
  action: RawAction;
  /** Held this cycle for a reason that isn't fleet headroom — visible in the queue, never dispatched. `waiting` is absent since only the headroom cut can decide it. */
  held?: RuleHeld;
}

export function isActive(t: TaskSummary): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}
