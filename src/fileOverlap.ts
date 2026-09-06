import type { Agent, AgentFile, AgentStatus, TaskSummary } from './types.js';

// → docs/spec/09-execution.md

interface OverlapWriter {
  agentId: string;
  taskId: string;
  originRef: string | null;
  originTitle: string | null;
  branch: string | null;
  status: AgentStatus;
  at: string;
}

export interface FileOverlap {
  path: string;
  writers: OverlapWriter[];
  sameWorktree: boolean;
  live: boolean;
}

interface Writer extends OverlapWriter {
  start: number;
  end: number;
}

export const OVERLAP_AGENT_WINDOW = 200;

const LIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['starting', 'running', 'waiting']);

function lifetime(agent: Agent): { start: number; end: number } {
  const start = Date.parse(agent.startedAt);
  if (LIVE.has(agent.status)) return { start, end: Number.POSITIVE_INFINITY };
  return { start, end: Date.parse(agent.endedAt ?? agent.startedAt) };
}

export function detectFileOverlaps(input: {
  files: AgentFile[];
  agents: Agent[];
  tasks: TaskSummary[];
}): FileOverlap[] {
  const agents = new Map(input.agents.map((a) => [a.id, a]));
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));

  const byPath = new Map<string, Writer[]>();
  for (const file of input.files) {
    const agent = agents.get(file.agentId);
    const task = agent ? tasks.get(agent.taskId) : undefined;
    if (!agent || !task || task.kind !== 'code') continue;
    const list = byPath.get(file.path) ?? [];
    list.push({
      agentId: agent.id,
      taskId: task.id,
      originRef: task.originRef,
      originTitle: task.originTitle,
      branch: task.branch,
      status: agent.status,
      at: file.createdAt,
      ...lifetime(agent),
    });
    byPath.set(file.path, list);
  }

  const overlaps: FileOverlap[] = [];
  for (const [path, writers] of byPath) {
    if (writers.length < 2) continue;
    const concurrent = writers.filter((w) => writers.some((o) => o.agentId !== w.agentId && overlapping(w, o)));
    if (concurrent.length < 2) continue;
    const sameWorktree = concurrent.some((w) =>
      concurrent.some(
        (o) => o.agentId !== w.agentId && w.branch !== null && w.branch === o.branch && overlapping(w, o),
      ),
    );
    overlaps.push({
      path,
      writers: concurrent.sort((a, b) => b.at.localeCompare(a.at)).map(strip),
      sameWorktree,
      live: concurrent.filter((w) => w.end === Number.POSITIVE_INFINITY).length >= 2,
    });
  }
  return overlaps.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      Number(b.sameWorktree) - Number(a.sameWorktree) ||
      (b.writers[0]?.at ?? '').localeCompare(a.writers[0]?.at ?? ''),
  );
}

function overlapping(a: Writer, b: Writer): boolean {
  return a.start < b.end && b.start < a.end;
}

function strip(w: Writer): OverlapWriter {
  const { start: _start, end: _end, ...rest } = w;
  return rest;
}
