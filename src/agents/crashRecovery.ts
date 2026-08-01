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
 *
 * **What is orphaned is the *work*, not the process.** A restart can also land
 * between `store.createTask` and `agents.spawn` inside `ActionExecutor.execute`,
 * which leaves a task row with no agent row at all — and that is the *worse* case,
 * because such a task is `queued`, which is `active` to `activeOrigins`,
 * `findActiveTaskByOrigin` and `findActiveTaskByBranch` alike. Its origin and its
 * branch are then wedged shut for good, and the dispatcher reports "nothing
 * actionable" forever against an idle fleet. So the unit of recovery is the task
 * and the agent is optional throughout: see {@link isAgentlessCandidate}.
 */

/** What an operator can do with work that did not survive the last run. */
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

/** Task statuses that mean the work this task describes is still outstanding. */
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
 * Is this task orphaned with **no agent row at all** — created by a dispatch the
 * restart caught before it spawned?
 *
 * **Why there is no stamp here, unlike the agent half.** `crashed` exists on an
 * agent row because that row *lied*: it said `running` with no process behind it,
 * so something had to be written to stop it counting as live. A `queued` task with
 * no agent tells the truth about itself; what was missing was anyone reading it.
 * And there is no honest status to move it to: every task status that is not
 * outstanding is *terminal* to the three gates above, so a new one would either go
 * on wedging the origin (if it stayed active) or force every gate, present and
 * future, to learn a fourth state to describe a row nobody has decided about yet.
 * So the candidate set is **computed** from what the rows already say, and both
 * verdicts available here settle the task — which is what removes it from the set,
 * makes `detect()` idempotent, and survives a second restart with nothing persisted.
 *
 * **`bootedAt` is the one thing that cannot be read off a row, and it is load-bearing.**
 * The pending set is re-derived on *every pulse* (the hold asks for it), and a live
 * dispatch is transiently agentless for exactly the width of the window this feature
 * exists to clean up after: between `createTask` and `spawn`. Without the fence a
 * cycle could park work an executor is midway through starting. A task created before
 * this process booted cannot be that: it belongs to a run that is over. The fence is a
 * constant for the life of the process, so two readings of the set never disagree, and
 * a second restart simply moves it forward — an orphan from run 1 is still older than
 * run 3's boot.
 *
 * `hasAgent` is asked of the agent *rows*, not of `task.agentId`. `AgentManager.spawn`
 * writes the agent row first and back-fills `task.agentId` after, so the column is null
 * for a sliver of time in which an agent genuinely exists — and reading it would put the
 * same work in the pending set twice, once down each arm.
 */
export function isAgentlessCandidate(task: Task, opts: { hasAgent: boolean; bootedAt: string }): boolean {
  return !opts.hasAgent && isTaskOutstanding(task) && task.createdAt < opts.bootedAt;
}

/**
 * Whether **restore** can be offered for this orphan, and if not, why not in the
 * operator's words.
 *
 * Restore means re-attaching to the *same* Claude conversation (`claude --resume
 * <session id>`) in the *same* worktree, so it needs all four of: an agent to have
 * existed at all, a runtime that pins a session id (PTY only — stream-JSON resume
 * does not exist), the id itself on the row, and the worktree still on disk. The
 * reason is carried rather than inferred at the UI, because "why is this button
 * missing" is exactly the question an operator asks of a screen that is blocking
 * their fleet.
 *
 * The agentless arm comes first because it makes the other three moot: there is no
 * runtime that could resume a conversation nobody ever had.
 */
export function restorability(
  agent: Agent | null,
  opts: { resumable: boolean; worktreeExists: boolean },
): { restorable: boolean; blocked: string | null } {
  if (!agent)
    return { restorable: false, blocked: 'no agent ever started for this task, so there is no session to resume' };
  if (!opts.resumable)
    return { restorable: false, blocked: 'this agent runtime cannot resume a session (PTY runtime only)' };
  if (!agent.sessionId) return { restorable: false, blocked: 'the agent has no Claude session id to resume' };
  if (!opts.worktreeExists) return { restorable: false, blocked: `its working directory is gone (${agent.cwd})` };
  return { restorable: true, blocked: null };
}

/** One piece of orphaned work as the cockpit and the API see it. */
export interface OrphanedWork {
  /**
   * The task is the identity, because it is the only thing every candidate has.
   * The route, the cockpit's card key and {@link RecoveryDesk.decide} all key on
   * this rather than on the agent id: the unit of recovery is the work, and an
   * agent is one thing that may or may not have been attached to it.
   */
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
  /**
   * How the run ended: `crashed` — the row still claimed to be live, so nothing
   * got the chance to write an ending — `interrupted`, a graceful shutdown, or
   * `never_started`, a task the restart caught before its agent was spawned. The
   * first pair is read straight off the row's status, which is why detection leaves
   * an already-`interrupted` row alone rather than restamping every orphan: the
   * distinction is worth keeping and needs no column to keep it. Whether the agent
   * was *parked on a question* when it went is {@link OrphanedWork.waitingReason}.
   */
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
 * The job a **requeue** verdict files: the same work, from the top, with a fresh
 * agent and no memory of the crashed one.
 *
 * It is a job (rule `manual-job`) rather than a reset task, and that is forced rather than
 * chosen. A task left `queued` with no agent is *active* to every gate in the
 * dispatcher — `activeOrigins`, `findActiveTaskByOrigin`, `findActiveTaskByBranch`
 * all count it — so parking the work there would wedge its origin and its branch
 * shut for good, and nothing would ever dispatch it. (That is not a hypothetical:
 * it is the exact state {@link isAgentlessCandidate} exists to find.) Retiring the
 * task and queueing a job instead reuses the one path that already exists for "an
 * operator asked for this to be done": it takes the next free slot ahead of
 * world-driven work, it is visible in the job list and the Up next queue, and the
 * executor's branch gate defers it rather than colliding if the branch is meanwhile
 * busy.
 *
 * The cost, stated: the job's origin is `job:<id>`, so the link back to `pr:42:ci`
 * (or whatever dispatched the original) is provenance in the prompt rather than a
 * ref the gates key on. That is why the preamble names the origin explicitly — a
 * fresh agent reading this needs to know it is redoing work, and which work.
 *
 * `prior` is the agent that was on the task, or **null** when none ever ran. The
 * two arms say materially different things and cannot be collapsed: after a crash
 * the branch may carry commits a fresh agent must read before touching anything,
 * whereas a task whose agent never spawned has had *nothing* done to it, and telling
 * an agent otherwise sends it looking for work that was never started.
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
