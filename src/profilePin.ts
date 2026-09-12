import { inIssueOriginFamily, issueOriginHead, issueOriginRole, parseIssueOrigin } from './issueOrigins.js';

// → docs/spec/02-configuration.md

interface PinLookup {
  goal: (issueNumber: number) => string | null;
  part: (issueNumber: number, slug: string) => string | null;
}

export function pinnedProfileFor(originRef: string | null, lookup: PinLookup): string | null {
  const head = issueOriginHead(originRef);
  if (head === null) return null;
  const { issueNumber, suffix } = head;
  const family = parseIssueOrigin(originRef)?.family ?? null;
  if (family === 'retro' || family === 'appraisal') return null;

  const part =
    suffix !== null && inIssueOriginFamily('part', originRef)
      ? lookup.part(issueNumber, suffix.slice('part:'.length))
      : null;
  if (part !== null) return part;
  return issueOriginRole(issueNumber, originRef) === null ? null : lookup.goal(issueNumber);
}
