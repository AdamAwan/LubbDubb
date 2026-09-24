import type { Action, Decision } from '../types.js';

// → docs/spec/05-dispatcher.md

export interface CooldownPolicy {
  maxAttempts: number;
  cooldownMs: number;
}

export const DEFAULT_COOLDOWN: CooldownPolicy = { maxAttempts: 3, cooldownMs: 15 * 60_000 };

export type DispatchVerdict =
  | { kind: 'dispatch' }
  | { kind: 'cooldown' }
  | { kind: 'escalate'; attempts: number }
  | { kind: 'hold' };

const ATTEMPT_TYPES: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'dispatch_code_agent',
  'dispatch_desk_agent',
  'update_pr_branch',
  'requeue_ci_check',
]);

export function dispatchVerdict(
  origin: string,
  now: string,
  recentDecisions: Decision[],
  policy: CooldownPolicy,
): DispatchVerdict {
  let attempts = 0;
  let lastAttemptMs = -Infinity;
  let escalated = false;

  for (const d of recentDecisions) {
    if (d.outcome !== 'executed') continue;
    if (isAttempt(d.action, origin)) {
      attempts += 1;
      const t = Date.parse(d.createdAt);
      if (!Number.isNaN(t) && t > lastAttemptMs) lastAttemptMs = t;
    } else if (isEscalation(d.action, origin)) {
      escalated = true;
    }
  }

  if (attempts >= policy.maxAttempts) {
    return escalated ? { kind: 'hold' } : { kind: 'escalate', attempts };
  }
  const nowMs = Date.parse(now);
  if (lastAttemptMs !== -Infinity && !Number.isNaN(nowMs) && nowMs - lastAttemptMs < policy.cooldownMs) {
    return { kind: 'cooldown' };
  }
  return { kind: 'dispatch' };
}

function isAttempt(a: Action, origin: string): boolean {
  return ATTEMPT_TYPES.has(a.type) && a.originRef === origin;
}

function isEscalation(a: Action, origin: string): boolean {
  if (a.type !== 'escalate_to_human') return false;
  const context = a.context as { originRef?: unknown } | undefined;
  return context?.originRef === origin;
}
