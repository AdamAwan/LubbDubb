import type { Config } from '../../src/config/config.js';
import type { System } from '../../src/system.js';
import { WorktreeManager } from '../../src/worktree/worktreeManager.js';

export function pinnedPool(
  config: Config,
  size: number,
): { worktrees: WorktreeManager; attach: (system: System) => void } {
  let system: System | null = null;
  const worktrees = new WorktreeManager(
    config.repoRoot,
    config.worktreeRoot,
    {
      // Mirrors the composition root: a slot is held by a live task on the branch or
      // by an ejection holding it, and the bound grows with the ejections.
      get size() {
        return size + (system?.store.ejections.liveEjections().length ?? 0);
      },
      held: (branch) =>
        system !== null &&
        (system.store.tasks.findActiveTaskByBranch(branch) !== null ||
          system.store.ejections.ejectionOnBranch(branch) !== null),
    },
    config.localRunRoot,
  );
  return {
    worktrees,
    attach: (s) => {
      system = s;
    },
  };
}
