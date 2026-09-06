import type { Agent, Task } from '../types.js';

/**
 * Crash recovery, the pure half: what died and what may be done about it.
 * {@link file://./recoveryDesk.ts} applies the operator's choice; nothing here touches the
 * store, the fleet or the clock. The unit of recovery is the task, and the agent is optional
 * throughout: a restart between `createTask` and `spawn` leaves a task with no agent row, which
 * still reads as active to every dispatcher gate and so wedges its origin and branch shut for
 * good. → `docs/spec/10-agent-runtimes.md#crash-recovery`
 */

/** What an operator can do with work that did not survive the last run. */
export type RecoveryVerdict = 'restore' | 'requeue' | 'remove';

const VERDICTS: RecoveryVerdict[] = ['restore', 'requeue', 'remove'];

/** Boundary check for the verdict arriving off the wire. */
export function isRecoveryVerdict(value: unknown): value is RecoveryVerdict {
  return typeof value === 'string' && (VERDICTS as string[]).includes(value);
}

/** The agent statuses a dead process can have left on a row. `crashed` is included so {@link RecoveryDesk.detect} is idempotent across a second restart. `killed`, `done` and `failed` are deliberately absent — each is a decided ending. */
const ORPHAN_STATUSES: Agent['status'][] = ['starting', 'running', 'waiting', 'interrupted', 'crashed'];

/** Task statuses that mean the work this task describes is still outstanding. */
function isTaskOutstanding(task: Task): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting';
}

/** Is this agent row an orphan of a previous run whose work is still outstanding? Both halves matter: an agent whose task has already settled is history, not a decision, so a verdict doesn't re-appear on the next boot. */
export function isRecoveryCandidate(agent: Agent, task: Task | null): boolean {
  return task != null && ORPHAN_STATUSES.includes(agent.status) && isTaskOutstanding(task);
}

/**
 * Is this task orphaned with no agent row at all — created by a dispatch the restart caught
 * before it spawned? The `bootedAt` fence is load-bearing: a live dispatch is transiently
 * agentless between `createTask` and `spawn`, so without it a pulse could park work an executor
 * is midway through starting. `hasAgent` must be asked of the agent rows, never of
 * `task.agentId`, which `spawn` back-fills a sliver of time late. → `docs/spec/10-agent-runtimes.md#detection`
 */
export function isAgentlessCandidate(task: Task, opts: { hasAgent: boolean; bootedAt: string }): boolean {
  return !opts.hasAgent && isTaskOutstanding(task) && task.createdAt < opts.bootedAt;
}

/** Whether restore can be offered for this orphan, and if not, why not in the operator's words. Needs all four of: an agent, a resumable runtime, a session id on the row, and the worktree still on disk. */
export function restorability(
  agent: Agent | null,
  opts: { resumable: boolean; worktreeExists: boolean },
): { restorable: boolean; blocked: string | null } {
  if (!agent)
    return { restorable: false, blocked: 'no agent ever started for this task, so there is no session to resume' };
  if (!opts.resumable)
    return { restorable: false, blocked: 'this agent runtime cannot resume a session (the raw runtime keeps no id)' };
  if (!agent.sessionId) return { restorable: false, blocked: 'the agent has no Claude session id to resume' };
  if (!opts.worktreeExists) return { restorable: false, blocked: `its working directory is gone (${agent.cwd})` };
  return { restorable: true, blocked: null };
}

/** One piece of orphaned work as the cockpit and the API see it. */
export interface OrphanedWork {
  /** The identity — the only thing every candidate has; the route, the card key and {@link RecoveryDesk.decide} all key on it. */
  taskId: string;
  /** Null when the restart landed before the agent was ever spawned. */
  agentId: string | null;
  /** The task's title — what was actually being done. */
  title: string;
  kind: Task['kind'];
  originRef: string | null;
  branch: string | null;
  /** The agent's working directory; null when no agent ever started. */
  cwd: string | null;
  /** How the run ended: `crashed` (the row still claimed to be live), `interrupted` (a graceful shutdown) or `never_started`. Read off the row's status, so detection leaves an already-`interrupted` row alone. */
  died: 'crashed' | 'interrupted' | 'never_started';
  /** The question it was parked on, when it was parked on one. */
  waitingReason: string | null;
  /** Its last `note_progress` line — the best one-line account of how far it got. */
  note: string | null;
  /** When the agent started, or when the task was recorded if none ever did. */
  startedAt: string;
  /** When the crash was detected (the row's `endedAt`), not when the process actually died — nothing observed that. */
  detectedAt: string | null;
  restorable: boolean;
  restoreBlocked: string | null;
}

/** Fold an orphan (a task, and the agent that was on it if there was one) into the shape the API ships. */
export function describeOrphan(
  agent: Agent | null,
  task: Task,
  restore: { restorable: boolean; blocked: string | null },
): OrphanedWork {
  return {
    taskId: task.id,
    agentId: agent?.id ?? null,
    title: task.title,
    kind: task.kind,
    originRef: task.originRef,
    branch: task.branch,
    cwd: agent?.cwd ?? null,
    died: !agent ? 'never_started' : agent.status === 'interrupted' ? 'interrupted' : 'crashed',
    waitingReason: agent?.waitingReason ?? null,
    note: agent?.note ?? null,
    startedAt: agent?.startedAt ?? task.createdAt,
    detectedAt: agent?.endedAt ?? null,
    restorable: restore.restorable,
    restoreBlocked: restore.blocked,
  };
}

/** How much of the original prompt a requeued job carries before it is elided. */
const MAX_PROMPT = 8000;

/**
 * The job a requeue verdict files: the same work, from the top, with a fresh agent and no memory
 * of the crashed one. A job rather than a reset task, because a `queued` task with no agent
 * reads as active to every dispatcher gate and would wedge its origin and branch shut. The link
 * back to the original dispatch rides on `Job.originRef`; without it the rule that produced the
 * original dispatches the same work again. `prior` is null when no agent ever ran — the two arms
 * can't be collapsed: after a crash the branch may carry commits a fresh agent must read first,
 * whereas a task whose agent never spawned has had nothing done to it.
 * → `docs/spec/10-agent-runtimes.md#the-three-verdicts`
 */
export function requeueJobRequest(
  task: Task,
  prior: { note: string | null } | null,
): { title: string; prompt: string } {
  const about = task.originRef ? ` (${task.originRef})` : '';
  const preamble = prior
    ? [
        `An earlier agent was working this task${about} and its process did not survive a harness restart. ` +
          'An operator chose to requeue the work rather than resume that conversation, so you are starting ' +
          'fresh: assume nothing about how far the previous run got.',
        task.branch
          ? `Its branch \`${task.branch}\` may already carry commits from that run — read the branch before you ` +
            'change anything, and continue from what is there rather than redoing it.'
          : null,
        prior.note ? `The previous agent's last reported progress was: "${prior.note}"` : null,
      ]
    : [
        `This task${about} was recorded by a dispatch that a harness restart caught before its agent was ` +
          'ever started, so no work was done on it at all. An operator chose to requeue it.',
        task.branch
          ? `It was to be worked on branch \`${task.branch}\`, which may not exist yet — treat it as new work.`
          : null,
      ];
  const prompt = [
    ...preamble,
    '',
    'The original task, verbatim:',
    '',
    task.prompt.length > MAX_PROMPT ? `${task.prompt.slice(0, MAX_PROMPT)}\n…[truncated]` : task.prompt,
  ]
    .filter((line) => line !== null)
    .join('\n');
  return { title: `Requeued: ${task.title}`.slice(0, 120), prompt };
}
