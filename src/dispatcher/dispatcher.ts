import type {
  Agent,
  Decision,
  Escalation,
  Job,
  Plan,
  PlanPart,
  Proposal,
  PullRequest,
  Task,
  WorldSnapshot,
} from '../types.js';
import type { ParseResult } from './actions.js';
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
   * Every plan's parts — the scheduling graph rule 4a walks. Reconciliation has
   * already folded git and provider reality onto these rows *this* cycle, so a part
   * that became ready during the pulse is dispatchable in the same pulse.
   */
  planParts?: PlanPart[];
  /** Optional operator hints, injected only as a corrective. */
  steeringPriorities: string[];
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
   * Where the candidate sits relative to the headroom cut: dispatched this
   * cycle, waiting on a free slot, throttled by the re-dispatch cooldown,
   * `capped` — held by a per-plan concurrency limit rather than by fleet
   * headroom, so it would not dispatch even with every slot free — or
   * `unapproved`, held because its plan's decomposition is still a proposal you
   * have not accepted (`planning.requireApproval`). Both of the latter two exist
   * for the same reason: a part held by something other than capacity used to be
   * skipped silently, which made the thing holding it invisible.
   */
  status: 'dispatching' | 'waiting' | 'cooldown' | 'capped' | 'unapproved';
  reason: string;
}

export interface DispatchResult extends ParseResult {
  /** Free-form reasoning the dispatcher produced, kept for the audit trail. */
  rationale: string;
  /**
   * The full ordered pickup plan, including candidates below the headroom cut.
   * Only the rule dispatcher materialises one; the LLM dispatcher omits it.
   */
  upcoming?: QueueItem[];
}

/**
 * Decides what the harness should do this cycle: full state in, a validated,
 * bounded action plan out. Two implementations ship: a deterministic
 * {@link RuleDispatcher} (the safe default, fully testable) and a
 * {@link ClaudeDispatcher} that drives a real Claude Code session.
 */
export interface Dispatcher {
  decide(ctx: DispatchContext): Promise<DispatchResult>;
}
