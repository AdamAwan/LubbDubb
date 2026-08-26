import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { WorldSnapshot } from './types.js';
import { renamablePrs } from './prRename.js';
import { retargetsFor } from './prRetarget.js';

interface PrNamingDeskDeps {
  sink: ActionSink;
  /** The integration branch a retargeted rung falls back to. */
  defaultBranch: string;
  /** `filters.prAuthor` is configured on the active provider — see {@link renamablePrs}. */
  prAuthorConfigured: boolean;
  /** The `pr-title` template, already resolved through any operator override. */
  template: string;
  errors?: ErrorRecorder;
}

/**
 * Keeps open pull requests tidy: named to the house convention, and targeting the
 * branch they should still be targeting.
 *
 * A desk beside the plan reconciler and the appraisal desk rather than an action
 * through the executor, because it is mechanical bookkeeping in exactly the sense
 * `set_work_item_state` and the plan's status comment are: nothing is deciding
 * *whether* to rename, only carrying out a convention the operator configured. So
 * it is deliberately not auto-send gated.
 *
 * What keeps it from being noise is that `renamablePrs` is idempotent — it yields
 * only PRs whose rendered title differs from the live one — so a world already on
 * convention costs one comparison per PR per pulse and no writes at all.
 *
 * A failure is recorded and never fails the cycle: a title is cosmetic next to the
 * dispatch decisions this pulse is really for.
 */
export class PrNamingDesk {
  constructor(private readonly deps: PrNamingDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    await this.rename(world);
    await this.retarget(world);
  }

  /**
   * Move a rung whose parent merged onto the parent's own base. GitHub does this
   * itself, so the write is a no-op there; Azure does not, and without it
   * `isStackedPr` holds the rest of the stack back forever.
   */
  private async retarget(world: WorldSnapshot): Promise<void> {
    const { sink, errors } = this.deps;
    const wanted = retargetsFor(world.pullRequests, world.closedPullRequests ?? [], this.deps.defaultBranch);
    for (const input of wanted) {
      try {
        await sink.setPullBase(input);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `retargeting PR ${input.prNumber} onto ${input.base} failed: ${(err as Error).message}`,
        });
      }
    }
  }

  private async rename(world: WorldSnapshot): Promise<void> {
    const { sink, errors } = this.deps;
    const wanted = renamablePrs(world.pullRequests, {
      prAuthorConfigured: this.deps.prAuthorConfigured,
      template: this.deps.template,
      issues: world.issues,
    });
    for (const input of wanted) {
      try {
        await sink.setPullTitle(input);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `renaming PR ${input.prNumber} failed: ${(err as Error).message}`,
        });
      }
    }
  }
}
