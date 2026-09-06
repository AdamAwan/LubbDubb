import { claimKey, claimsMatch } from '../claims.js';
import type { GatedKey } from './keys.js';

// → docs/spec/27-obstacles.md

export interface NearCandidate {
  id: string;
  what: string;
}

interface ObstacleMatch {
  obstacleId: string;
  matchedBy: string;
}

export function resolvingKeys(keys: readonly GatedKey[]): GatedKey[] {
  const binding = keys.filter((key) => key.binds);
  const locates = binding.some((key) => key.kind === 'test' || key.kind === 'path');
  return locates ? binding : [];
}

export function matchObstacle(
  keys: readonly GatedKey[],
  lookup: (value: string) => string | null,
): ObstacleMatch | null {
  for (const key of resolvingKeys(keys)) {
    const obstacleId = lookup(key.value);
    if (obstacleId !== null) return { obstacleId, matchedBy: `${key.kind}:${key.value}` };
  }
  return null;
}

export function nearMatches(input: {
  what: string;
  keys: readonly GatedKey[];
  rows: readonly NearCandidate[];
  lookup: (value: string) => string | null;
  exclude?: string | null;
}): NearCandidate[] {
  const key = claimKey(input.what);
  const hits = new Map<string, NearCandidate>();
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  for (const row of input.rows) {
    if (row.id === input.exclude) continue;
    if (claimsMatch(key, claimKey(row.what))) hits.set(row.id, row);
  }
  for (const candidate of input.keys.filter((k) => !k.binds)) {
    const id = input.lookup(candidate.value);
    if (id === null || id === input.exclude) continue;
    const row = rows.get(id);
    if (row !== undefined) hits.set(id, row);
  }
  return [...hits.values()];
}
