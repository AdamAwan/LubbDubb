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

/** The word a part's place is said in beside its name — Focus mode's track and `ask_next`'s card. */
export const PART_GROUP_WORD: Record<PartGroup, string> = {
  merged: 'merged',
  now: 'being worked',
  held: 'held',
  waiting: 'not started',
};

/** The slug of the part an ask is about, where its origin names one — the part Focus mode and the card mark. */
export function askedPart(originRef: string | null): string | null {
  return /^issue:\d+:part:(.+)$/.exec(originRef ?? '')?.[1] ?? null;
}
