import type { Agent, Decision, Escalation, Task, WorldSnapshot } from '../types.js';
import type { ParseResult } from './actions.js';

/** Everything the dispatcher gets to look at when deciding what to do this cycle. */
export interface DispatchContext {
  world: WorldSnapshot;
  /** Current fleet: running / waiting / recently-finished tasks and their agents. */
  tasks: Task[];
  agents: Agent[];
  openEscalations: Escalation[];
  /** Optional operator hints, injected only as a corrective. */
  steeringPriorities: string[];
  /** How many more agents may be started this cycle (concurrency headroom). */
  agentHeadroom: number;
  /** Recent audit decisions, so a persistent PR signal isn't re-notified to an agent every cycle. */
  recentDecisions: Decision[];
}

export interface DispatchResult extends ParseResult {
  /** Free-form reasoning the dispatcher produced, kept for the audit trail. */
  rationale: string;
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
