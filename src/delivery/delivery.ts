import type { DeliveryAuthor, Issue, IssueDelivery, WorldEvent } from '../types.js';

// → docs/spec/24-environments.md

interface DeliveryHoldContext {
  pickupStates?: string[];
  signals?: WorldEvent[];
}

function deliveryWorldRef(originRef: string): string | null {
  return /^issue:\d+$/.test(originRef) ? originRef : null;
}

export const DELIVERY_AUTHOR: Record<DeliveryAuthor, string> = {
  operator: 'you',
  assessor: 'the assessor',
  planner: 'the planner',
};

export function deliveryHold(
  delivery: IssueDelivery | null,
  issue: Issue,
  ctx: DeliveryHoldContext = {},
): string | null {
  if (!delivery) return null;

  const state = issue.workItemState;
  if (state !== undefined && (ctx.pickupStates ?? []).includes(state)) return null;

  if (expiringSignal(delivery, ctx.signals ?? [])) return null;

  return (
    `${DELIVERY_AUTHOR[delivery.by]} marked it delivered` +
    `${delivery.summary ? ` — "${delivery.summary}"` : ''} (${delivery.decidedAt})`
  );
}

function expiringSignal(delivery: IssueDelivery, signals: WorldEvent[]): WorldEvent | null {
  const item = deliveryWorldRef(delivery.originRef);
  if (!item) return null;
  const cast = verdictCast(delivery);
  return signals.find((e) => e.ref === item && e.createdAt > cast) ?? null;
}

function verdictCast(delivery: IssueDelivery): string {
  return delivery.updatedAt ?? delivery.decidedAt;
}

export function deliverySignalQuery(deliveries: IssueDelivery[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  let since: string | null = null;
  for (const d of deliveries) {
    const item = deliveryWorldRef(d.originRef);
    if (!item) continue;
    refs.add(item);
    const cast = verdictCast(d);
    if (since === null || cast < since) since = cast;
  }
  return since !== null && refs.size > 0 ? { since, refs: [...refs] } : null;
}
