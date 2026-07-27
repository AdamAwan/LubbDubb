import type { Agent, Task } from '../types.js';

/**
 * Crash recovery, the pure half.
 *
 * A restart kills every agent. Until now the harness decided on its own what to
 * do about that: {@link file://../system.ts}'s boot reconciler resumed whatever
 * looked resumable and quietly buried the rest as `interrupted`, then the boot
 * cycle dispatched new work on top. Both halves of that are decisions an operator
 * would want a say in — a resumed agent picks up a conversation whose last turn
 * nobody has read, and a buried one silently loses work that was minutes from a
 * PR — and neither was ever put to anyone.
 *
 * So detection and the *verdict* are now separate: this module says what died and
 * what may be done about it, {@link file://./recoveryDesk.ts} applies the choice,
 * and the harness holds its pulse until every choice is made (see
 * {@link file://../harness.ts}). Nothing here touches the store, the fleet or the
 * clock — it is the classification, so it is testable on rows alone.
 */

/** What an operator can do with an agent that did not survive the last run. */
export type RecoveryVerdict = 'restore' | 'requeue' | 'remove';

const VERDICTS: RecoveryVerdict[] = ['restore', 'requeue', 'remove'];

/** Boundary check for the verdict arriving off the wire. */
export function isRecoveryVerdict(value: unknown): value is RecoveryVerdict {
  return typeof value === 'string' && (VERDICTS as string[]).includes(value);
}

/**
 * The agent statuses a *dead* process can have left behind on a row.
 *
 * `starting`/`running`/`waiting` are a crash — the row still claims the agent is
 * live because nothing got the chance to write otherwise. `interrupted` is a
 * graceful shutdown (`AgentManager.interruptAll`), which is the same situation
 * arrived at politely: the work is unfinished and the process is gone. `crashed`
 * is a detection that has already happened and is still awaiting its verdict, so
 * including it here is what makes {@link RecoveryDesk.detect} idempotent across
 * a second restart.
 *
 * `killed`, `done` and `failed` are deliberately absent: each is a *decided*
 * ending. A cockpit kill in particular must stay dead — resurrecting it every
 * boot is precisely the bug the old reconciler's task check existed to avoid.
 */
const ORPHAN_STATUSES: Agent['status'][] = ['starting', 'running', 'waiting', 'interrupted', 'crashed'];

/** Task statuses that mean the work this agent was doing is still outstanding. */
function isTaskOutstanding(task: Task): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting';
}

/**
 * Is this agent row an orphan of a previous run whose work is still outstanding?
 *
 * Both halves matter. The status says the process died without an ending; the
 * task says the work still wants doing. An agent whose task has already been
 * settled (`interrupted` by a previous recovery, `done`, `failed`) is history,
 * not a decision — which is what stops a "remove" verdict re-appearing on the
 * next boot.
 */
export function isRecoveryCandidate(agent: Agent, task: Task | null): boolean {
  return task != null && ORPHAN_STATUSES.includes(agent.status) && isTaskOutstanding(task);
}

/**
 * Whether **restore** can be offered for this orphan, and if not, why not in the
 * operator's words.
 *
 * Restore means re-attaching to the *same* Claude conversation (`claude --resume
 * <session id>`) in the *same* worktree, so it needs all three of: a runtime that
 * pins a session id (PTY only — stream-JSON resume does not exist), the id itself
 * on the row, and the worktree still on disk. The reason is carried rather than
 * inferred at the UI, because "why is this button missing" is exactly the question
 * an operator asks of a screen that is blocking their fleet.
 */
export function restorability(
  agent: Agent,
  opts: { resumable: boolean; worktreeExists: boolean },
): { restorable: boolean; blocked: string | null } {
  if (!opts.resumable)
    return { restorable: false, blocked: 'this agent runtime cannot resume a session (PTY runtime only)' };
  if (!agent.sessionId) return { restorable: false, blocked: 'the agent has no Claude session id to resume' };
  if (!opts.worktreeExists) return { restorable: false, blocked: `its working directory is gone (${agent.cwd})` };
  return { restorable: true, blocked: null };
}

/** One crashed agent as the cockpit and the API see it. */
export interface CrashedAgent {
  agentId: string;
  taskId: string;
  /** The task's title — what this agent was actually doing. */
  title: string;
  kind: Task['kind'];
  originRef: string | null;
  branch: string | null;
  cwd: string;
  /**
   * How the run ended: `crashed` — the row still claimed to be live, so nothing
   * got the chance to write an ending — or `interrupted`, a graceful shutdown.
   * The pair is read straight off the row's status, which is why detection leaves
   * an already-`interrupted` row alone rather than restamping every orphan: the
   * distinction is worth keeping and needs no column to keep it. Whether the agent
   * was *parked on a question* when it went is {@link CrashedAgent.waitingReason}.
   */
  died: 'crashed' | 'interrupted';
  /** The question it was parked on, when it was parked on one. */
  waitingReason: string | null;
  /** Its last `note_progress` line — the best one-line account of how far it got. */
  note: string | null;
  startedAt: string;
  /** When the crash was detected (the row's `endedAt`), not when the process actually died — nothing observed that. */
  detectedAt: string | null;
  restorable: boolean;
  restoreBlocked: string | null;
}

/** Fold an orphan row pair plus its restorability into the shape the API ships. */
export function describeCrash(
  agent: Agent,
  task: Task,
  restore: { restorable: boolean; blocked: string | null },
): CrashedAgent {
  return {
    agentId: agent.id,
    taskId: task.id,
    title: task.title,
    kind: task.kind,
    originRef: task.originRef,
    branch: task.branch,
    cwd: agent.cwd,
    died: agent.status === 'interrupted' ? 'interrupted' : 'crashed',
    waitingReason: agent.waitingReason,
    note: agent.note,
    startedAt: agent.startedAt,
    detectedAt: agent.endedAt,
    restorable: restore.restorable,
    restoreBlocked: restore.blocked,
  };
}

/** How much of the original prompt a requeued job carries before it is elided. */
const MAX_PROMPT = 8000;

/**
 * The job a **requeue** verdict files: the same work, from the top, with a fresh
 * agent and no memory of the crashed one.
 *
 * It is a job (rule 0) rather than a reset task, and that is forced rather than
 * chosen. A task left `queued` with no agent is *active* to every gate in the
 * dispatcher — `activeOrigins`, `findActiveTaskByOrigin`, `findActiveTaskByBranch`
 * all count it — so parking the work there would wedge its origin and its branch
 * shut for good, and nothing would ever dispatch it. Retiring the task and queueing
 * a job instead reuses the one path that already exists for "an operator asked for
 * this to be done": it takes the next free slot ahead of world-driven work, it is
 * visible in the job list and the Up next queue, and the executor's branch gate
 * defers it rather than colliding if the branch is meanwhile busy.
 *
 * The cost, stated: the job's origin is `job:<id>`, so the link back to `pr:42:ci`
 * (or whatever dispatched the original) is provenance in the prompt rather than a
 * ref the gates key on. That is why the preamble names the origin explicitly — a
 * fresh agent reading this needs to know it is redoing work, and which work.
 */
export function requeueJobRequest(agent: Agent, task: Task): { title: string; prompt: string } {
  const about = task.originRef ? ` (${task.originRef})` : '';
  const prompt = [
    `An earlier agent was working this task${about} and its process did not survive a harness restart. ` +
      'An operator chose to requeue the work rather than resume that conversation, so you are starting ' +
      'fresh: assume nothing about how far the previous run got.',
    task.branch
      ? `Its branch \`${task.branch}\` may already carry commits from that run — read the branch before you ` +
        'change anything, and continue from what is there rather than redoing it.'
      : null,
    agent.note ? `The previous agent's last reported progress was: "${agent.note}"` : null,
    '',
    'The original task, verbatim:',
    '',
    task.prompt.length > MAX_PROMPT ? `${task.prompt.slice(0, MAX_PROMPT)}\n…[truncated]` : task.prompt,
  ]
    .filter((line) => line !== null)
    .join('\n');
  return { title: `Requeued: ${task.title}`.slice(0, 120), prompt };
}
