import type { ErrorLog } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { PlanPart, TaskSummary } from '../types.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import { partBranch, partSettled } from './parts.js';

// → docs/spec/08-planning.md

interface PartRestartContext {
  store: Store;
  sink: ActionSink;
  worktrees: Worktrees;
  errors: ErrorLog;
}

export function partRestartRefusal(part: PlanPart, tasks: TaskSummary[], canClosePr: boolean): string | null {
  if (partSettled(part))
    return `"${part.slug}" has already finished as ${part.status} — restarting it would ask the fleet to redo delivered work. Amend the plan and let it declare a new part instead.`;
  if (part.prNumber === null)
    return `"${part.slug}" has no pull request open, so there is nothing to close — it is already scheduled against whatever the plan declares now.`;
  if (liveAgent(part, tasks) !== undefined)
    return `An agent is still working "${part.slug}". End that run first (the agent drawer's Kill), so the restart is not racing the thing it is undoing.`;
  if (!canClosePr)
    return `This provider cannot close a pull request from here, so a restart would leave PR #${part.prNumber} open and the reconciler would put the part straight back into review. Close it there and the part comes back to \`ready\` on its own.`;
  return null;
}

export async function restartPlanPart(
  ctx: PartRestartContext,
  part: PlanPart,
  issueNumber: number,
): Promise<{ ok: true; part: PlanPart; detail: string } | { ok: false; error: string }> {
  const { store, sink, worktrees, errors } = ctx;
  const prNumber = part.prNumber;
  if (prNumber === null) return { ok: false, error: `"${part.slug}" has no pull request to close.` };
  const done: string[] = [];

  try {
    await sink.closePr({ prNumber });
    done.push(`closed PR #${prNumber}`);
  } catch (err) {
    const message = (err as Error).message;
    errors.record({
      source: 'server',
      message: `Failed to close PR #${prNumber} restarting plan part "${part.slug}": ${message}`,
    });
    return { ok: false, error: message };
  }

  const branch = part.branch ?? partBranch(issueNumber, part.slug);
  try {
    await worktrees.deleteBranch(branch);
    done.push(`dropped the local branch ${branch} and released its worktree slot`);
  } catch (err) {
    const message = (err as Error).message;
    errors.record({
      source: 'server',
      message: `Failed to delete local branch ${branch} restarting plan part "${part.slug}": ${message}`,
    });
    done.push(
      `could not drop the local branch ${branch} (${message}) — the next dispatch will find the old commits on it`,
    );
  }

  try {
    await sink.deleteBranch({ branch });
    done.push('deleted it on the remote');
  } catch (err) {
    const message = (err as Error).message;
    errors.record({
      source: 'server',
      message: `Failed to delete remote branch ${branch} restarting plan part "${part.slug}": ${message}`,
    });
    done.push(
      `could not delete ${branch} on the remote (${message}) — delete it there before the part is dispatched again`,
    );
  }

  const updated = store.updatePlanPart(part.id, { status: 'ready', prNumber: null, branch: null });
  if (!updated) return { ok: false, error: `plan part "${part.slug}" is gone` };
  done.push('put the part back to ready, so the plan schedules it again against the current declaration');
  return { ok: true, part: updated, detail: done.join('; ') };
}

function liveAgent(part: PlanPart, tasks: TaskSummary[]): TaskSummary | undefined {
  const active = (t: TaskSummary): boolean => t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
  return tasks.find((t) => active(t) && (t.id === part.taskId || (part.branch !== null && t.branch === part.branch)));
}
