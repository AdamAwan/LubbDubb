import type { Agent, AgentFile, AgentStatus, Task } from './types.js';

/**
 * One agent's write to a path that another agent was writing at the same time.
 * Everything here is provenance the operator needs to judge it: who, working what,
 * on which branch, when — and whether that agent is still going.
 */
interface OverlapWriter {
  agentId: string;
  taskId: string;
  /** What the agent was dispatched to do, so the two writes can be compared as *work*. */
  originRef: string | null;
  originTitle: string | null;
  branch: string | null;
  status: AgentStatus;
  /** When this agent last wrote the path (the file row is deduped per agent+path). */
  at: string;
}

/** A path two or more concurrently-live code agents wrote. */
interface FileOverlap {
  path: string;
  /** Most recent writer first. Always at least two. */
  writers: OverlapWriter[];
  /**
   * The writers shared a branch, so they shared one worktree — literally one file
   * on disk, edited by two live processes. Distinct from the ordinary case (two
   * checkouts of the same repo), and much worse: nothing reconciles it, because
   * there is no merge to reconcile.
   */
  sameWorktree: boolean;
  /** At least two of the writers are still live, so this is happening now. */
  live: boolean;
}

interface Writer extends OverlapWriter {
  /** Agent lifetime, as epoch ms. `end` is Infinity while the agent is alive. */
  start: number;
  end: number;
}

const LIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['starting', 'running', 'waiting']);

/**
 * One agent's lifetime in epoch ms — the single reading of "was it still going",
 * so the concurrency test and the panel's live flag cannot disagree about an
 * agent. Status decides whether the window is open (that is the codebase's
 * liveness signal, the same one `countLiveAgents` uses) and `endedAt` closes it.
 * Every terminal transition in `AgentManager` stamps both together; a dead row
 * that somehow lacks a stamp is closed at its start rather than left running
 * forever, so a data defect under-reports instead of accusing.
 */
function lifetime(agent: Agent): { start: number; end: number } {
  const start = Date.parse(agent.startedAt);
  if (LIVE.has(agent.status)) return { start, end: Number.POSITIVE_INFINITY };
  return { start, end: Date.parse(agent.endedAt ?? agent.startedAt) };
}

/**
 * Find paths that two agents wrote *while both were running* (issue #113).
 *
 * **Why this is a detector and not a `claim` tool.** The dispatcher's collision
 * gates are all keyed on the unit it dispatches — one code agent per PR branch,
 * `findActiveTaskByOrigin`, `maxConcurrentPartsPerIssue`. They are complete for
 * what they see, and for every world-driven rule origin and branch are 1:1, so
 * the origin gate *is* a branch gate. What none of them can see is what an agent
 * does once it is running: two agents on two branches, each perfectly within its
 * own gate, both editing the same file. Git catches that only when the hunks
 * collide; when they don't, the second merge silently undoes or duplicates the
 * first and nothing anywhere says so.
 *
 * An agent-side `claim(path)` would be advisory (an agent that forgets to call it
 * reports nothing), before-the-fact (it has to predict what it will touch), and
 * absent entirely under `mcp.enabled: false`. This reads rows the file-events hook
 * already writes for every agent with no prompt-side knowledge at all, so it cannot
 * be forgotten and does not depend on the tool channel being up. It is after the
 * fact — that is the trade, and it is the right one for a signal whose only honest
 * use is an operator's judgement.
 *
 * Pure, and deliberately narrow about what counts:
 *
 * - **Code tasks only.** A desk agent works in a scratch directory, so its
 *   `notes.md` and another's are different files with one name. Only code agents
 *   write into checkouts of the same repository, so only their paths denote the
 *   same thing.
 * - **Concurrency is the filter, not history.** Two agents that wrote a path at
 *   different times are ordinary: the later one's worktree was cut from a base
 *   that already held the earlier one's work, and review and CI see the rest.
 *   Without this filter every long-lived file in the repo is an "overlap".
 * - **Agent lifetimes, not write timestamps.** A file row is deduped per
 *   (agent, path) and its timestamp is bumped on rewrite, so it dates the *last*
 *   write rather than the first. Overlapping lifetimes is the reading the data
 *   actually supports.
 */
export function detectFileOverlaps(input: { files: AgentFile[]; agents: Agent[]; tasks: Task[] }): FileOverlap[] {
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
    // A writer belongs to the report only if it overlapped *someone*: three agents
    // on one path where only two were ever concurrent is a two-agent collision, and
    // naming the third would be an accusation the data doesn't support.
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
  // Live first — those are the only ones an operator can still act on — then the
  // worst kind, then most recent.
  return overlaps.sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      Number(b.sameWorktree) - Number(a.sameWorktree) ||
      (b.writers[0]?.at ?? '').localeCompare(a.writers[0]?.at ?? ''),
  );
}

/** Half-open lifetime intersection. An agent with no `endedAt` runs to Infinity. */
function overlapping(a: Writer, b: Writer): boolean {
  return a.start < b.end && b.start < a.end;
}

function strip(w: Writer): OverlapWriter {
  const { start: _start, end: _end, ...rest } = w;
  return rest;
}
