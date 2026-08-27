import type { Agent, TaskSummary } from '../types.js';

/**
 * How many ended agents the snapshot carries.
 *
 * The same discipline `decisions`, `worldEvents` and `errors` already have, put
 * on the two collections that never had it: `agents` and `tasks` were all-time
 * reads over tables nothing deletes from, so they grew for the life of a
 * deployment and were re-serialised on every `dirty` — which rides every file an
 * agent writes. A hundred rows per feed is the house cap; this one is higher
 * because the fleet's ended list is the one an operator scrolls.
 * → `docs/spec/16-http-api.md#bulk-collections`
 */
export const ENDED_AGENT_TAIL = 200;

/** What the fleet section ships, and what it left behind. */
interface FleetHistory {
  /** Every live agent, and the tail of ended ones — newest first, as read. */
  agents: Agent[];
  /** The tasks those agents were dispatched on, and no others. */
  tasks: TaskSummary[];
  /** How many agents have ended in all, whether or not they are above. */
  ended: number;
}

/**
 * The slice of the fleet the snapshot carries.
 *
 * **Every live agent, whatever the cap.** The bound is on history, and an agent
 * that is out is not history: dropping one because the fleet has been busy would
 * take a running row off the console, which is the one surface that must never
 * be a sample.
 *
 * The tail is ordered by when each agent *ended*, not by when it started — a
 * long run that finished this morning is more recent history than a short one
 * dispatched after it and finished last week, and started-at ordering would drop
 * exactly the runs an operator is looking for. What comes back is still in the
 * input's newest-first order, which is what every reader of `agents` assumes
 * (`buildGoalPage` reads the first match as "the last run of this part").
 *
 * `tasks` is narrowed to the agents kept rather than capped on its own, because
 * every cockpit read of a task starts from an agent — `taskFor(agent)`,
 * `agentOnBranch`, `agentOnGoal`, the needs-you rows. A task row shipped with no
 * agent to reach it from is a row nothing can draw.
 */
export function fleetHistory(
  agents: readonly Agent[],
  tasks: readonly TaskSummary[],
  tail: number = ENDED_AGENT_TAIL,
): FleetHistory {
  const ended = agents.filter((a) => a.endedAt !== null);
  const kept = new Set(
    [...ended]
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(0, tail)
      .map((a) => a.id),
  );
  const shipped = agents.filter((a) => a.endedAt === null || kept.has(a.id));
  const taskIds = new Set(shipped.map((a) => a.taskId));
  return { agents: shipped, tasks: tasks.filter((t) => taskIds.has(t.id)), ended: ended.length };
}
