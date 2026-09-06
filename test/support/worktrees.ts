import type { Config } from '../../src/config.js';
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
    { size, held: (branch) => system !== null && system.store.findActiveTaskByBranch(branch) !== null },
    config.localRunRoot,
  );
  return {
    worktrees,
    attach: (s) => {
      system = s;
    },
  };
}
