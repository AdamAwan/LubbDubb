import type { ErrorLog } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { PlanPart, TaskSummary } from '../types.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import { partBranch, partSettled } from './parts.js';

/**
 * Everything a restart touches beyond the store. Not exported: the one caller
 * passes an object literal, and a name nothing imports is a name knip is right
 * about.
 */
interface PartRestartContext {
  store: Store;
  /** The outbound seam — the close and the remote branch delete both go through it. */
  sink: ActionSink;
  /** The write side of git: the lease and the local ref. */
  worktrees: Worktrees;
  errors: ErrorLog;
}

/**
 * Why this part cannot be restarted, in the operator's own terms, or null when it
 * can be.
 *
 * Pure and separate from the act, because it is asked twice: the route refuses on
 * it with a 400, and it is the shape a surface would need to explain itself. Each
 * sentence names the reason rather than the rule — an operator reading "cannot
 * restart" learns nothing about what to do instead.
 */
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

/**
 * Take a plan part with an in-flight pull request back to the start — the
 * operator's answer to "this PR is building the plan we just amended".
 *
 * An amendment deliberately stops nothing (`src/plans/planAmendment.ts`): ingestion
 * merges on slug, so a part whose scope was rewritten keeps its branch, its pull
 * request and its status, and the agent on it carries on implementing the
 * superseded declaration. The design says to end that run yourself if it should
 * end — and until this existed, "yourself" meant closing the pull request by hand
 * on the provider and deleting the branch by hand beside it.
 *
 * **It is never automatic, and that is the design.** Applying an amendment does not
 * reach here. Closing a reviewable pull request on the strength of a diff in a
 * scope field is outward-facing and effectively irreversible — somebody may be
 * halfway through reviewing it — so the harness offers the act and an operator
 * makes it.
 *
 * Three writes, and skipping any one of them makes the whole thing a no-op or
 * worse:
 *
 * 1. **The pull request is closed.** `observePartPr`'s first reading is "an open PR
 *    on the branch → `in_review`", so a part row reset on its own is put back by the
 *    reconciler on the very next pulse.
 * 2. **The branch is dropped**, through `Worktrees.deleteBranch` — the lease *and*
 *    the local ref — and then on the remote. `WorktreeManager.ensure` is reuse-first,
 *    so a branch left standing hands the re-dispatched agent the commits the
 *    amendment just invalidated, as its own starting point.
 * 3. **The part row goes back to `ready` with `prNumber` cleared**, which is what
 *    makes rule `plan-part` schedule it again against the amended declaration.
 *
 * → `docs/spec/08-planning.md#restarting-a-part`
 *
 * Assumes {@link partRestartRefusal} has already passed — the caller is the one
 * holding the reply, and a refusal is a returned value there rather than a throw
 * here.
 *
 * **The close comes first and is the only step allowed to abort the rest.** It is
 * the write on somebody else's system, the one that can fail for reasons the
 * harness cannot see, and it is what the reset depends on: a part handed back to
 * the fleet while its pull request is still open is a part the reconciler drags
 * back into review, having deleted its branch. Everything after it is reported
 * rather than fatal, and the row is written **last**, so nothing is dispatched
 * until every step that could hold it back has been attempted.
 */
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
    // Nothing else has run, so the part is exactly where it was: the operator can
    // close the pull request themselves and press this again.
    return { ok: false, error: message };
  }

  // The branch the part actually worked on, falling back to the one its slug
  // implies — a part dispatched by an older build may carry no branch, and the
  // name is derived rather than stored anyway.
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

  // And the remote copy, for the reason the local one goes: the re-dispatched agent
  // cuts its branch afresh from the base, and a remote branch still carrying the
  // superseded commits refuses that push as a non-fast-forward. Best effort, as
  // `BranchReapDesk`'s is, and reported either way.
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

  // Last, and the only write that hands the part back to the fleet. `branch` is
  // cleared with the number: nothing stands on that ref any more, and the next
  // dispatch derives the same name from the slug.
  const updated = store.updatePlanPart(part.id, { status: 'ready', prNumber: null, branch: null });
  if (!updated) return { ok: false, error: `plan part "${part.slug}" is gone` };
  done.push('put the part back to ready, so the plan schedules it again against the current declaration');
  return { ok: true, part: updated, detail: done.join('; ') };
}

/** The task an agent is still running for this part, or undefined. */
function liveAgent(part: PlanPart, tasks: TaskSummary[]): TaskSummary | undefined {
  const active = (t: TaskSummary): boolean => t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
  // By task *and* by branch: the row's `taskId` names the run the part started, and
  // a re-dispatch onto the same branch writes a second task row the part never
  // learned about (`docs/spec/10-agent-runtimes.md`). Either one is an agent whose
  // worktree this restart is about to delete.
  return tasks.find((t) => active(t) && (t.id === part.taskId || (part.branch !== null && t.branch === part.branch)));
}
