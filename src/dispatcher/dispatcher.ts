import type {
  Agent,
  Decision,
  Escalation,
  FeatureSequence,
  GoalPriority,
  IssueConclusion,
  IssueAppraisal,
  IssueDelivery,
  IssueShortfall,
  Job,
  ObstacleBlock,
  ObstacleStanding,
  Plan,
  PlanAmendment,
  PlanPart,
  PriorityOverride,
  ProfileOverride,
  Proposal,
  PrReview,
  PrReviewRoute,
  PullRequest,
  Remedy,
  TaskSummary,
  LocalRun,
  LocalValidation,
  ValidationCheck,
  WorldEvent,
  WorldSnapshot,
} from '../types.js';
import type { AgentModels, ProfileSource } from '../agents/modelPolicy.js';
import type { ParseResult } from './actions.js';
import type { QueueStatus } from './admission.js';
import type { DispatchRuleId } from './rules.js';

/** Everything the dispatcher gets to look at when deciding what to do this cycle. */
export interface DispatchContext {
  world: WorldSnapshot;
  /**
   * Open PRs hidden from `world.pullRequests` — unwatched ones, and ones a colleague opened
   * (`src/prOwnership.ts`). No rule acts on either, but gates that must not read "absent from the
   * world" as "merged" (issue pickup, work-item state back-off) still resolve against these.
   * Absent/empty = nothing hidden.
   */
  hiddenPrs?: PullRequest[];
  /**
   * Which of `world.issues` are retained runs rather than the tracker's own answer (issue #234):
   * worked, ticket no longer returned, not dismissed. Kept in the issue list so `issue-assess`
   * and `issue-retro` can still finish after the delivering PR closed the ticket. Every other
   * rule must skip them itself — a retained issue reads `closed`, and inheriting that silently
   * would rest half the rule book's safety on a filter none of them names. Absent/empty = none.
   */
  retainedIssues?: number[];
  /**
   * What a dispatch needs to resolve its pinned profile (issue #342): the label prefix and the
   * profiles it may name. Absent means no dispatch is ever pinned — the safe absence, since the
   * alternative is an unwired caller silently repricing the fleet.
   */
  modelPins?: { labelPrefix: string; models: AgentModels };
  /**
   * The most recent accounts of why the fleet returned to a pull request, newest first —
   * rendered into `pr-ci-failing`/`pr-review-comment` prompts. Read-only and gates nothing: a
   * dispatch that gated on an agent's own account of its run would be self-referential.
   * Absent/empty = nothing accounted for yet.
   */
  priorRemedies?: Remedy[];
  /**
   * Recorded fleet reviews (`Store.listPrReviews`). Absent is safe only because `pr-review` is
   * off by default — with review on and this unwired, every PR looks unreviewed forever.
   */
  prReviews?: PrReview[];
  /** How triage decided each PR should be read. Absent runs the fail-open default mode. */
  prReviewRoutes?: PrReviewRoute[];
  /** PRs an external check reported already reviewed. Absent = none — the safe direction (a wasted agent, not a missed review). */
  prReviewedElsewhere?: ReadonlySet<number>;
  /** Current fleet: running / waiting / recently-finished tasks and their agents. */
  tasks: TaskSummary[];
  agents: Agent[];
  openEscalations: Escalation[];
  /** Operator-launched jobs still awaiting a slot, oldest first, drained before any world-driven rule. */
  queuedJobs: Job[];
  /**
   * Live jobs standing in for another origin's work (e.g. a crash recovery's requeue keyed on the
   * original's origin). Folded into `activeOrigins` so the original rule does not double-dispatch.
   * Absent/empty = nothing being redone.
   */
  standingJobs?: Job[];
  /** Every persisted plan, keyed by `issue:<n>` origin. Absent/empty = no verdict yet, or the funnel is off. */
  plans?: Plan[];
  /** Every plan's parts — the scheduling graph `plan-part` walks, reconciled this cycle. */
  planParts?: PlanPart[];
  /** Proposed changes to running plans still awaiting an operator (`plan_amendments`). Absent/empty = none proposed. */
  planAmendments?: PlanAmendment[];
  /**
   * Every plan's validation checks. `validate-check` reads only whether the operator handed it
   * over and whether a reading exists — not what the check says. Absent/empty = none handed over.
   */
  validationChecks?: ValidationCheck[];
  /**
   * The local run up on the operator's machine, or absent for none. Read only by
   * `local-validation`, since a validation is pinned to a run and this is how the rule checks the pin still holds.
   */
  localRun?: LocalRun | null;
  /** Local validations still needing action — open, or failed with no fix yet. Absent/empty = none. */
  localValidations?: LocalValidation[];
  /**
   * Operator "Up next" priority overrides (issue #128), keyed on candidate origin. Ranks ahead of
   * natural ordering but behind `manual-job` and every `held` verdict — order only, never a
   * cooldown/cap/tag/plan hold. Absent/empty = natural ranking stands.
   */
  priorityOverrides?: PriorityOverride[];
  /**
   * Goals the operator marked a priority — every origin under one (pickup, plan, parts,
   * appraisal, assessor, validation, PRs) ranks ahead of natural order, behind `manual-job` only.
   * Ordering only, same as `priorityOverrides`. Absent/empty = natural ranking stands.
   */
  goalPriorities?: GoalPriority[];
  /**
   * The operator's per-origin profile pin from the queue, highest precedence in the pin chain
   * (narrowest, latest statement). Pricing only — never un-holds or lifts a candidate over the
   * headroom cut. Absent/empty = resolves on tag or rule.
   */
  profileOverrides?: ProfileOverride[];
  /**
   * Standing "is this issue finished" verdicts, keyed on `issue:<n>`. Read by
   * `work-item-back-to-pickup`, which returns an item to pickup only on explicit `more_work`.
   * Absent/empty resolves every issue to `undeclared`, which holds rather than releases — silence
   * must not read as "not done" (see `src/issueConclusion.ts`).
   */
  conclusions?: IssueConclusion[];
  /**
   * Standing `delivered` verdicts, keyed on `issue:<n>`. Unlike a conclusion this gates pickup:
   * `issue-pickup` skips an issue whose verdict still stands. Absent/empty = nothing parked.
   */
  deliveries?: IssueDelivery[];
  /**
   * World transitions on delivered issues since the oldest delivery, narrowed by
   * `deliverySignalQuery`. Absent = nothing observed, which holds every verdict.
   */
  deliverySignals?: WorldEvent[];
  /**
   * Standing "worked, goal not reached" verdicts (issue #159), keyed on `issue:<n>`. Gates
   * nothing — `issue-shortfall` is the one consumer and routes the named failure. Absent/empty = none.
   */
  shortfalls?: IssueShortfall[];
  /**
   * Standing goal-appraisal verdicts (issue #158), keyed on `issue:<n>`. An `unclear` verdict
   * gates `issue-plan`/`issue-pickup` while it stands. Absent/empty holds nothing — the fail-open
   * that makes the gate safe (see `src/intake/appraisal.ts`).
   */
  appraisals?: IssueAppraisal[];
  /**
   * Origins that already have a retrospective — origins only, never the writing. `issue-retro`
   * may know only whether to dispatch one; branching on prose would let one agent's account
   * change what the harness schedules next. Absent/empty holds nothing.
   */
  retrospectiveOrigins?: string[];
  /**
   * Where every Feature's work stands, as `featureStandingKey` digests it — never a word of what
   * anybody wrote, same rule as `retrospectiveOrigins`. `feature-summary` compares the key to
   * {@link featureSummaryKeys}. Absent/empty = no feature board wired, nothing ever summarised.
   */
  featureStandings?: { number: number; title: string; key: string }[];
  /** The key each Feature's standing summary was written against. Absent/empty = none written, summarises once. */
  featureSummaryKeys?: { originRef: string; standingKey: string }[];
  /**
   * Every story order on file — the key `feature-sequence` compares against and the edges
   * `accepted` ones hold work with, one list so proposer and enforcer cannot disagree.
   * Absent/empty = no Feature has an order. → `docs/spec/33-story-sequencing.md`
   */
  featureSequences?: FeatureSequence[];
  /**
   * The obstacle board (`Store.obstacleBoard`), read by `obstacle-repair`. Absent/empty = no
   * repair ever proposed — the fleet works around obstacles, as before this existed.
   */
  obstacles?: ObstacleStanding[];
  /**
   * Goals parked behind an obstacle (`Store.listObstacleBlocks`). Gates pickup: a blocked issue
   * is not eligible for the funnel, like a delivered one. Absent/empty = nothing parked.
   */
  obstacleBlocks?: ObstacleBlock[];
  /** How many more agents may be started this cycle (concurrency headroom). */
  agentHeadroom: number;
  /** Recent audit decisions, so a persistent PR signal isn't re-notified to an agent every cycle. */
  recentDecisions: Decision[];
  /**
   * Acts already put to a human (issue #109), newest first. A rule must not re-propose an act
   * while the human's verdict stands (see `proposalHold`). Absent/empty = nothing proposed.
   */
  proposals?: Proposal[];
  /**
   * World transitions on items a standing rejection concerns, since the oldest rejection
   * (issue #109 phase 4) — narrowed by `rejectionSignalQuery`. Absent = nothing observed, which
   * holds every rejection (the refuse-rather-than-act direction).
   */
  rejectionSignals?: WorldEvent[];
}

/**
 * One ranked agent-dispatch candidate from a cycle's plan — the "Up next" queue (issue #69). A
 * projection, not a persisted FIFO: recomputed from the world every cycle.
 */
export interface QueueItem {
  origin: string;
  /** The dispatcher rule that raised the candidate (a DISPATCH_RULES key). */
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  /**
   * Where the candidate sits relative to the headroom cut — dispatched, or held for a reason in
   * `HeldReason`. Every held reason appears here rather than vanishing the candidate, so what is
   * holding it stays visible.
   */
  status: QueueStatus;
  reason: string;
  /**
   * This row belongs to a goal the operator marked a priority. Shipped as a fact (absent rather
   * than `false` when not set) rather than re-derived in the browser.
   */
  expedited?: boolean;
  /**
   * The `agentModels` profile this candidate would launch on, resolved by the same chain the
   * dispatch is stamped from. Null on a deployment with no `agentModels`, or a rule with no entry
   * and no `default` — both mean no `--model` flag at all.
   */
  profile?: string | null;
  /** Which level of the chain named {@link QueueItem.profile} — the only place a pin is visible as such. */
  profileSource?: ProfileSource;
  /**
   * The operator's own standing override for this origin, when there is one — the value the
   * cockpit's picker binds to. Distinct from {@link QueueItem.profile}: that answers "what will
   * run" (an override may not even win); this answers "what did I say".
   */
  override?: string;
}

export interface DispatchResult extends ParseResult {
  /** Free-form reasoning the dispatcher produced, kept for the audit trail. */
  rationale: string;
  /**
   * The full ordered pickup plan, including candidates below the headroom cut. Optional because
   * a decision procedure need not rank what it did not pick; {@link RuleDispatcher} always
   * materialises one, so `Harness.upcoming` is null only before the first cycle.
   */
  upcoming?: QueueItem[];
}

/**
 * Decides what the harness should do this cycle: full state in, a validated, bounded action plan
 * out. {@link RuleDispatcher} is the one implementation. This stays an interface because `Harness`
 * takes a `Dispatcher`, never the class, so what decides can be swapped without the cycle knowing.
 */
export interface Dispatcher {
  decide(ctx: DispatchContext): Promise<DispatchResult>;
}
