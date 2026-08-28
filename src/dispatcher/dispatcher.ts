import type {
  Agent,
  Decision,
  Escalation,
  GoalPriority,
  IssueConclusion,
  IssueAppraisal,
  IssueDelivery,
  IssueShortfall,
  Job,
  Plan,
  PlanPart,
  PriorityOverride,
  ProfileOverride,
  Proposal,
  PrReview,
  PrReviewRoute,
  PullRequest,
  Remedy,
  TaskSummary,
  ValidationCheck,
  WorldEvent,
  WorldSnapshot,
} from '../types.js';
import type { PrReviewIntake } from '../review/intake.js';
import type { AgentModels, ProfileSource } from '../agents/modelPolicy.js';
import type { ParseResult } from './actions.js';
import type { QueueStatus } from './admission.js';
import type { DispatchRuleId } from './rules.js';

/** Everything the dispatcher gets to look at when deciding what to do this cycle. */
export interface DispatchContext {
  world: WorldSnapshot;
  /**
   * Open PRs carrying no watch tag, hidden from `world.pullRequests`. No rule *acts*
   * on them — that is the whole of being unwatched — but they are still open, so
   * gates that must not read "absent from the world" as "merged" (issue pickup, the
   * work-item state back-off) resolve against these too. Absent/empty = nothing hidden.
   */
  unwatchedPrs?: PullRequest[];
  /**
   * Which of `world.issues` are **retained runs** rather than the tracker's own
   * answer (issue #234): a goal the harness has worked, whose ticket the tracker
   * no longer returns, and which the operator has not dismissed. They are in the
   * issue list so the two rules that come *after* a merge — `issue-assess` and
   * `issue-retro` — can still finish once the delivering PR closed the ticket.
   *
   * **Every other rule must skip them, in its own body.** A retained issue reads
   * `closed`, which most gates already refuse, and inheriting that would leave the
   * safety of half the rule book resting on a filter none of them names. Absent or
   * empty means every issue in the world came from the connector.
   */
  retainedIssues?: number[];
  /**
   * What a dispatch needs to resolve its pinned profile (issue #342): the prefix
   * the goal tags are derived from, and the profiles those tags may name.
   *
   * Absent — no `agentModels`, no `labelPrefix`, or a caller that has not wired
   * it — means no dispatch is ever pinned and every one resolves on its rule,
   * which is exactly the behaviour before pins existed. That is the safe absence:
   * the other direction would have an unwired caller silently repricing the fleet.
   */
  modelPins?: { labelPrefix: string; models: AgentModels };
  /**
   * The most recent accounts of why the fleet came back to a pull request, newest
   * first — what `pr-ci-failing` and `pr-review-comment` append to a fresh
   * dispatch's prompt (`src/remedies/priorRemedies.ts`).
   *
   * Read-only, and it changes **no** decision: the rules render it into a prompt
   * and nothing gates on it. That is the whole of what it may be — a remedy is an
   * agent's account of its own run, and a dispatch that turned on one would be
   * the fleet deciding what to work from what it said about itself.
   *
   * Absent/empty means nothing has been accounted for yet, which is every
   * deployment until an agent files the first one, and every prompt is then
   * byte-identical to a build without the feature.
   */
  priorRemedies?: Remedy[];
  /**
   * The fleet reviews already recorded (`Store.listPrReviews`), which is how rule
   * `pr-review` knows a pull request has been read and how `pr-merge-ready` knows
   * it may propose.
   *
   * Absent means no reading was wired, and it is the *safe* absence only because
   * the rule is off by default: with `review.enabled` on and this unwired, every
   * pull request would look unreviewed forever, which is a review dispatched
   * every cycle. The composition root wires it beside every other store read for
   * that reason; a caller building a context by hand and turning the review on
   * has to as well.
   */
  prReviews?: PrReview[];
  /**
   * How the triage decided each pull request should be read
   * (`Store.listPrReviewRoutes`). Absent means nothing was wired, and every
   * review then runs the fail-open default mode — which is the safe direction,
   * and the same one a triage that never answered produces.
   */
  prReviewRoutes?: PrReviewRoute[];
  /**
   * The review's intake ledger (`Store.prReviewIntake`) — which open pull requests
   * the review is for, as against which were already open when a project switched
   * it on.
   *
   * **Absent means an empty ledger, and therefore no pull request within the
   * intake at all**: rule `pr-review` proposes nothing and the merge gate holds
   * nothing. That is the safe absence in both directions at once, and it is the
   * direction chosen deliberately — the alternative, reading an unwired ledger as
   * "everything is ours", is the backfill this exists to prevent, arrived at by
   * forgetting a wire. The existing suite is the floor under it: a pull request
   * appearing while the review is on is asserted to be reviewed on that pulse, so
   * a composition root that stopped stamping goes red rather than quiet.
   */
  prReviewIntake?: PrReviewIntake;
  /** Current fleet: running / waiting / recently-finished tasks and their agents. */
  tasks: TaskSummary[];
  agents: Agent[];
  openEscalations: Escalation[];
  /**
   * Operator-launched jobs still awaiting a slot, oldest first. Drained before
   * any world-driven rule so a manual request takes priority for the next free
   * slot; the rest stay queued when the fleet is at capacity.
   */
  queuedJobs: Job[];
  /**
   * Live jobs that stand in for another origin's work — a crash recovery's
   * requeue, whose `originRef` is the `issue:41:retro` (or `pr:42:ci`) the
   * original dispatch was keyed on. Folded into `activeOrigins`, so the rule that
   * produced the original does not dispatch it again while the requeue redoes it.
   * Absent/empty means nothing is being redone.
   */
  standingJobs?: Job[];
  /**
   * Every persisted plan, keyed by its `issue:<n>` origin — the planning funnel's
   * memory. Absent/empty means no issue has a verdict yet; with the funnel off it
   * stays empty for good and every issue routes straight to pickup.
   */
  plans?: Plan[];
  /**
   * Every plan's parts — the scheduling graph rule `plan-part` walks. Reconciliation has
   * already folded git and provider reality onto these rows *this* cycle, so a part
   * that became ready during the pulse is dispatchable in the same pulse.
   */
  planParts?: PlanPart[];
  /**
   * Every plan's validation checks — how anyone checks the *goal* was met. Rule
   * `validate-check` is the only reader, and it reads exactly two things off a
   * check: that the operator handed it to the fleet, and that nobody has
   * recorded a reading against it. What a check *says* changes no dispatch, for
   * `retrospectiveOrigins`' reason one line up. Absent/empty means nothing has
   * been handed over, which is every deployment until somebody does.
   */
  validationChecks?: ValidationCheck[];
  /**
   * Operator "Up next" priority overrides (issue #128), keyed on candidate
   * origin. Applied ahead of the natural cross-rule ranking but behind rule `manual-job`
   * and behind every `held` verdict, so an override changes *order* only —
   * never whether a cooldown, cap, ignore tag or unapproved plan holds an item.
   * Absent/empty means the natural ranking stands.
   */
  priorityOverrides?: PriorityOverride[];
  /**
   * The goals the operator marked a priority. Every origin under a flagged goal —
   * its pickup, its plan, its parts, its appraisal, its assessor, its validation checks
   * and the pull requests its branches opened — ranks ahead of the natural order and
   * ahead of a `priorityOverrides` drag, behind rule `manual-job` only.
   *
   * Ordering and nothing else, exactly as an override is: a cooldown, a cap, an
   * unapproved plan or an ignore tag holds a flagged goal's work where it holds
   * anything else's. Absent/empty means the natural ranking stands.
   */
  goalPriorities?: GoalPriority[];
  /**
   * The operator's per-origin answer to "run this one on that profile"
   * read from the queue rather than from a ticket. Highest
   * precedence in the pin chain: it beats the goal's tag and the plan's part
   * profile, because it is the narrowest and latest statement — somebody looking
   * at this row, now.
   *
   * Pricing only, exactly as the two above are ordering only: an override never
   * un-holds a held candidate and never lifts one over the headroom cut.
   * Absent/empty means every dispatch resolves on its pin or its rule.
   */
  profileOverrides?: ProfileOverride[];
  /**
   * Standing "is this issue finished" verdicts, keyed on the `issue:<n>` origin —
   * declared by the agent that worked the issue (`conclude_work`) or toggled by
   * an operator. Read by rule `work-item-back-to-pickup`, which returns a reviewed item to pickup only on
   * an explicit `more_work`. Absent/empty resolves every issue to `undeclared`,
   * which holds the item rather than releasing it: a review state does not say
   * whether the work is done, so silence must not read as "not done" (see
   * `src/issueConclusion.ts`).
   */
  conclusions?: IssueConclusion[];
  /**
   * Standing `delivered` verdicts, keyed on the same `issue:<n>` origin — the
   * harness's own park, written by the assessor or the operator. Unlike a
   * conclusion this **gates pickup**: rule `issue-pickup` skips an issue whose verdict still
   * stands. Absent/empty means nothing is parked, which is every deployment until
   * an issue is assessed (see `src/delivery/delivery.ts`).
   */
  deliveries?: IssueDelivery[];
  /**
   * World transitions on the issues carrying a standing delivery verdict, since
   * the oldest of them. What ends a park on a provider with no work-item states,
   * narrowed by `deliverySignalQuery` so it is empty until an issue is assessed.
   * Absent = nothing observed, which holds every verdict.
   */
  deliverySignals?: WorldEvent[];
  /**
   * Standing "worked, and the goal is not reached" verdicts, keyed on the same
   * `issue:<n>` origin — the assessor's negative arm (issue #159). Unlike a
   * delivery this **gates nothing**: rule `issue-shortfall` is its one consumer,
   * and what it does is route the failure the assessor named — a replan, a
   * follow-up part, or a human. Absent/empty means nothing has fallen short, which
   * is every deployment until an assessment says so.
   */
  shortfalls?: IssueShortfall[];
  /**
   * Standing goal-appraisal verdicts, keyed on the same `issue:<n>` origin — whether an
   * issue's text can be worked from at all (issue #158). An `unclear` verdict gates
   * the funnel in front of the issue: rules `issue-plan` and `issue-pickup` skip it while the verdict
   * stands. Absent/empty means nothing has been appraised, which holds nothing — the
   * fail-open that makes the gate safe (see `src/intake/appraisal.ts`).
   */
  appraisals?: IssueAppraisal[];
  /**
   * The issues that already have a retrospective — **origins only, never the
   * writing**. Rule `issue-retro` needs to know whether to dispatch one and that is the whole
   * of what it may know: a rule branching on retrospective prose would let one
   * agent's account of a run change what the harness schedules next, which is the
   * reason nothing reads the scratchpad at all. Absent/empty means none has been
   * written, which holds nothing.
   */
  retrospectiveOrigins?: string[];
  /**
   * World transitions on the issues carrying a standing `unclear` verdict, since
   * the oldest of them. One of the two things that ends such a hold (the other is
   * the ticket's own text changing, which needs no read). Narrowed by
   * `appraisalSignalQuery`, so it is empty until an issue is actually refused.
   */
  appraisalSignals?: WorldEvent[];
  /**
   * Where every Feature's work stands right now, as `featureStandingKey` digests
   * it — number, title and key, and **never a word of what anybody wrote**. Rule
   * `feature-summary` compares the key to {@link featureSummaryKeys} and that is
   * the whole of what it may know, `retrospectiveOrigins`' rule: a rule branching
   * on summary prose would let one agent's account of a Feature change what the
   * harness schedules next.
   *
   * Absent/empty means the deployment has no feature board — no flag, or a tracker
   * with no hierarchy to roll up — and nothing is ever summarised, which is the
   * safe absence: the whole feature is off rather than dispatching against a
   * digest nobody built.
   */
  featureStandings?: { number: number; title: string; key: string }[];
  /**
   * The key each Feature's standing summary was written against — origins and
   * digests, on the same terms as the readings above. Absent/empty means none has
   * been written, which holds nothing and summarises every Feature once.
   */
  featureSummaryKeys?: { originRef: string; standingKey: string }[];
  /** How many more agents may be started this cycle (concurrency headroom). */
  agentHeadroom: number;
  /** Recent audit decisions, so a persistent PR signal isn't re-notified to an agent every cycle. */
  recentDecisions: Decision[];
  /**
   * Acts already put to a human (issue #109), newest first. A rule that proposed
   * an act must not propose it again while the human's verdict stands, or the
   * inbox fills with duplicates of one question — see `proposalHold`. Absent/empty
   * means nothing has been proposed, which is every deployment until one is.
   */
  proposals?: Proposal[];
  /**
   * World transitions on the items a standing rejection concerns, since the
   * oldest of those rejections (issue #109 phase 4). A "no" stands until its item
   * changes, and this is what the gate reads to notice that it has — narrowed by
   * `rejectionSignalQuery`, so it is empty until an operator rejects something.
   * Absent = nothing observed, which holds every rejection: the direction that
   * refuses rather than acts.
   */
  rejectionSignals?: WorldEvent[];
}

/**
 * One ranked agent-dispatch candidate from a cycle's plan — the "Up next" queue
 * (issue #69). A projection, not a persisted FIFO: the dispatcher recomputes it
 * from the world every cycle, so it's "what's next as of this pulse".
 */
export interface QueueItem {
  origin: string;
  /** The dispatcher rule that raised the candidate (a DISPATCH_RULES key). */
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  /**
   * Where the candidate sits relative to the headroom cut — dispatched this
   * cycle, or held for one of the named reasons in `HeldReason`. Every
   * reason a candidate can be held for appears here rather than causing it to
   * vanish: a proposal held by something other than capacity used to be skipped
   * silently, which made the thing holding it invisible.
   */
  status: QueueStatus;
  reason: string;
  /**
   * This row belongs to a goal the operator marked a priority, which is why it is
   * where it is. Shipped as a fact rather than re-derived in the browser, and
   * shipped at all because an ordering nothing explains is the same queue with a
   * wrong-looking answer: the flag is set on a goal, the row names an origin, and
   * without this nothing on the panel connects the two.
   *
   * Absent rather than `false` when it is not, so an unflagged row is the row it
   * was before goal priority existed.
   */
  expedited?: boolean;
  /**
   * The `agentModels` profile this candidate would launch on, resolved by the
   * same chain the dispatch itself is stamped from — so the queue names what will
   * actually run rather than a second opinion about it.
   *
   * Null on a deployment with no `agentModels`, and on a rule with no entry and no
   * `default`: both are "no `--model` flag at all", which is a fact about the run
   * and not a profile. The cockpit draws no control where there is nothing to
   * choose between.
   */
  profile?: string | null;
  /**
   * Which level of the chain named {@link QueueItem.profile}. Shipped rather than
   * re-derived in the browser for the reason `expedited` is: the row is the only
   * place an operator can see that this dispatch is priced by something other
   * than its rule, and a pin that reads as ordinary policy is the invisible half
   * of the feature.
   */
  profileSource?: ProfileSource;
  /**
   * The operator's own standing override for this origin, when there is one — the
   * value the cockpit's picker binds to, and the only one of the three pin levels
   * a click on this row can clear.
   *
   * Separate from {@link QueueItem.profile} because they answer different
   * questions: that one is "what will run", which an override may not even win
   * (a name config no longer configures falls through to the rule). This one is
   * "what did I say", which the control has to show to be clearable at all.
   */
  override?: string;
}

export interface DispatchResult extends ParseResult {
  /** Free-form reasoning the dispatcher produced, kept for the audit trail. */
  rationale: string;
  /**
   * The full ordered pickup plan, including candidates below the headroom cut.
   * Optional because a decision procedure need not rank what it did not pick;
   * {@link RuleDispatcher} always materialises one, so `Harness.upcoming` is null
   * only before the first cycle.
   */
  upcoming?: QueueItem[];
}

/**
 * Decides what the harness should do this cycle: full state in, a validated,
 * bounded action plan out. {@link RuleDispatcher} is the one implementation —
 * deterministic and fully testable. This stays an interface because it is the
 * seam the whole pulse is written against: `Harness` takes a `Dispatcher`, never
 * the class, so what decides can be swapped without the cycle knowing.
 */
export interface Dispatcher {
  decide(ctx: DispatchContext): Promise<DispatchResult>;
}
