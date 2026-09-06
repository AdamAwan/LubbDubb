import type { Decision, Escalation } from '../types.js';
import { DISPATCH_RULES, type DispatchRuleId } from './rules.js';

// → docs/spec/05-dispatcher.md

type HeldReason = 'cooldown' | 'capped' | 'unapproved' | 'superseded' | 'sequenced' | 'waiting';

export type RuleHeld = Exclude<HeldReason, 'waiting'>;

export type QueueStatus = 'dispatching' | HeldReason;

export function askedAlready(
  originRef: string,
  openEscalations: readonly Escalation[],
  recentDecisions: readonly Decision[],
): boolean {
  if (openEscalations.some((e) => e.context.originRef === originRef)) return true;
  return recentDecisions.some(
    (d) =>
      d.outcome === 'executed' &&
      d.action.type === 'escalate_to_human' &&
      (d.action.context as { originRef?: unknown } | undefined)?.originRef === originRef,
  );
}

export function supersededReason(by: DispatchRuleId, what: string): string {
  return `${what} Held: superseded this cycle by "${DISPATCH_RULES[by].name}", which is asking a question about the same issue.`;
}
