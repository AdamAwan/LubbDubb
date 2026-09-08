import { createHash } from 'node:crypto';
import { isThroughputMeasure } from '../throughputInsights.js';
import type { PoolClockDocument, PoolClockKind, PoolDigestDocument, PoolDocument } from '../types.js';

// → docs/spec/28-cross-fleet-pool.md

export const POOL_SCHEMA_VERSION = 1;

export const POOL_CLOCK_KINDS: readonly PoolClockKind[] = ['digest'];

const POOL_RETIRED_CLOCK_KINDS: readonly string[] = ['claims'];

export function poolRetiredPaths(fleetId: string): string[] {
  return POOL_RETIRED_CLOCK_KINDS.flatMap((kind) => [`fleets/${fleetId}/${kind}.json`, `fleets/${fleetId}/${kind}.md`]);
}

export function serialisePoolDocument(document: PoolDocument): string {
  return `${JSON.stringify(document, stableKeys(document), 2)}\n`;
}

export function poolContentHash(document: PoolDocument): string {
  const { publishedAt: _publishedAt, ...content } = document;
  return createHash('sha256')
    .update(JSON.stringify(content, stableKeys(content)))
    .digest('hex');
}

type PoolParse =
  | { ok: true; document: PoolClockDocument }
  | { ok: false; reason: 'ahead'; version: number; fleetId: string | null }
  | { ok: false; reason: 'malformed' | 'mismatched-fleet'; detail: string };

export function parsePoolDocument(text: string, expectFleetId?: string): PoolParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: 'malformed', detail: (error as Error).message };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', detail: 'a pool document must be a JSON object' };
  }
  const raw = parsed as Record<string, unknown>;
  const version = typeof raw.pool === 'number' ? raw.pool : null;
  if (version === null) return { ok: false, reason: 'malformed', detail: 'no "pool" schema version on the envelope' };
  const fleetId = typeof raw.fleetId === 'string' ? raw.fleetId : null;
  if (version > POOL_SCHEMA_VERSION) return { ok: false, reason: 'ahead', version, fleetId };
  const kind = raw.kind;
  if (kind !== 'digest') {
    return { ok: false, reason: 'malformed', detail: `unknown document kind ${JSON.stringify(kind)}` };
  }
  if (fleetId === null) return { ok: false, reason: 'malformed', detail: 'no "fleetId" in the body' };
  if (expectFleetId !== undefined && expectFleetId !== fleetId) {
    return {
      ok: false,
      reason: 'mismatched-fleet',
      detail: `a document addressed to ${expectFleetId} names ${fleetId} in its body`,
    };
  }
  if (typeof raw.project !== 'string' || raw.project === '') {
    return { ok: false, reason: 'malformed', detail: 'no "project" in the body' };
  }
  if (typeof raw.publishedAt !== 'string') {
    return { ok: false, reason: 'malformed', detail: 'no "publishedAt" in the body' };
  }
  return readDigest(raw);
}

function readDigest(raw: Record<string, unknown>): PoolParse {
  const document: PoolDigestDocument = {
    ...(raw as unknown as PoolDigestDocument),
    kind: 'digest',
    byPhase: readRows(raw.byPhase),
    byCause: readRows(raw.byCause),
    byCheck: readRows(raw.byCheck),
    unaccounted: readRows(raw.unaccounted),
    unmeasured: readRows(raw.unmeasured),
    byUsage: readRows(raw.byUsage),
    byThroughput: readRows(raw.byThroughput),
    poolableThroughput: readMeasures(raw.poolableThroughput),
    byFault: readRows(raw.byFault),
  };
  return { ok: true, document };
}

/* Another fleet's claim about what may be summed, checked against this build's own
   vocabulary before it is believed — a key this build does not know is dropped
   rather than mirrored under a name nothing can label. An absent field is a fleet
   from before the section: nothing of its throughput sums, which is the safe answer.
   → docs/spec/28-cross-fleet-pool.md */
function readMeasures(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((key): key is string => typeof key === 'string' && isThroughputMeasure(key));
}

function readRows(raw: unknown): PoolDigestDocument['byPhase'] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((row) => {
    if (typeof row.day !== 'string' || typeof row.key !== 'string') return [];
    return [
      {
        day: row.day,
        key: row.key,
        count: countOf(row.count),
        costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : null,
        partial: row.partial === true,
      },
    ];
  });
}

function countOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableKeys(value: object): string[] {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (isRecord(node)) {
      for (const key of Object.keys(node)) {
        keys.add(key);
        walk(node[key]);
      }
    }
  };
  walk(value);
  return [...keys].sort();
}

export function poolDocumentPath(fleetId: string, kind: PoolClockKind): string {
  return `fleets/${fleetId}/${kind}.json`;
}

export function poolPackPath(fleetId: string, prNumber: number): string {
  return `fleets/${fleetId}/packs/pr-${prNumber}.json`;
}

export function poolDocumentAddress(document: PoolDocument): string {
  return document.kind === 'pack'
    ? poolPackPath(document.fleetId, document.prNumber)
    : poolDocumentPath(document.fleetId, document.kind);
}
