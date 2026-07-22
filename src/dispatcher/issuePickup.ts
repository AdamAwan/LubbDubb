import type { Issue } from '../types.js';

/**
 * How the dispatcher gates and orders issue pickup, derived from operator config.
 *
 * This is *dispatcher-level* and provider-agnostic (fake or github): it decides
 * which visible issues an agent is started for. It is deliberately distinct from
 * the GitHub provider's `issueLabel` *ingest* filter, which narrows what's even
 * fetched into the world — untagged issues stay visible here, they're just left
 * alone.
 */
export interface IssuePickupPolicy {
  /**
   * When set, only issues whose `labels` include this are eligible for pickup.
   * Unset = act on all open issues (the backward-compatible default).
   */
  pickupLabel?: string;
  /**
   * When set, the pickup label only counts if the authenticated viewer added it
   * themselves — the gate reads `labelsAddedByViewer` instead of `labels`. Stops a
   * third party from tagging an item to get an agent onto it. Off by default; needs
   * a provider that resolves tag authorship (github/azure). If the provider didn't
   * populate authorship (unknown), no tag counts as the viewer's, so nothing passes.
   */
  requireOwnLabel?: boolean;
  /** Label → priority weight; higher is dispatched first under limited headroom. */
  priorityLabels: Record<string, number>;
  /** Weight for an issue carrying no matching priority label. */
  defaultPriority: number;
}

/** Whether an open, unlinked issue may be picked up under the policy's gate. */
export function isIssuePickupEligible(issue: Issue, policy: IssuePickupPolicy): boolean {
  if (!policy.pickupLabel) return true;
  const labels = policy.requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
  return labels.includes(policy.pickupLabel);
}

/**
 * Parse an issue's priority from its labels: the highest weight among labels that
 * match the scheme, or the configured default when none match. Pure — no world,
 * no side effects — so the label → weight mapping is unit-testable in isolation.
 */
export function issuePriority(labels: string[], policy: IssuePickupPolicy): number {
  let best: number | null = null;
  for (const label of labels) {
    const weight = policy.priorityLabels[label];
    if (weight !== undefined && (best === null || weight > best)) best = weight;
  }
  return best ?? policy.defaultPriority;
}
