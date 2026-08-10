import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import type { Worktrees } from './worktree/worktreeManager.js';
import type { WorldSnapshot } from './types.js';
import { reapableBranches } from './branchReap.js';

interface BranchReapDeskDeps {
  sink: ActionSink;
  store: Store;
  /** Git's write side — the local half of the reap. */
  worktrees: Worktrees;
  defaultBranch: string;
  /** `filters.prAuthor` is configured on the active provider — see {@link isOurPr}. */
  prAuthorConfigured: boolean;
  errors?: ErrorRecorder;
}

/**
 * Deletes the branch behind a merged pull request, locally and on the remote.
 *
 * A desk beside {@link PrNamingDesk} rather than an action through the executor,
 * because it is mechanical bookkeeping in exactly the sense renaming and retargeting
 * are: nothing is deciding *whether* to reap, only carrying out a convention the
 * operator configured. So it is deliberately not auto-send gated, and a failure is
 * recorded and never fails the cycle.
 *
 * **Local first, then remote.** A failed remote delete is retried on the next pulse;
 * a failed local delete after the remote copy is already gone leaves nothing to
 * retry against.
 *
 * The `branch_reaps` row is what keeps this from writing every pulse: a merged pull
 * request sits in `closedPullRequests` for `closedPrWindowMs`, so without the record
 * the desk would re-issue a delete for an already-gone branch for six hours.
 */
export class BranchReapDesk {
  constructor(private readonly deps: BranchReapDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const { store, sink, worktrees, errors } = this.deps;
    const wanted = reapableBranches(world.pullRequests, world.closedPullRequests ?? [], {
      defaultBranch: this.deps.defaultBranch,
      prAuthorConfigured: this.deps.prAuthorConfigured,
      tasks: store.listTasks(),
      reaped: store.reapedPrs(),
    });

    for (const { prNumber, branch } of wanted) {
      try {
        await worktrees.deleteBranch(branch);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `deleting local branch ${branch} (PR ${prNumber}) failed: ${(err as Error).message}`,
        });
        continue;
      }
      try {
        await sink.deleteBranch({ branch });
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `deleting remote branch ${branch} (PR ${prNumber}) failed: ${(err as Error).message}`,
        });
        continue;
      }
      store.recordBranchReap(prNumber, branch);
    }
  }
}
