import type { Store } from '../store/store.js';
import type { IssueDelivery, IssueInstruction } from '../types.js';

// → docs/spec/24-environments.md

type OverruleOutcome =
  | { ok: true; delivery: IssueDelivery; instruction: IssueInstruction }
  | { ok: false; error: string };

export function overruleShortfall(store: OverruleStore, originRef: string, text: string): OverruleOutcome {
  if (!store.verdicts.getShortfall(originRef)) return { ok: false, error: 'no standing shortfall to overrule' };
  const delivery = store.verdicts.recordDelivery({ originRef, summary: text, by: 'operator' });
  const instruction = store.instructions.addIssueInstruction({ originRef, text });
  return { ok: true, delivery, instruction };
}

type OverruleStore = Pick<Store, 'verdicts' | 'instructions'>;
