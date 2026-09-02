/**
 * The two review-pack agents' origins and lease keys, side by side so the
 * shapes cannot drift: the author is `pr:<n>:pack` under `review-pack/…`, the
 * checker `pr:<n>:check` under `review-pack-check/…`. Both are inside the pull
 * request's family, so `padOriginFor` resolves either to the pull request's own
 * pad, and outside every dispatch rule's vocabulary, so nothing in the pulse
 * ever finds one as work to do.
 *
 * **The lease key carries the head sha.** The task row has no column for a head,
 * and a pack must be written — and checked — against the head the agent was
 * handed rather than whatever the pull request points at by the time it submits.
 * The key is the task's own, survives a restart with the row, and names both, so
 * each tool re-derives its commission from the row and nothing lives only in
 * this process's memory. → `docs/spec/31-review-packs.md#when-a-pack-is-made`
 */

export function packOrigin(prNumber: number): string {
  return `pr:${prNumber}:pack`;
}

/** The pull request an author's origin names, or null for any other origin. */
export function packTargetPr(originRef: string | null): number | null {
  return targetOf(originRef, 'pack');
}

export function packLeaseKey(prNumber: number, headSha: string): string {
  return `review-pack/pr-${prNumber}/${headSha}`;
}

/** The head sha an author's lease key carries, or null for a key that is not one. */
export function packLeaseHead(branch: string | null): string | null {
  return headOf(branch, 'review-pack');
}

export function checkOrigin(prNumber: number): string {
  return `pr:${prNumber}:check`;
}

/** The pull request a checker's origin names, or null for any other origin. */
export function checkTargetPr(originRef: string | null): number | null {
  return targetOf(originRef, 'check');
}

export function checkLeaseKey(prNumber: number, headSha: string): string {
  return `review-pack-check/pr-${prNumber}/${headSha}`;
}

/** The head sha a checker's lease key carries, or null for a key that is not one. */
export function checkLeaseHead(branch: string | null): string | null {
  return headOf(branch, 'review-pack-check');
}

function targetOf(originRef: string | null, suffix: string): number | null {
  const match = originRef === null ? null : new RegExp(`^pr:(\\d+):${suffix}$`).exec(originRef);
  return match ? Number(match[1]) : null;
}

function headOf(branch: string | null, prefix: string): string | null {
  const match = branch === null ? null : new RegExp(`^${prefix}/pr-\\d+/([0-9a-f]+)$`).exec(branch);
  return match ? match[1]! : null;
}
