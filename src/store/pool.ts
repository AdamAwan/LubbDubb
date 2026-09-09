import { poolStaleBefore } from '../pool/document.js';
import type { PoolDigestDocument, PoolDigestRow, PoolClockKind, PoolFleetReading, PoolPublication } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const POOL_RETIRED_TABLES: readonly string[] = ['pool_claims'];

export class PoolStore {
  constructor(private readonly ctx: StoreContext) {}

  replaceFleetDigest(fleetId: string, project: string, document: PoolDigestDocument): void {
    const write = this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`DELETE FROM pool_digest_rows WHERE fleet_id=?`).run(fleetId);
      const insert = this.ctx.db.prepare(
        `INSERT INTO pool_digest_rows (fleet_id, project, day, section, key, count, cost_usd, partial)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [section, rows] of digestSections(document)) {
        for (const row of rows) {
          insert.run(fleetId, project, row.day, section, row.key, row.count, row.costUsd, row.partial ? 1 : 0);
        }
      }
    });
    write();
  }

  recordFleetReading(reading: Omit<PoolFleetReading, 'seenAt' | 'stale'>): void {
    this.ctx.db
      .prepare(
        `INSERT INTO pool_fleets (fleet_id, project, digest_at, ahead, seen_at)
         VALUES (@fleetId, @project, @digestAt, @ahead, @seenAt)
         ON CONFLICT(fleet_id) DO UPDATE SET
           project = excluded.project,
           digest_at = COALESCE(excluded.digest_at, pool_fleets.digest_at),
           ahead = excluded.ahead,
           seen_at = excluded.seen_at`,
      )
      .run({ ...reading, ahead: reading.ahead ? 1 : 0, seenAt: this.ctx.now() });
  }

  listPoolFleets(): PoolFleetReading[] {
    const before = poolStaleBefore(this.ctx.now());
    const rows = this.ctx.db.prepare(`SELECT * FROM pool_fleets ORDER BY fleet_id ASC`).all() as FleetRow[];
    return rows.map((r) => ({
      fleetId: r.fleet_id,
      project: r.project,
      digestAt: r.digest_at,
      ahead: r.ahead === 1,
      seenAt: r.seen_at,
      stale: (r.digest_at ?? r.seen_at) < before,
    }));
  }

  expireStaleDigests(): string[] {
    const before = poolStaleBefore(this.ctx.now());
    const rows = this.ctx.db
      .prepare(
        `SELECT f.fleet_id AS fleet_id FROM pool_fleets f
          WHERE f.digest_at IS NOT NULL AND f.digest_at < ?
            AND EXISTS (SELECT 1 FROM pool_digest_rows r WHERE r.fleet_id = f.fleet_id)`,
      )
      .all(before) as { fleet_id: string }[];
    const write = this.ctx.db.transaction(() => {
      const drop = this.ctx.db.prepare(`DELETE FROM pool_digest_rows WHERE fleet_id=?`);
      for (const row of rows) drop.run(row.fleet_id);
    });
    write();
    return rows.map((r) => r.fleet_id);
  }

  listDigestRows(project: string | null): PoolDigestMirrorRow[] {
    const rows = (
      project === null
        ? this.ctx.db.prepare(`SELECT * FROM pool_digest_rows ORDER BY day ASC`).all()
        : this.ctx.db.prepare(`SELECT * FROM pool_digest_rows WHERE project=? ORDER BY day ASC`).all(project)
    ) as DigestRow[];
    return rows.map((r) => ({
      fleetId: r.fleet_id,
      project: r.project,
      day: r.day,
      section: r.section as PoolDigestSection,
      key: r.key,
      count: r.count,
      costUsd: r.cost_usd,
      partial: r.partial === 1,
    }));
  }

  getPublication(kind: PoolClockKind): PoolPublication {
    const row = this.ctx.db.prepare(`SELECT * FROM pool_publications WHERE kind=?`).get(kind) as
      | PublicationRow
      | undefined;
    if (!row) return { kind, contentHash: null, publishedAt: null, dirty: false, checkedAt: null };
    return {
      kind,
      contentHash: row.content_hash,
      publishedAt: row.published_at,
      dirty: row.dirty === 1,
      checkedAt: row.checked_at,
    };
  }

  markPoolDirty(kind: PoolClockKind): void {
    this.ctx.db
      .prepare(
        `INSERT INTO pool_publications (kind, content_hash, published_at, dirty, checked_at)
         VALUES (?, NULL, NULL, 1, NULL)
         ON CONFLICT(kind) DO UPDATE SET dirty = 1`,
      )
      .run(kind);
  }

  recordPoolPublish(kind: PoolClockKind, contentHash: string): void {
    const at = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO pool_publications (kind, content_hash, published_at, dirty, checked_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(kind) DO UPDATE SET
           content_hash = excluded.content_hash,
           published_at = excluded.published_at,
           dirty = 0,
           checked_at = excluded.checked_at`,
      )
      .run(kind, contentHash, at, at);
  }

  recordPoolChecked(kind: PoolClockKind): void {
    this.ctx.db
      .prepare(
        `INSERT INTO pool_publications (kind, content_hash, published_at, dirty, checked_at)
         VALUES (?, NULL, NULL, 0, ?)
         ON CONFLICT(kind) DO UPDATE SET checked_at = excluded.checked_at, dirty = 0`,
      )
      .run(kind, this.ctx.now());
  }
}

type PoolDigestSection = 'phase' | 'cause' | 'check' | 'unaccounted' | 'unmeasured' | 'usage' | 'throughput';

export interface PoolDigestMirrorRow {
  fleetId: string;
  project: string;
  day: string;
  section: PoolDigestSection;
  key: string;
  count: number;
  costUsd: number | null;
  partial: boolean;
}

interface DigestRow {
  fleet_id: string;
  project: string;
  day: string;
  section: string;
  key: string;
  count: number;
  cost_usd: number | null;
  partial: number;
}

interface FleetRow {
  fleet_id: string;
  project: string | null;
  digest_at: string | null;
  ahead: number;
  seen_at: string;
}

interface PublicationRow {
  kind: string;
  content_hash: string | null;
  published_at: string | null;
  dirty: number;
  checked_at: string | null;
}

function digestSections(document: PoolDigestDocument): [PoolDigestSection, readonly PoolDigestRow[]][] {
  const poolable = new Set(document.poolableThroughput);
  return [
    ['phase', document.byPhase],
    ['cause', document.byCause],
    ['check', document.byCheck],
    ['unaccounted', document.unaccounted],
    ['unmeasured', document.unmeasured],
    ['usage', document.byUsage],
    // Only the measures the publishing fleet declared its own reach the mirror: a
    // slice its provider did not filter to it is the repository's, seen by every
    // fleet watching that repository, and summed it would count watchers rather than
    // work. The declaration is the publisher's because only it knows what scoped its
    // world. Cutting here rather than in the fold makes a reader that forgot the rule
    // unreachable, which is what `byCheck` does with its project argument.
    // -> docs/spec/28-cross-fleet-pool.md
    ['throughput', document.byThroughput.filter((row) => poolable.has(row.key))],
  ];
}
