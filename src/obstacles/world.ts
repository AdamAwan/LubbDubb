import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { WorldSnapshot } from '../types.js';
import type { ObstacleWorld } from './keys.js';

// → docs/spec/27-obstacles.md

export function buildObstacleWorld(input: {
  reported: readonly string[];
  dispatchChecks: readonly string[];
  branchPaths: readonly string[];
  repoRoot: string | null;
}): ObstacleWorld {
  const root = input.repoRoot;
  return {
    checks: [...new Set([...input.reported, ...input.dispatchChecks])],
    dispatchChecks: input.dispatchChecks,
    branchPaths: input.branchPaths,
    hasPath: (path) => root !== null && withinTree(path) && existsSync(join(root, path)),
  };
}

function withinTree(path: string): boolean {
  if (path === '' || isAbsolute(path)) return false;
  const normalised = normalize(path);
  return !normalised.startsWith('..') && !normalised.includes('\0');
}

export function reportedChecks(world: { pullRequests: WorldSnapshot['pullRequests'] } | null): string[] {
  return [...new Set((world?.pullRequests ?? []).flatMap((pr) => (pr.ciChecks ?? []).map((check) => check.name)))];
}
