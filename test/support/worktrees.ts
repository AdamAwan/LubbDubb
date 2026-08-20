import type { Config } from '../../src/config.js';
import type { System } from '../../src/system.js';
import { WorktreeManager } from '../../src/worktree/worktreeManager.js';

/**
 * The real manager on a **fixed** bound, for the tests whose subject is a slot
 * going back to the pool.
 *
 * The pool the composition root builds is sized off the live agent cap and nothing
 * else, so a pool of one — the only size at which "the released slot is the one
 * handed out next" is observable, since a pool with room to grow mints a fresh slot
 * instead — is reachable only by constructing the manager here and injecting it.
 * `held` reads the store the system has not built yet, hence `attach`: the lease's
 * durable half is exactly what one of these tests is about, so it cannot be stubbed
 * out to `false`.
 */
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
