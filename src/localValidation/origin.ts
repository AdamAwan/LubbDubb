import { join } from 'node:path';
import { validationGoalDir } from '../validation/resources.js';

// → docs/spec/32-local-validation.md

export function localValidationOrigin(issueNumber: number, id: string): string {
  return `issue:${issueNumber}:validate-local:${id}`;
}

export function localValidationOriginParts(originRef: string | null): { issueNumber: number; id: string } | null {
  const match = /^issue:(\d+):validate-local:([A-Za-z0-9-]+)$/.exec(originRef ?? '');
  if (!match) return null;
  return { issueNumber: Number(match[1]), id: match[2] as string };
}

export function localValidationFixOrigin(issueNumber: number, id: string): string {
  return `issue:${issueNumber}:validate-local-fix:${id}`;
}

export function localValidationFixOriginParts(originRef: string | null): { issueNumber: number; id: string } | null {
  const match = /^issue:(\d+):validate-local-fix:([A-Za-z0-9-]+)$/.exec(originRef ?? '');
  if (!match) return null;
  return { issueNumber: Number(match[1]), id: match[2] as string };
}

export function localValidationKey(issueNumber: number, id: string): string {
  return `validate-local/issue/${issueNumber}/${id}`;
}

export function localValidationOutputDir(root: string, originRef: string, id: string): string {
  return join(validationGoalDir(root, originRef), 'local', id);
}

export function localValidationProfileDir(root: string): string {
  return join(root, '.browser-profile');
}
