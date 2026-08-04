import type {
  Agent,
  Decision,
  Escalation,
  IssueConclusion,
  IssueAssay,
  IssueDelivery,
  IssueShortfall,
  Job,
  Plan,
  PlanPart,
  PriorityOverride,
  Proposal,
  PullRequest,
  Task,
  WorldEvent,
  WorldSnapshot,
} from '../types.js';
import type { ParseResult } from './actions.js';
import type { QueueStatus } from './admission.js';
import type { DispatchRuleId } from './rules.js';

/** Everything the dispatcher gets to look at when deciding what to do this cycle. */
export interface DispatchContext {
  world: WorldSnapshot;
  /**
   * Open PRs the operator's `-ignore` tag hid from `world.pullRequests`. No rule
   * *acts* on them — that's the point of the tag — but they're still open, so gates
   * that must not read "absent from the world" as "merged" (issue pickup, the
   * work-item state back-off) resolve against these too. Absent/empty = nothing hidden.
   */
  excludedPrs?: PullRequest[];
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
  /** Current fleet: running / waiting / recently-finished tasks and their agents. */
  tasks: Task[];
  agents: Agent[];
  openEscalations: Escalation[];
  /**
   * Operator-launched jobs still awaiting a slot, oldest first. Drained before
   * any world-driven rule so a manual request takes priority for the next free
   * slot; the rest stay queued when the fleet is at capacity.
   */
  queuedJobs: Job[];
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
   * Operator "Up next" priority overrides (issue #128), keyed on candidate
   * origin. Applied ahead of the natural cross-rule ranking but behind rule `manual-job`
   * and behind every `held` verdict, so an override changes *order* only —
   * never whether a cooldown, cap, ignore tag or unapproved plan holds an item.
   * Absent/empty means the natural ranking stands.
   */
  priorityOverrides?: PriorityOverride[];
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
   * Standing goal-assay verdicts, keyed on the same `issue:<n>` origin — whether an
   * issue's text can be worked from at all (issue #158). An `unclear` verdict gates
   * the funnel in front of the issue: rules `issue-plan` and `issue-pickup` skip it while the verdict
   * stands. Absent/empty means nothing has been assayed, which holds nothing — the
   * fail-open that makes the gate safe (see `src/intake/assay.ts`).
   */
  assays?: IssueAssay[];
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
   * `assaySignalQuery`, so it is empty until an issue is actually refused.
   */
  assaySignals?: WorldEvent[];
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
