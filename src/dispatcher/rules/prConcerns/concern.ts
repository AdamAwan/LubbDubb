import type { Decision } from '../../../types.js';
import type { DispatchRuleId } from '../../rules.js';
import type { RawAction } from '../context.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export interface PrConcern {
  rule: DispatchRuleId;
  origin: string;
  act?: RawAction;
  dispatch?: { branch: string; base: string; readOnly: true };
  profile?: string;
  title: string;
  prompt: string;
  dispatchReason: string;
  note: string;
  originTitle: string;
  originSummary: string;
  urgent?: boolean;
  signals?: PrSignal[];
  ciChecks?: string[];
}

interface PrSignal {
  ref: string;
  note: string;
}

export function signalsOf(concern: PrConcern): PrSignal[] {
  return concern.signals ?? [{ ref: concern.origin, note: concern.note }];
}

export function directActUnperformed(
  type: 'update_pr_branch' | 'requeue_ci_check',
  origin: string,
  decisions: Decision[],
): boolean {
  return decisions.some(
    (d) =>
      d.action.type === type && d.action.originRef === origin && (d.outcome === 'skipped' || d.outcome === 'rejected'),
  );
}
