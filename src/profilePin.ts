import { issueOriginRole } from './issueOrigins.js';

// → docs/spec/02-configuration.md

interface PinLookup {
  goal: (issueNumber: number) => string | null;
  part: (issueNumber: number, slug: string) => string | null;
}

const UNPINNED_SUFFIXES = ['retro', 'appraisal'];

export function pinnedProfileFor(originRef: string | null, lookup: PinLookup): string | null {
  const match = /^issue:(\d+)(?::(.+))?$/.exec(originRef ?? '');
  if (!match) return null;
  const issueNumber = Number(match[1]);
  const suffix = match[2] ?? null;
  if (suffix !== null && UNPINNED_SUFFIXES.includes(suffix)) return null;

  const part = suffix?.startsWith('part:') === true ? lookup.part(issueNumber, suffix.slice('part:'.length)) : null;
  if (part !== null) return part;
  return issueOriginRole(issueNumber, originRef) === null ? null : lookup.goal(issueNumber);
}
