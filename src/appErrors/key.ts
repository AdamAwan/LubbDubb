import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Config } from '../config/config.js';

// → docs/spec/39-app-errors.md#the-key

const HASH_HEX = 8;

export function appErrorKey(project: string, fingerprint: string): string {
  const hash = createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, HASH_HEX);
  return `err:${project}:${hash}`;
}

export function appErrorProject(config: Pick<Config, 'pool' | 'github' | 'azureDevOps' | 'repoRoot'>): string {
  const named =
    [config.pool?.project, config.github?.repo, config.azureDevOps?.repository].find(
      (name): name is string => name !== undefined && name.trim() !== '',
    ) ?? basename(config.repoRoot);
  const slug = named
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'project' : slug;
}
