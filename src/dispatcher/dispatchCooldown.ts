import type { Decision } from '../types.js';

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

const ATTEMPT_TYPES: ReadonlySet<string> = new Set([
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
    if (isAttempt(d, origin)) {
      attempts += 1;
      const t = Date.parse(d.createdAt);
      if (!Number.isNaN(t) && t > lastAttemptMs) lastAttemptMs = t;
    } else if (isEscalation(d, origin)) {
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

function isAttempt(d: Decision, origin: string): boolean {
  const a = d.action;
  return ATTEMPT_TYPES.has(a.type) && 'originRef' in a && a.originRef === origin;
}

function isEscalation(d: Decision, origin: string): boolean {
  if (d.action.type !== 'escalate_to_human') return false;
  const context = d.action.context as { originRef?: unknown } | undefined;
  return context?.originRef === origin;
}
