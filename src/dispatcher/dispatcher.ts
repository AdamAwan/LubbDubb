import type { Agent, Decision, Escalation, Job, Task, WorldSnapshot } from '../types.js';
import type { ParseResult } from './actions.js';
import type { DispatchRuleId } from './rules.js';

/** Everything the dispatcher gets to look at when deciding what to do this cycle. */
export interface DispatchContext {
  world: WorldSnapshot;
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
  /** Optional operator hints, injected only as a corrective. */
  steeringPriorities: string[];
  /** How many more agents may be started this cycle (concurrency headroom). */
  agentHeadroom: number;
  /** Recent audit decisions, so a persistent PR signal isn't re-notified to an agent every cycle. */
  recentDecisions: Decision[];
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
   * cycle, waiting on a free slot, or throttled by the re-dispatch cooldown.
   */
  status: 'dispatching' | 'waiting' | 'cooldown';
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
