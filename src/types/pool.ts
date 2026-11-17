import type { LessonFix } from './lessons.js';
import type { RemedyCause, RemedyKind } from './remedies.js';

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
  lessons: PoolLessonRow[];
}

/** One side of an adopted lesson's merge, as counts: the group's misses in distinct goals, and same-kind return dispatches. */
export interface PoolLessonPeriod {
  misses: number;
  dispatches: number;
}

/* An adopted repo lesson as the pool carries it: counts over closed vocabularies
   and a link. No title, no free text and no `where` — a check name does not cross
   projects. → docs/spec/28-cross-fleet-pool.md#the-lessons-section */
export interface PoolLessonRow {
  kind: RemedyKind;
  cause: RemedyCause;
  guards: { documented: number; undocumented: number };
  fix: LessonFix;
  prUrl: string;
  mergedAt: string;
  before: PoolLessonPeriod;
  /** Null until 30 days have passed since the merge. */
  after: PoolLessonPeriod | null;
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
