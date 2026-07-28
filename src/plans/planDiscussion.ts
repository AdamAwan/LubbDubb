import type { Plan } from '../types.js';

/**
 * Is this plan parked for a conversation rather than for a fresh decomposition?
 *
 * Both arms of rule 3c see a plan in `planning` status — that is the whole
 * mechanism a discussion reuses, and why it inherits the origin gate, the
 * cooldown and the attempt cap for free. The flag is the only thing that tells
 * the two apart, so the question is asked here rather than inline, and the
 * dispatcher and the routes cannot come to different answers about it.
 */
export function isPlanInDiscussion(plan: Plan | null): boolean {
  return plan !== null && plan.status === 'planning' && plan.discussing;
}
