import type { ErrorRecorder } from '../errorLog.js';
import type { QueueItem } from '../dispatcher/dispatcher.js';
import type { Worktrees } from './worktreeManager.js';

// → docs/spec/09-execution.md#warming-a-slot-ahead-of-the-dispatch

interface PrewarmDeps {
  worktrees: Worktrees;
  upcoming: () => QueueItem[];
  enabled: () => boolean;
  errors: ErrorRecorder;
}

/**
 * Readies one pool slot between cycles, so the dispatch that wants it finds `ensure` on its
 * reuse-first path instead of paying for a wipe and a cold checkout on the serial executor loop.
 *
 * @public — driven from `cycle:end` in {@link buildSystem}, and never awaited by a cycle: the whole
 * point is that the wait happens where nothing is queued behind it.
 */
export class PrewarmDesk {
  private inFlight = false;

  constructor(private readonly deps: PrewarmDeps) {}

  run(): void {
    if (this.inFlight || !this.deps.enabled()) return;
    this.inFlight = true;
    void this.pass()
      .catch((err: Error) => {
        // A slot that could not be readied is not a dispatch that failed: the next `ensure` pays
        // the cost it would have paid anyway. Recorded, never escalated.
        this.deps.errors.record({
          source: 'cycle',
          message: `Could not warm a worktree slot ahead of the next dispatch: ${err.message}`,
          detail: 'The dispatch that wants the slot prepares it itself, as it did before warming existed.',
        });
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private async pass(): Promise<void> {
    await this.deps.worktrees.prewarm(warmable(this.deps.upcoming()));
  }
}

function warmable(upcoming: QueueItem[]): string[] {
  const branches: string[] = [];
  for (const item of upcoming) {
    if (item.kind !== 'code' || item.branch === null) continue;
    if (item.status === 'unapproved' || item.status === 'superseded') continue;
    if (!branches.includes(item.branch)) branches.push(item.branch);
  }
  return branches;
}
