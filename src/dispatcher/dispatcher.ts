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
  /** Open PRs hidden from `world.pullRequests` — no watch tag, or a colleague's (`src/prOwnership.ts`). No rule acts on either, but gates that must not read "absent" as "merged" resolve against these too. Absent/empty = nothing hidden. */
  hiddenPrs?: PullRequest[];
  /**
   * Which of `world.issues` are **retained runs**: a goal the harness worked
   * whose ticket the tracker no longer returns. Listed so `issue-assess` and
   * `issue-retro` can finish after the delivering PR closed the ticket — every
   * other rule must skip them in its own body. Absent/empty means every issue
   * came from the connector.
   */
  retainedIssues?: number[];
  /** What a dispatch needs to resolve its pinned profile: the tag prefix and the profiles those tags may name. Absent means no dispatch is ever pinned. */
  modelPins?: { labelPrefix: string; models: AgentModels };
  /** The most recent accounts of why the fleet came back to a pull request, newest first — appended to a fresh dispatch's prompt. Read-only: nothing may gate on it. Absent/empty means nothing accounted for yet. */
  priorRemedies?: Remedy[];
  /** The fleet reviews already recorded (`Store.listPrReviews`) — how `pr-review` knows a PR has been read and `pr-merge-ready` that it may propose. Absent is safe only because the rule is off by default. */
  prReviews?: PrReview[];
  /** How the triage decided each pull request should be read (`Store.listPrReviewRoutes`). Absent means every review runs the fail-open default mode. */
  prReviewRoutes?: PrReviewRoute[];
  /** Pull requests an external check reported already reviewed. Absent reads as none — the safe direction: a wasted agent rather than a diff nobody looked at. */
  prReviewedElsewhere?: ReadonlySet<number>;
  /** Current fleet: running / waiting / recently-finished tasks and their agents. */
  tasks: TaskSummary[];
  agents: Agent[];
  openEscalations: Escalation[];
  /** Operator-launched jobs still awaiting a slot, oldest first. Drained before any world-driven rule. */
  queuedJobs: Job[];
  /** Live jobs standing in for another origin's work — a crash recovery's requeue. Folded into `activeOrigins` so the original's rule does not dispatch it again. Absent/empty means nothing is being redone. */
  standingJobs?: Job[];
  /** Every persisted plan, keyed by `issue:<n>` origin. Absent/empty means no issue has a verdict yet; with the funnel off every issue routes straight to pickup. */
  plans?: Plan[];
  /** Every plan's parts — the scheduling graph rule `plan-part` walks. Reconciliation has already folded git/provider reality onto these rows this cycle. */
  planParts?: PlanPart[];
  /** Changes proposed to plans already running, still waiting on an operator. Rule `plan-amendment` is the only reader. Absent/empty means nobody has proposed one. */
  planAmendments?: PlanAmendment[];
  /** Every plan's validation checks. Rule `validate-check` reads only that the operator handed it to the fleet and nobody has recorded a reading — what a check says changes no dispatch. Absent/empty means nothing handed over. */
  validationChecks?: ValidationCheck[];
  /** The local run up on the operator's machine, or absent for none. Read only by rule `local-validation`. → [23](docs/spec/23-local-runs.md) */
  localRun?: LocalRun | null;
  /** Local validations the pipeline still has something to do about — open, and failed with no fix yet. Absent/empty means nobody has pressed the button. */
  localValidations?: LocalValidation[];
  /** Operator "Up next" priority overrides, keyed on candidate origin. Applied ahead of natural ranking but behind rule `manual-job` and every `held` verdict — order only. Absent/empty means natural ranking stands. */
  priorityOverrides?: PriorityOverride[];
  /** Goals the operator marked a priority. Every origin under a flagged goal ranks ahead of natural order, behind rule `manual-job` only. Ordering only — a cooldown, cap, unapproved plan or ignore tag still holds it. */
  goalPriorities?: GoalPriority[];
  /** The operator's per-origin "run this one on that profile" answer. Highest precedence in the pin chain — beats the goal tag and part profile. Pricing only: never un-holds or lifts a candidate over the headroom cut. */
  profileOverrides?: ProfileOverride[];
  /** Standing "is this issue finished" verdicts, keyed on `issue:<n>` origin. Read by `work-item-back-to-pickup`, which returns an item only on explicit `more_work`. Absent/empty resolves to `undeclared`, which **holds** the item. → `src/issueConclusion.ts` */
  conclusions?: IssueConclusion[];
  /** Standing `delivered` verdicts, same origin. Unlike a conclusion this **gates pickup**: `issue-pickup` skips an issue whose verdict stands. Absent/empty means nothing parked. → `src/delivery/delivery.ts` */
  deliveries?: IssueDelivery[];
  /** World transitions on issues carrying a standing delivery verdict, since the oldest of them — what ends a park on a provider with no work-item states. Absent = nothing observed, which holds every verdict. */
  deliverySignals?: WorldEvent[];
  /** Standing "worked, goal not reached" verdicts, same origin. Gates nothing: rule `issue-shortfall` is the one consumer and routes the failure the assessor named. Absent/empty means nothing fell short. */
  shortfalls?: IssueShortfall[];
  /** Standing goal-appraisal verdicts, same origin — can this issue's text be worked from at all. An `unclear` verdict gates the funnel: `issue-plan` and `issue-pickup` skip it while it stands. Absent/empty holds nothing (fail-open). → `src/intake/appraisal.ts` */
  appraisals?: IssueAppraisal[];
  /** Issues that already have a retrospective — origins only, never the writing: a rule branching on retrospective prose would let an agent's own account change what gets scheduled next. Absent/empty holds nothing. */
  retrospectiveOrigins?: string[];
  /** World transitions on issues carrying a standing `unclear` verdict, since the oldest — one of the two things that ends such a hold (the other is the ticket text changing). */
  appraisalSignals?: WorldEvent[];
  /** Where every Feature's work stands right now — number, title and digest key, never a word of what anybody wrote. Absent/empty means no feature board. */
  featureStandings?: { number: number; title: string; key: string }[];
  /** The key each Feature's standing summary was written against. Absent/empty means none written, which holds nothing and summarises every Feature once. */
  featureSummaryKeys?: { originRef: string; standingKey: string }[];
  /**
   * Every story order on file — the key rule `feature-sequence` compares
   * against, and the edges the `accepted` ones hold work with. One list rather
   * than two reads, so the proposing rule and the enforcing gate cannot
   * disagree about what is on file. Absent/empty means no Feature has an order.
   * → `docs/spec/33-story-sequencing.md`
   */
  featureSequences?: FeatureSequence[];
  /** The obstacle board — every row with its keys, voice count and reporting goals. Read by rule `obstacle-repair` and the priority expansion. Absent/empty means no repair is ever proposed. */
  obstacles?: ObstacleStanding[];
  /** Goals parked behind an obstacle. **Gates pickup**: an issue whose block stands is not eligible for the funnel. Absent/empty means nothing parked. */
  obstacleBlocks?: ObstacleBlock[];
  /** How many more agents may be started this cycle (concurrency headroom). */
  agentHeadroom: number;
  /** Recent audit decisions, so a persistent PR signal isn't re-notified to an agent every cycle. */
  recentDecisions: Decision[];
  /** Acts already put to a human, newest first. A rule must not re-propose an act while its verdict stands — see `proposalHold`. Absent/empty means nothing proposed. */
  proposals?: Proposal[];
  /** World transitions on items a standing rejection concerns, since the oldest — a "no" stands until its item changes. Absent = nothing observed, which holds every rejection. */
  rejectionSignals?: WorldEvent[];
}

/** One ranked agent-dispatch candidate from a cycle's plan — the "Up next" queue. A projection, not a persisted FIFO: recomputed from the world every cycle. */
export interface QueueItem {
  origin: string;
  /** The dispatcher rule that raised the candidate (a DISPATCH_RULES key). */
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  /** Where the candidate sits relative to the headroom cut — dispatched, or held for a named `HeldReason`. Every hold appears here rather than making the candidate vanish. */
  status: QueueStatus;
  reason: string;
  /** This row belongs to a goal the operator marked a priority — shipped as a fact rather than re-derived in the browser. Absent rather than `false`. */
  expedited?: boolean;
  /** The `agentModels` profile this candidate would launch on. Null means no `--model` flag — no `agentModels` configured, or a rule with no entry and no `default`. */
  profile?: string | null;
  /** Which level of the chain named {@link QueueItem.profile} — the only place an operator sees the dispatch is priced by something other than its rule. */
  profileSource?: ProfileSource;
  /** The operator's own standing override for this origin — what the cockpit's picker binds to. Separate from {@link QueueItem.profile} ("what will run"), which an override may not even win. */
  override?: string;
}

export interface DispatchResult extends ParseResult {
  /** Free-form reasoning the dispatcher produced, kept for the audit trail. */
  rationale: string;
  /** The full ordered pickup plan, including candidates below the headroom cut. Optional — {@link RuleDispatcher} always materialises one, so `Harness.upcoming` is null only before the first cycle. */
  upcoming?: QueueItem[];
}

/** Decides what the harness should do this cycle: full state in, a validated, bounded action plan out. {@link RuleDispatcher} is the one implementation. */
export interface Dispatcher {
  decide(ctx: DispatchContext): Promise<DispatchResult>;
}
