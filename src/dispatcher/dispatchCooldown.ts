import type { Decision } from '../types.js';

/**
 * Per-origin dispatch throttle for persistent world concerns.
 *
 * The dispatcher only de-dups against *currently active* tasks, so a code agent
 * that finishes without clearing its concern (couldn't resolve a conflict, needs
 * a human, or GitHub's merge state is still stale — see #35) leaves its origin
 * dispatchable again and gets re-spawned every heartbeat (#36). This adds the
 * missing memory: consult the audit log so a recently-attempted origin cools down
 * instead of looping, and a repeatedly-failing one escalates to a human.
 */
export interface CooldownPolicy {
  /** Dispatches allowed for one origin before we stop looping and escalate. */
  maxAttempts: number;
  /** Minimum gap between two dispatches of the same origin. */
  cooldownMs: number;
}

/** Sensible defaults: three attempts, ~15 min apart, before handing off to a human. */
export const DEFAULT_COOLDOWN: CooldownPolicy = { maxAttempts: 3, cooldownMs: 15 * 60_000 };

/**
 * The verdict for one origin this cycle:
 * - `dispatch`  — free to (re-)dispatch.
 * - `cooldown`  — attempted too recently; hold, try again after the gap.
 * - `escalate`  — the attempt cap is spent and no human has been looped in yet.
 * - `hold`      — cap spent and already escalated; do nothing (don't re-escalate).
 */
export type DispatchVerdict =
  | { kind: 'dispatch' }
  | { kind: 'cooldown' }
  | { kind: 'escalate'; attempts: number }
  | { kind: 'hold' };

/**
 * Decide whether an origin whose concern still persists may be (re-)dispatched,
 * from the recent audit log alone. Pure over `recentDecisions` + a `now`
 * timestamp (the world snapshot's `takenAt`) so it's unit-testable at the
 * dispatcher seam. Counts only *executed* dispatches — deferred ones (paused / no
 * headroom) never ran, so they're not attempts.
 */
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
    if ((a.type === 'dispatch_code_agent' || a.type === 'dispatch_desk_agent') && a.originRef === origin) {
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
