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
    const a = d.action;
    if (
      (a.type === 'dispatch_code_agent' ||
        a.type === 'dispatch_desk_agent' ||
        a.type === 'update_pr_branch' ||
        a.type === 'requeue_ci_check') &&
      a.originRef === origin
    ) {
      attempts += 1;
      const t = Date.parse(d.createdAt);
      if (!Number.isNaN(t) && t > lastAttemptMs) lastAttemptMs = t;
    } else if (a.type === 'escalate_to_human') {
      const context = a.context as { originRef?: unknown } | undefined;
      if (context && context.originRef === origin) escalated = true;
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
