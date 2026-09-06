import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import type { Worktrees } from './worktree/worktreeManager.js';
import type { WorldSnapshot } from './types.js';
import { reapableBranches } from './branchReap.js';

// → docs/spec/09-execution.md

interface BranchReapDeskDeps {
  sink: ActionSink;
  store: Store;
  worktrees: Worktrees;
  defaultBranch: string;
  prAuthorConfigured: boolean;
  errors?: ErrorRecorder;
}

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
