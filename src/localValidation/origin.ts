import { join } from 'node:path';
import { issueOriginId, issueOriginRef } from '../issueOrigins.js';
import { validationGoalDir } from '../validation/resources.js';

// → docs/spec/32-local-validation.md

export function localValidationOrigin(issueNumber: number, id: string): string {
  return issueOriginRef('localValidation', issueNumber, id);
}

export function localValidationOriginParts(originRef: string | null): { issueNumber: number; id: string } | null {
  return issueOriginId('localValidation', originRef);
}

export function localValidationFixOrigin(issueNumber: number, id: string): string {
  return issueOriginRef('localValidationFix', issueNumber, id);
}

export function localValidationFixOriginParts(originRef: string | null): { issueNumber: number; id: string } | null {
  return issueOriginId('localValidationFix', originRef);
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
