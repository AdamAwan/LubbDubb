import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import type { WorldSnapshot } from './types.js';
import { prsToLinkWorkItem, type WorkItemLinkSeed } from './prWorkItemLink.js';

interface PrWorkItemDeskDeps {
  sink: ActionSink;
  store: Store;
  /** `filters.prAuthor` is configured on the active provider — see {@link isOurPr}. */
  prAuthorConfigured: boolean;
  errors?: ErrorRecorder;
}

/**
 * Links every pull request the harness opened to the work item it opened it for.
 *
 * A desk beside {@link PrNamingDesk} and {@link PrWatchDesk} rather than a dispatch
 * rule, and that is the whole point of it. Azure's **Check for linked work items**
 * branch policy blocks a pull request carrying no work-item relation, and before
 * this the only thing that cleared it was a code agent: a model call, a worktree and
 * a context window spent working out a number the harness had on a row. Nothing here
 * decides anything — the work item is {@link issueForPr}'s answer, the same one the
 * rename puts in the title — so it is mechanical bookkeeping in `setWorkItemState`'s
 * sense, deliberately not auto-send gated.
 *
 * A failure is recorded and never fails the cycle: no `pr_work_item_links` row is
 * written, so the next pulse retries, and the policy stays unsatisfied in the
 * meantime exactly as it was before.
 *
 * It is the floor under {@link linkPrWorkItem}, not a duplicate of it: `open_pr`
 * links a pull request the moment it creates one, and this catches every other way
 * one appears on a harness branch — an agent that opened its own after the tool
 * reported itself unwired, a code job's, and everything already open on the pulse a
 * deployment first runs it.
 */
export class PrWorkItemDesk {
  constructor(private readonly deps: PrWorkItemDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const wanted = prsToLinkWorkItem(world.pullRequests, {
      prAuthorConfigured: this.deps.prAuthorConfigured,
      issues: world.issues,
      linked: this.deps.store.linkedWorkItemPrs(),
    });
    for (const seed of wanted) await linkPrWorkItem(seed, this.deps);
  }
}

/**
 * Link one pull request to its work item, and record that it has been linked.
 *
 * The one write path, shared by the desk above and by `open_pr` — `seedPrWatch`'s
 * arrangement, for its reason: two callers would otherwise each hold their own idea
 * of what "the harness links its own pull request" means, and only one of them would
 * be updated when it changed. The row goes down **after** the link write, so a
 * failure leaves the pull request for the next pulse rather than marking it done.
 *
 * **`ok: false` writes no row.** That is the provider saying it does not do relations
 * at all — GitHub, where the `Relates to #12` the tool already appended *is* the
 * link. Recording a row would be the harness claiming credit for a write it never
 * made, and would then suppress the retry if that deployment ever moved to Azure.
 */
export async function linkPrWorkItem(
  seed: WorkItemLinkSeed,
  deps: { sink: ActionSink; store: Store; errors?: ErrorRecorder },
): Promise<void> {
  let result;
  try {
    result = await deps.sink.linkWorkItem({ number: seed.workItemNumber, prNumber: seed.prNumber });
  } catch (err) {
    deps.errors?.record({
      source: 'cycle',
      message:
        `linking PR ${seed.prNumber} to work item #${seed.workItemNumber} failed: ` + `${(err as Error).message}`,
    });
    return;
  }
  if (!result.ok) return;
  deps.store.recordWorkItemLink(seed.prNumber, seed.workItemNumber);
}
