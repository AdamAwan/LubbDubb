import type { PoolDigestDocument, PoolDigestRow, PoolClockKind, PoolFleetReading, PoolPublication } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The cross-fleet pool's local side: the mirror of everybody else's documents, and
 * the record of what this fleet has published.
 *
 * **The mirror is derived and wholly replaceable.** It is rewritten on every poll,
 * so dropping it and re-polling gives an identical one — which is what keeps the
 * pool from becoming authoritative locally. Every fleet's own SQLite stays the
 * truth about that fleet, and everything published is re-derivable from it. That
 * is not a cost this design pays: the mirror is the table the human-facing page
 * reads anyway.
 *
 * **Nothing here is read into a prompt, and no tool answers from it.** An agent
 * asking `knowledge_ask` is answered from `knowledge_facts` exactly as it was
 * before the pool existed. Wiring the mirror to that tool would put another team's
 * unvouched prose in front of an agent, and it is deliberately not built.
 *
 * The two tables it owns are `pool_digest_rows` and `pool_fleets`
 * (the mirror) plus `pool_publications` (this fleet's own side). All four are new
 * tables, so none needs a `ColumnMigrations` entry — and being new **once** is
 * what stops them staying exempt: the first column added to any of them later
 * belongs in one. → `docs/spec/14-persistence.md#migrations`
 *
 * → `docs/spec/28-cross-fleet-pool.md`
 */
export class PoolStore {
  constructor(private readonly ctx: StoreContext) {}

  // -- The mirror ------------------------------------------------------------

  /** Replace one fleet's digest rows, whole — {@link replaceFleetClaims}' reason exactly. */
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

  /** Note what this poll made of one fleet — including that it is ahead of this build. */
  recordFleetReading(reading: Omit<PoolFleetReading, 'seenAt'>): void {
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

  /** Every fleet the mirror has heard from, its own first if it is in there. */
  listPoolFleets(): PoolFleetReading[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM pool_fleets ORDER BY fleet_id ASC`).all() as FleetRow[];
    return rows.map((r) => ({
      fleetId: r.fleet_id,
      project: r.project,
      digestAt: r.digest_at,
      ahead: r.ahead === 1,
      seenAt: r.seen_at,
    }));
  }

  /**
   * Every digest row in the mirror for one project, or for every project.
   *
   * The project is an **argument** rather than a filter the caller may forget,
   * because `byCheck` is only comparable inside one project: three fleets on one
   * problem produce `test (windows)`, `ci/test-windows` and `Build & Test
   * (win-latest)`, and summed across projects that is three rows of one instead of
   * one row of three, rendering perfectly.
   */
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

  // -- This fleet's own side -------------------------------------------------

  /** What this fleet last published of one kind, or the untouched row for a kind it never has. */
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

  /**
   * Mark a document as needing a publish.
   *
   * **A flag and not a queue**: because the put is a whole replace, five rulings in
   * a minute collapse to one publish and a failed push simply stays dirty. There is
   * no pending-change list to lose, reorder or replay — and a flag lost to a crash
   * self-heals on the slow clock, which re-derives and compares the hash.
   */
  markPoolDirty(kind: PoolClockKind): void {
    this.ctx.db
      .prepare(
        `INSERT INTO pool_publications (kind, content_hash, published_at, dirty, checked_at)
         VALUES (?, NULL, NULL, 1, NULL)
         ON CONFLICT(kind) DO UPDATE SET dirty = 1`,
      )
      .run(kind);
  }

  /** Record a successful publish: the hash it went out with, and when. Clears the hint. */
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

  /**
   * Record that the backstop re-derived this document and found it unchanged.
   *
   * The stamp is what makes an hourly cadence cheap: an idle fleet computes a hash
   * and writes nothing. Without it every idle fleet would commit an identical file
   * twenty-four times a day and the pool's history would be almost entirely noise.
   */
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

/** The sections a digest carries, in the order the mirror stores them. */
type PoolDigestSection = 'phase' | 'cause' | 'check' | 'unaccounted' | 'unmeasured';

/** One mirrored digest row, flattened across every fleet — what the aggregator sums. */
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

/**
 * The document's mirrored lists as `(section, rows)` pairs.
 *
 * One place rather than five `insert.run` blocks, so a section the mirror should
 * store is added here once rather than in five places one of which is forgotten.
 *
 * **`byFault` is deliberately absent, and this is the one omission worth stating.**
 * Every section above sums across fleets into the shared insights page; a fault is
 * this harness's own failure on this operator's machine, comparable to nothing on
 * anybody else's and answering no question a company page asks. It is published so
 * a person can read it in this fleet's own `digest.md` and it goes no further —
 * mirroring it would put it in front of every other fleet as a number to sum.
 * → `docs/spec/28-cross-fleet-pool.md#the-faults-section`
 */
function digestSections(document: PoolDigestDocument): [PoolDigestSection, readonly PoolDigestRow[]][] {
  return [
    ['phase', document.byPhase],
    ['cause', document.byCause],
    ['check', document.byCheck],
    ['unaccounted', document.unaccounted],
    ['unmeasured', document.unmeasured],
  ];
}
