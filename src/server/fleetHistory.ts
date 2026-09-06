import type { Agent, TaskSummary } from '../types.js';

// → docs/spec/18-observability.md

export const ENDED_AGENT_TAIL = 200;

interface FleetHistory {
  agents: Agent[];
  tasks: TaskSummary[];
  ended: number;
}

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
