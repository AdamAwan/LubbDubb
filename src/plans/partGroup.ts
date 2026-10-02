import type { PlanPart } from '../types.js';

// → docs/spec/17-cockpit.md#the-setting-beside-the-act

export type PartGroup = 'merged' | 'now' | 'held' | 'waiting';

/** Where a part sits on a goal's plan, read the same by the goal page, Focus mode and `ask_next`'s card. A retired part is on none of them. */
export const PART_GROUP: Record<PlanPart['status'], PartGroup | null> = {
  merged: 'merged',
  concluded: 'merged',
  dispatched: 'now',
  in_review: 'now',
  blocked: 'held',
  ready: 'waiting',
  pending: 'waiting',
  retired: null,
};
