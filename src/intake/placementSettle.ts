import type { ErrorRecorder } from '../errorLog.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import type { PlacementField } from './placement.js';
import type { Store } from '../store/store.js';

// → docs/spec/06-issue-pickup.md

interface PlacementSettleContext {
  store: Pick<Store, 'getAppraisal' | 'settleAppraisalPlacement'>;
  connector: { canPlaceWorkItem(): boolean };
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
