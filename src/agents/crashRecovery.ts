import type { Agent, Task } from '../types.js';

// → docs/spec/10-agent-runtimes.md

export type RecoveryVerdict = 'restore' | 'requeue' | 'remove';

const VERDICTS: RecoveryVerdict[] = ['restore', 'requeue', 'remove'];

export function isRecoveryVerdict(value: unknown): value is RecoveryVerdict {
  return typeof value === 'string' && (VERDICTS as string[]).includes(value);
}

const ORPHAN_STATUSES: Agent['status'][] = ['starting', 'running', 'waiting', 'interrupted', 'crashed'];

function isTaskOutstanding(task: Task): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting';
}

export function isRecoveryCandidate(agent: Agent, task: Task | null): boolean {
  return task != null && ORPHAN_STATUSES.includes(agent.status) && isTaskOutstanding(task);
}

export function isAgentlessCandidate(task: Task, opts: { hasAgent: boolean; bootedAt: string }): boolean {
  return !opts.hasAgent && isTaskOutstanding(task) && task.createdAt < opts.bootedAt;
}

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

export interface OrphanedWork {
  taskId: string;
  agentId: string | null;
  title: string;
  kind: Task['kind'];
  originRef: string | null;
  branch: string | null;
  cwd: string | null;
  died: 'crashed' | 'interrupted' | 'never_started';
  waitingReason: string | null;
  note: string | null;
  startedAt: string;
  detectedAt: string | null;
  restorable: boolean;
  restoreBlocked: string | null;
}

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

const MAX_PROMPT = 8000;

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
