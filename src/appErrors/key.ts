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

/**
 * The lines a body-searching tracker carries an error key in: one a person can read, and a marker
 * that survives an edit of the visible text. → docs/spec/39-app-errors.md#the-key-on-the-ticket
 */
export function errorKeyBodyLines(key: string): string {
  return `Error key: \`${key}\` — every fleet on this project searches for it before filing; keep it here.\n<!-- lubbdubb:${key} -->`;
}

/** Whether a body carries the key whole — a search hit for a longer key that merely starts with it is not one. */
export function bodyCarriesKey(body: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![a-z0-9])`).test(body);
}
