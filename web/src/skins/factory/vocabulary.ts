import type { Agent, QueueItem } from '../../types.js';
import type { IconName } from './components/Sprite.js';

/**
 * The translation layer: harness nouns in, factory nouns out.
 *
 * Kept pure and in one file so the mapping is stated once. A skin that decided
 * per-component what a `plan-part` looks like would drift — the belt would call
 * it one thing and the bay another — and the whole reason this treatment reads
 * as a machine rather than a costume is that the same work wears the same icon
 * wherever it appears.
 */

/** Which machine draws this piece of work, from its origin ref alone. */
export function iconForOrigin(origin: string | null): IconName {
  if (!origin) return 'chest';
  if (origin.startsWith('pr:')) return 'gear';
  if (origin.startsWith('job:')) return 'chest';
  if (origin.includes(':plan')) return 'blueprint';
  if (origin.includes(':part:')) return 'assembler';
  if (origin.startsWith('issue:')) return 'flask';
  if (origin.startsWith('story:')) return 'flask';
  return 'chest';
}

/**
 * The two-word tag under a belt item. Deliberately terse and deliberately *not*
 * the dispatcher's own `reason`, which is a sentence and lives in the tooltip:
 * this is the label stamped on a crate, readable at a glance across the line.
 */
export function beltTag(item: QueueItem): string {
  switch (item.status) {
    case 'dispatching':
      return 'Boarding';
    case 'waiting':
      return 'No bot free';
    case 'cooldown':
      return 'Cooling down';
    case 'capped':
      return 'Plan at cap';
    case 'unapproved':
      return 'Unstamped';
  }
}

/**
 * How a bay reads. `idle` is the only red thing on the floor, and it means
 * exactly one thing — the agent is parked on a question only you can answer.
 */
export function botState(agent: Agent): 'working' | 'idle' | 'spent' {
  if (agent.status === 'waiting') return 'idle';
  if (agent.status === 'running' || agent.status === 'starting') return 'working';
  return 'spent';
}

/**
 * SVG has no ellipsis and no wrapping, so text bound for the floor plan is cut
 * here rather than hoping it fits.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
