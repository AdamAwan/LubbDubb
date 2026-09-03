import type { ErrorRecorder } from '../errorLog.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import type { PlacementField } from './placement.js';
import type { Store } from '../store/store.js';

/**
 * Settling one of a goal's two placement questions, in one place.
 *
 * The half both cockpit routes share — refuse where nothing can write one, make
 * the write, stamp the row the operator was looking at — lifted out of
 * `src/server/routes/issues.ts` when the desktop channel gained `goal_placement`,
 * on `src/issueWatch.ts`'s terms: two surfaces answering the same question must
 * not each keep their own reading of what answering it means.
 *
 * The refusal is asked of the **connector** rather than inferred from the provider
 * name, exactly as the work-item-state route asks: the one place that decides is
 * the one this asks.
 *
 * The row is stamped **after** a successful write and never before: a stamp on a
 * write that then failed would settle a question nobody answered, and leave the
 * operator with a tracker unchanged and a cockpit that had stopped asking.
 * → `src/intake/placement.ts`
 */
interface PlacementSettleContext {
  store: Pick<Store, 'getAppraisal' | 'settleAppraisalPlacement'>;
  connector: { canPlaceWorkItem(): boolean };
  /** Optional only because the desktop channel's server may be built without one. */
  errors?: ErrorRecorder;
}

type PlacementSettleOutcome = { ok: true; settled: boolean } | { ok: false; error: string };

export async function settlePlacement(
  ctx: PlacementSettleContext,
  issueNumber: number,
  field: PlacementField,
  write: () => Promise<void>,
): Promise<PlacementSettleOutcome> {
  if (!ctx.connector.canPlaceWorkItem())
    return { ok: false, error: "This deployment's tracker has no parent or area path to set." };
  try {
    await write();
  } catch (err) {
    const message = (err as Error).message;
    ctx.errors?.record({ source: 'server', message: `Failed to place #${issueNumber}: ${message}` });
    return { ok: false, error: message };
  }
  const origin = issueConclusionOrigin(issueNumber);
  const appraisal = ctx.store.getAppraisal(origin);
  const settled = appraisal !== null && ctx.store.settleAppraisalPlacement(origin, appraisal.goalRef, field);
  return { ok: true, settled };
}
