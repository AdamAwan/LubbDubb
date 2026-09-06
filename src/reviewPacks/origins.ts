// → docs/spec/31-review-packs.md

export function packOrigin(prNumber: number): string {
  return `pr:${prNumber}:pack`;
}

export function packTargetPr(originRef: string | null): number | null {
  return targetOf(originRef, 'pack');
}

export function packLeaseKey(prNumber: number, headSha: string): string {
  return `review-pack/pr-${prNumber}/${headSha}`;
}

export function packLeaseHead(branch: string | null): string | null {
  return headOf(branch, 'review-pack');
}

export function checkOrigin(prNumber: number): string {
  return `pr:${prNumber}:check`;
}

export function checkTargetPr(originRef: string | null): number | null {
  return targetOf(originRef, 'check');
}

export function checkLeaseKey(prNumber: number, headSha: string): string {
  return `review-pack-check/pr-${prNumber}/${headSha}`;
}

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
