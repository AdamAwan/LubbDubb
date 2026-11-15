export type PoolClockKind = 'digest';

interface PoolEnvelope {
  pool: number;
  kind: PoolClockKind;
  fleetId: string;
  project: string;
  publishedAt: string;
  harnessVersion: string;
}

export interface PoolDigestRow {
  day: string;
  key: string;
  count: number;
  costUsd: number | null;
  partial: boolean;
}

export interface PoolDigestDocument extends PoolEnvelope {
  kind: 'digest';
  byPhase: PoolDigestRow[];
  byCause: PoolDigestRow[];
  byCheck: PoolDigestRow[];
  unaccounted: PoolDigestRow[];
  unmeasured: PoolDigestRow[];
  byUsage: PoolDigestRow[];
  byThroughput: PoolDigestRow[];
  /* Which of `byThroughput`'s measures this fleet's world was scoped tightly enough
     for the pool to sum. Published by the fleet that knows, never guessed by a
     reader. → docs/spec/28-cross-fleet-pool.md */
  poolableThroughput: string[];
  byFault: PoolDigestRow[];
  byChoice: PoolDigestRow[];
  byRule: PoolDigestRow[];
  byVersion: PoolDigestRow[];
}

export type PoolClockDocument = PoolDigestDocument;

export type PoolDocument = PoolClockDocument;

export interface PoolFleetReading {
  fleetId: string;
  project: string | null;
  digestAt: string | null;
  ahead: boolean;
  seenAt: string;
  stale: boolean;
}

export interface PoolPublication {
  kind: PoolClockKind;
  contentHash: string | null;
  publishedAt: string | null;
  dirty: boolean;
  checkedAt: string | null;
}
