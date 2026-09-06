import { join } from 'node:path';

// → docs/spec/20-validation.md

export function validationGoalDir(root: string, originRef: string): string {
  return join(root, originRef.replace(/[^A-Za-z0-9._-]+/g, '-'));
}

export function validationResourcePath(root: string, originRef: string, name: string): string {
  return join(validationGoalDir(root, originRef), name);
}
