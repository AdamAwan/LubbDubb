import type {
  PoolDigestDocument,
  PoolDigestRow,
  PoolDocumentKind,
  PoolFleetReading,
  PoolMirroredClaim,
  PoolPublication,
} from '../types.js';
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
 * The three tables it owns are `pool_claims`, `pool_digest_rows` and `pool_fleets`
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

  /**
   * Replace one fleet's claims in the mirror, whole.
   *
   * A whole replace rather than an upsert-and-sweep, because the document itself is
   * a whole-document put: a claim retired, rejected or superseded at origin is
   * simply not in the next document, and there is no tombstone, no delete verb and
   * no ordering to get wrong.
   *
   * **A vanished arrival does not delete the local fact.** By then it may carry
   * local corroborations of its own, and deleting on a remote operator's ruling
   * would let one person prune another's store. What happens instead is that the
   * withdrawal is recorded — the row is gone from here, and the local fact says
   * which pooled voice has stopped speaking for it. A reading, never a trigger.
   */
  replaceFleetClaims(fleetId: string, claims: readonly PoolMirroredClaim[]): void {
    const write = this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`DELETE FROM pool_claims WHERE fleet_id=?`).run(fleetId);
      const insert = this.ctx.db.prepare(
        `INSERT INTO pool_claims
           (fleet_id, fact_id, project, claim, where_at, vouched_at, corroborations, disputes,
            evidence, local_fact_id, published_at, seen_at)
         VALUES (@fleetId, @id, @project, @claim, @where, @vouchedAt, @corroborations, @disputes,
                 @evidence, @localFactId, @publishedAt, @seenAt)`,
      );
      for (const claim of claims) insert.run({ ...claim, evidence: JSON.stringify(claim.evidence) });
    });
    write();
  }

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
        `INSERT INTO pool_fleets (fleet_id, project, claims_at, digest_at, ahead, seen_at)
         VALUES (@fleetId, @project, @claimsAt, @digestAt, @ahead, @seenAt)
         ON CONFLICT(fleet_id) DO UPDATE SET
           project = excluded.project,
           claims_at = COALESCE(excluded.claims_at, pool_fleets.claims_at),
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
      claimsAt: r.claims_at,
      digestAt: r.digest_at,
      ahead: r.ahead === 1,
      seenAt: r.seen_at,
    }));
  }

  /** Everything in the mirror, newest vouch first — the page's read and the importer's. */
  listMirroredClaims(): PoolMirroredClaim[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM pool_claims ORDER BY vouched_at DESC, rowid DESC`)
      .all() as ClaimRow[];
    return rows.map(rowToMirroredClaim);
  }

  /** The pooled voices standing behind one local fact — what the page draws as provenance. */
  mirroredClaimsForFact(factId: string): PoolMirroredClaim[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM pool_claims WHERE local_fact_id=? ORDER BY vouched_at ASC, rowid ASC`)
      .all(factId) as ClaimRow[];
    return rows.map(rowToMirroredClaim);
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
  getPublication(kind: PoolDocumentKind): PoolPublication {
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
  markPoolDirty(kind: PoolDocumentKind): void {
    this.ctx.db
      .prepare(
        `INSERT INTO pool_publications (kind, content_hash, published_at, dirty, checked_at)
         VALUES (?, NULL, NULL, 1, NULL)
         ON CONFLICT(kind) DO UPDATE SET dirty = 1`,
      )
      .run(kind);
  }

  /** Record a successful publish: the hash it went out with, and when. Clears the hint. */
  recordPoolPublish(kind: PoolDocumentKind, contentHash: string): void {
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
  recordPoolChecked(kind: PoolDocumentKind): void {
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

interface ClaimRow {
  fleet_id: string;
  fact_id: string;
  project: string;
  claim: string;
  where_at: string | null;
  vouched_at: string;
  corroborations: number;
  disputes: number;
  evidence: string;
  local_fact_id: string | null;
  published_at: string;
  seen_at: string;
}

function rowToMirroredClaim(r: ClaimRow): PoolMirroredClaim {
  return {
    fleetId: r.fleet_id,
    id: r.fact_id,
    project: r.project,
    claim: r.claim,
    where: r.where_at,
    vouchedAt: r.vouched_at,
    corroborations: r.corroborations,
    disputes: r.disputes,
    // Written by this harness and read by it, so a row that will not parse is a bug
    // here rather than in the world — but it is read on the cockpit's path, where a
    // throw would take the page down over one malformed row. An empty list is the
    // safe reading: the claim is drawn, with no words behind it.
    evidence: parseEvidence(r.evidence),
    localFactId: r.local_fact_id,
    publishedAt: r.published_at,
    seenAt: r.seen_at,
  };
}

function parseEvidence(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
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
  claims_at: string | null;
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
