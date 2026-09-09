// → docs/spec/05-dispatcher.md

type IssueOriginRole = 'work' | 'evidence' | 'deliberation' | 'unrecognised';

const DELIBERATION_SUFFIXES = ['plan', 'appraisal', 'sequence'];

const DELIBERATION_SUFFIX_PREFIXES = ['split:'];

const WORK_SUFFIX_PREFIXES = ['part:', 'validate-local-fix:'];

const EVIDENCE_SUFFIXES = ['assess', 'retro'];

const EVIDENCE_SUFFIX_PREFIXES = ['validate:', 'validate-failure:', 'validate-local:', 'validate-remote:'];

export function issueOriginRole(issueNumber: number, originRef: string | null): IssueOriginRole | null {
  const root = `issue:${issueNumber}`;
  if (originRef === root) return 'work';
  const prefix = `${root}:`;
  if (originRef === null || !originRef.startsWith(prefix)) return null;

  const suffix = originRef.slice(prefix.length);
  if (WORK_SUFFIX_PREFIXES.some((p) => suffix.startsWith(p))) return 'work';
  if (EVIDENCE_SUFFIXES.includes(suffix)) return 'evidence';
  if (EVIDENCE_SUFFIX_PREFIXES.some((p) => suffix.startsWith(p))) return 'evidence';
  if (DELIBERATION_SUFFIXES.includes(suffix)) return 'deliberation';
  if (DELIBERATION_SUFFIX_PREFIXES.some((p) => suffix.startsWith(p))) return 'deliberation';
  return 'unrecognised';
}

export function obstacleOriginId(originRef: string | null): string | null {
  const match = /^obstacle:([A-Za-z0-9_-]+)$/.exec(originRef ?? '');
  return match ? match[1]! : null;
}
