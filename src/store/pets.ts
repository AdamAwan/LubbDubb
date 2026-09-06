import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Pet, PetAction, PetActionKind, PetReset, PetSpecies } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

/**
 * `pets` began as a fresh `CREATE TABLE`; `dissolved_at` needs an entry here because
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, and a pet whose
 * `dissolved_at` reads `undefined` is simply alive again. → `docs/spec/14-persistence.md#migrations`
 */
export const PET_COLUMNS: ColumnMigrations = {
  pets: {
    dissolved_at: `TEXT`,
    // Null spells *still an egg*, which is why this one needs a backfill as well
    // as an `ALTER TABLE` — see `openPetsFromBeforeEggs`.
    opened_at: `TEXT`,
    // The three authenticity columns. Absent reads as a weaker claim, never a false
    // one: `attest.ts` declines to judge a pet from before them rather than calling
    // an honest operator's collection a forgery.
    built_sha: `TEXT`,
    built_clean: `INTEGER NOT NULL DEFAULT 0`,
    chain: `TEXT`,
  },
};

/**
 * The five `pet_*` tables: what has hatched, every operator action rolled, every
 * beat spent, every clearance, and the one row saying when this vivarium started
 * counting. A table being new once does not keep it exempt from `ColumnMigrations`.
 * Nothing here is derived twice: the wallet and the pity counter are sums over the
 * tables, never cached in a column that could drift.
 */
export class PetStore {
  constructor(private readonly ctx: StoreContext) {}

  listPets(): Pet[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM pets ORDER BY hatched_at DESC`).all() as PetRow[];
    return rows.map(rowToPet);
  }

  getPet(id: string): Pet | null {
    const row = this.ctx.db.prepare(`SELECT * FROM pets WHERE id=?`).get(id) as PetRow | undefined;
    return row ? rowToPet(row) : null;
  }

  /**
   * Hatch one, or hand back what is already there. `INSERT OR IGNORE` on the
   * origin's unique key, and the roll is a hash, so a re-scan of the same action
   * yields the same creature — which is what makes the scan safe to re-run.
   */
  hatchPet(input: {
    species: PetSpecies;
    seed: string;
    originKind: PetActionKind;
    originRef: string;
    hatchedAt: string;
    /** The build that rolled it. The keeper resolves it; nothing here runs git. */
    builtSha?: string | null;
    builtClean?: boolean;
  }): Pet {
    // A drop writes an egg — `opened_at` null. Species and tier are already settled
    // by the hash of the action; the shell withholds them, it does not choose them.
    const existing = this.ctx.db
      .prepare(`SELECT * FROM pets WHERE origin_kind=? AND origin_ref=?`)
      .get(input.originKind, input.originRef) as PetRow | undefined;
    if (existing) return rowToPet(existing);
    const id = `pet_${nanoid(10)}`;
    const pet: Pet = {
      id,
      species: input.species,
      seed: input.seed,
      name: null,
      fed: 0,
      originKind: input.originKind,
      originRef: input.originRef,
      hatchedAt: input.hatchedAt,
      openedAt: null,
      // The first four stand in the vivarium unasked: an empty enclosure teaches an
      // operator the corner is decoration.
      placed: this.placedCount() < VIVARIUM_SLOTS,
      dissolvedAt: null,
      builtSha: input.builtSha ?? null,
      builtClean: input.builtClean ?? false,
      chain: chainLink(this.lastChain(), { id, ...input }),
    };
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO pets
           (id, species, seed, name, fed, origin_kind, origin_ref, hatched_at, opened_at, placed, built_sha, built_clean, chain)
         VALUES
           (@id, @species, @seed, @name, @fed, @originKind, @originRef, @hatchedAt, @openedAt, @placed, @builtSha, @builtClean, @chain)`,
      )
      .run({ ...pet, placed: pet.placed ? 1 : 0, builtClean: pet.builtClean ? 1 : 0 });
    return pet;
  }

  /** The newest row's link, which the next one hashes onto. Null on an empty table. */
  private lastChain(): string | null {
    const row = this.ctx.db.prepare(`SELECT chain FROM pets ORDER BY rowid DESC LIMIT 1`).get() as
      | { chain: string | null }
      | undefined;
    return row?.chain ?? null;
  }

  /**
   * Every pet in the order it was written, with the link it carries. Insertion
   * order, not `hatched_at`: a scan settling a backlog writes pets whose hatch times
   * run backwards against the order they were chained in.
   */
  petChainLog(): { id: string; chain: string | null; link: ChainInput }[] {
    const rows = this.ctx.db
      .prepare(`SELECT id, species, seed, origin_kind, origin_ref, hatched_at, chain FROM pets ORDER BY rowid`)
      .all() as (ChainRow & { id: string; chain: string | null })[];
    return rows.map((row) => ({
      id: row.id,
      chain: row.chain,
      link: {
        id: row.id,
        species: row.species as PetSpecies,
        seed: row.seed,
        originKind: row.origin_kind as PetActionKind,
        originRef: row.origin_ref,
        hatchedAt: row.hatched_at,
      },
    }));
  }

  /** How many stand in the vivarium now. */
  placedCount(): number {
    const row = this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM pets WHERE placed=1`).get() as { n: number };
    return row.n;
  }

  /** Record that an action has been rolled, whatever it came to. */
  recordPetAction(action: PetAction): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pet_actions (kind, ref, at, pet_id) VALUES (@kind, @ref, @at, @petId)`)
      .run(action);
  }

  /**
   * Every action key already rolled, as `<kind>:<ref>` — what makes a re-scan a
   * no-op. A set of keys, not a watermark, so an action from before the vivarium
   * started is still written; skipping it unrecorded would leave it fresh forever.
   * Says nothing about whether anything has been *rolled* — see {@link petRolledSince}.
   */
  petActionKeys(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT kind, ref FROM pet_actions`).all() as { kind: string; ref: string }[];
    return new Set(rows.map((row) => `${row.kind}:${row.ref}`));
  }

  /**
   * Every rolled action in the order it was written, with what it came to. `rowid`,
   * not `at`: one pass stamps several actions identically, so a timestamp order is
   * not the order pity counted them in.
   */
  petActionLog(): PetAction[] {
    const rows = this.ctx.db.prepare(`SELECT kind, ref, at, pet_id FROM pet_actions ORDER BY rowid`).all() as {
      kind: string;
      ref: string;
      at: string;
      pet_id: string | null;
    }[];
    return rows.map((row) => ({
      kind: row.kind as PetActionKind,
      ref: row.ref,
      at: row.at,
      petId: row.pet_id,
    }));
  }

  /**
   * Every rolled action, by key, with what it came to — what an attestation is
   * checked against: a pet whose origin names no row here was not put there by the
   * scan. Read once per snapshot and shared, not queried per card.
   */
  petActionIndex(): Map<string, { at: string; petId: string | null }> {
    const rows = this.ctx.db.prepare(`SELECT kind, ref, at, pet_id FROM pet_actions`).all() as {
      kind: string;
      ref: string;
      at: string;
      pet_id: string | null;
    }[];
    return new Map(rows.map((row) => [`${row.kind}:${row.ref}`, { at: row.at, petId: row.pet_id }]));
  }

  /** What each pet's purchases actually paid for, by pet id. `pets.fed` caches this sum in the same transaction; the two disagreeing means a torn write or a hand-edited column. */
  petPaidTotals(): Map<string, number> {
    const rows = this.ctx.db
      .prepare(`SELECT pet_id, COALESCE(SUM(beats), 0) AS total FROM pet_purchases GROUP BY pet_id`)
      .all() as { pet_id: string; total: number }[];
    return new Map(rows.map((row) => [row.pet_id, row.total]));
  }

  /**
   * Actions rolled since the last one that hatched something, per kind — a shared
   * counter would be spent entirely by the most frequent kind, so the scarce ones
   * never reach their ceiling. Sparse: a kind with no rolled actions reads as zero.
   *
   * Ordered by `rowid`, not `at`: identical stamps make a timestamp comparison
   * report zero, and pity then never fires. `since` is the vivarium's start — older
   * rows are recorded but were never rolled, so they must not build a pity floor.
   */
  petActionsSinceHatch(since: string): Map<PetActionKind, number> {
    const rows = this.ctx.db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM pet_actions AS a
          WHERE a.at >= @since
            AND a.rowid > (SELECT COALESCE(MAX(b.rowid), 0)
                             FROM pet_actions AS b
                            WHERE b.pet_id IS NOT NULL AND b.kind = a.kind)
          GROUP BY a.kind`,
      )
      .all({ since }) as { kind: string; n: number }[];
    return new Map(rows.map((row) => [row.kind as PetActionKind, row.n]));
  }

  /** Whether anything at or after the vivarium's start has been rolled yet — the `firstEver` signal. Not `petActionKeys().size`, which counts the backlog. */
  petRolledSince(since: string): boolean {
    const row = this.ctx.db.prepare(`SELECT 1 AS n FROM pet_actions WHERE at >= ? LIMIT 1`).get(since) as
      | { n: number }
      | undefined;
    return row !== undefined;
  }

  /** When this vivarium started counting, or null before its first enabled scan. */
  vivariumStart(): string | null {
    const row = this.ctx.db.prepare(`SELECT started_at FROM pet_vivarium WHERE id=1`).get() as
      | { started_at: string }
      | undefined;
    return row?.started_at ?? null;
  }

  /**
   * The vivarium's start, stamped on the one boot that has none — the row's absence
   * is the migration gate. Empty `pet_actions` → `now()`, so a year-old database
   * does not roll its whole history in one pass; non-empty → `MIN(at)`, a no-op for
   * an existing collection rather than badging real animals `unearned`.
   */
  beginVivarium(): string {
    const begin = this.ctx.db.transaction((): string => {
      const existing = this.vivariumStart();
      if (existing !== null) return existing;
      const row = this.ctx.db.prepare(`SELECT MIN(at) AS at FROM pet_actions`).get() as { at: string | null };
      const at = row.at ?? this.ctx.now();
      this.ctx.db.prepare(`INSERT OR IGNORE INTO pet_vivarium (id, started_at) VALUES (1, ?)`).run(at);
      return at;
    });
    return begin();
  }

  /** Spend beats on one pet. Two writes in one transaction — the purchase is the record, `fed` the cache — so a crash cannot leave a pet paid for and not grown. Nothing un-feeds. */
  feedPet(id: string, beats: number): Pet | null {
    const feed = this.ctx.db.transaction((): Pet | null => {
      const changed = this.ctx.db.prepare(`UPDATE pets SET fed = fed + ? WHERE id=?`).run(beats, id).changes;
      if (changed === 0) return null;
      this.ctx.db
        .prepare(`INSERT INTO pet_purchases (id, pet_id, beats, created_at) VALUES (?,?,?,?)`)
        .run(`buy_${nanoid(10)}`, id, beats, this.ctx.now());
      return this.getPet(id);
    });
    return feed();
  }

  /** Crack one open, stamping the moment the operator did it. `opened_at IS NULL` in the `WHERE`, so a second click returns the row unchanged rather than moving the stamp. */
  openPet(id: string): Pet | null {
    this.ctx.db.prepare(`UPDATE pets SET opened_at=? WHERE id=? AND opened_at IS NULL`).run(this.ctx.now(), id);
    return this.getPet(id);
  }

  renamePet(id: string, name: string | null): Pet | null {
    const changed = this.ctx.db.prepare(`UPDATE pets SET name=? WHERE id=?`).run(name, id).changes;
    return changed === 0 ? null : this.getPet(id);
  }

  placePet(id: string, placed: boolean): Pet | null {
    const changed = this.ctx.db.prepare(`UPDATE pets SET placed=? WHERE id=?`).run(placed ? 1 : 0, id).changes;
    return changed === 0 ? null : this.getPet(id);
  }

  /** How many of this species are still alive — what `blend` reads to refuse the last one of its kind. */
  livePetsOfSpecies(species: PetSpecies): number {
    const row = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM pets WHERE species=? AND dissolved_at IS NULL`)
      .get(species) as { n: number };
    return row.n;
  }

  /**
   * Dissolve one duplicate into beats. Two writes in one transaction, as
   * {@link feedPet}. The row is marked, never deleted, and leaves the vivarium so
   * it holds no slot.
   */
  blendPet(id: string, beats: number): Pet | null {
    const blend = this.ctx.db.transaction((): Pet | null => {
      const ts = this.ctx.now();
      const changed = this.ctx.db
        .prepare(`UPDATE pets SET dissolved_at=?, placed=0 WHERE id=? AND dissolved_at IS NULL`)
        .run(ts, id).changes;
      if (changed === 0) return null;
      this.ctx.db
        .prepare(`INSERT INTO pet_blends (id, pet_id, beats, created_at) VALUES (?,?,?,?)`)
        .run(`bld_${nanoid(10)}`, id, beats, ts);
      return this.getPet(id);
    });
    return blend();
  }

  /** Every beat ever handed back by a blend. Rides beside fleet spend in the wallet. */
  petBlendCredits(): number {
    const row = this.ctx.db.prepare(`SELECT COALESCE(SUM(beats), 0) AS total FROM pet_blends`).get() as {
      total: number;
    };
    return row.total;
  }

  /** Every beat ever spent. The only input to the wallet's `spent`. */
  petBeatsSpent(): number {
    const row = this.ctx.db.prepare(`SELECT COALESCE(SUM(beats), 0) AS total FROM pet_purchases`).get() as {
      total: number;
    };
    return row.total;
  }

  /** When a named clearance ran here, or null for one that has not. */
  petResetAt(id: string): string | null {
    const row = this.ctx.db.prepare(`SELECT at FROM pet_resets WHERE id=?`).get(id) as { at: string } | undefined;
    return row?.at ?? null;
  }

  /** The newest clearance's stamp — the floor the wallet counts spend from. `MAX(at)` rather than the newest row, the safe answer if anything back-dates one. */
  petEpoch(): string | null {
    const row = this.ctx.db.prepare(`SELECT MAX(at) AS at FROM pet_resets`).get() as { at: string | null };
    return row.at;
  }

  /**
   * Release the whole collection, and stamp when. → `docs/spec/22-pets.md#clearing-the-vivarium`
   *
   * `pet_actions` is deliberately left standing: clearing it would let the next scan
   * hatch the released collection straight back out of the same history. Purchases
   * and blends go with the pets, in one transaction, so the wallet never shows spend
   * against creatures that are gone. The start is re-stamped in that same
   * transaction, which leaves the surviving backlog inert — no inherited pity
   * floor, and the first-action guarantee handed back.
   */
  clearVivarium(id: string): PetReset {
    const wipe = this.ctx.db.transaction((): PetReset => {
      const at = this.ctx.now();
      const cleared = this.ctx.db.prepare(`DELETE FROM pets`).run().changes;
      this.ctx.db.prepare(`DELETE FROM pet_purchases`).run();
      this.ctx.db.prepare(`DELETE FROM pet_blends`).run();
      this.ctx.db.prepare(`INSERT OR IGNORE INTO pet_resets (id, at, cleared) VALUES (?,?,?)`).run(id, at, cleared);
      this.ctx.db
        .prepare(
          `INSERT INTO pet_vivarium (id, started_at) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at`,
        )
        .run(at);
      return { id, at, cleared };
    });
    return wipe();
  }
}

/** How many pets stand in the vivarium at once — as many as the rail fits without scrolling. */
export const VIVARIUM_SLOTS = 4;

/**
 * The identity fields one link covers: which creature this is and where it came
 * from, and nothing that changes afterwards — `name`, `fed`, `placed` and
 * `dissolved_at` all move in ordinary use and would break the chain on a rename.
 */
export interface ChainInput {
  id: string;
  species: PetSpecies;
  seed: string;
  originKind: PetActionKind;
  originRef: string;
  hatchedAt: string;
}

/**
 * One link: this pet's identity, hashed onto the link before it. A pet cannot be
 * edited or inserted without every later link going wrong. SHA-256, not the roll's
 * `hash32`, which is collidable.
 *
 * @public — recomputed by `src/pets/attest.ts`, which is the only reader.
 */
/**
 * Stamp every pet that predates the shell as already opened, with `hatched_at`. Run
 * only on the boot `pets.opened_at` arrives: null there means still an egg, so
 * without it an existing vivarium comes back as a crate of shells — and ungated it
 * would open every egg left sitting deliberately on every restart.
 * → `docs/spec/14-persistence.md#when-a-null-means-something`
 *
 * @public — called by `Store`'s constructor, the only place that knows a column
 * was just added.
 */
export function openPetsFromBeforeEggs(db: Database.Database): void {
  db.prepare(`UPDATE pets SET opened_at = hatched_at WHERE opened_at IS NULL`).run();
}

/** The chain covers what the roll decided, and deliberately not `opened_at`: hashing an operator's own later act in would report `broken-chain` on an honest collection the moment a shell came off. */
export function chainLink(previous: string | null, pet: ChainInput): string {
  const body = [previous ?? '', pet.id, pet.species, pet.seed, pet.originKind, pet.originRef, pet.hatchedAt].join(
    '\u0000',
  );
  return createHash('sha256').update(body).digest('hex');
}

interface ChainRow {
  species: string;
  seed: string;
  origin_kind: string;
  origin_ref: string;
  hatched_at: string;
}

interface PetRow {
  id: string;
  species: string;
  seed: string;
  name: string | null;
  fed: number;
  origin_kind: string;
  origin_ref: string;
  hatched_at: string;
  opened_at: string | null;
  placed: number;
  dissolved_at: string | null;
  built_sha: string | null;
  built_clean: number | null;
  chain: string | null;
}

function rowToPet(row: PetRow): Pet {
  return {
    id: row.id,
    species: row.species as PetSpecies,
    seed: row.seed,
    name: row.name,
    fed: row.fed,
    originKind: row.origin_kind as PetActionKind,
    originRef: row.origin_ref,
    hatchedAt: row.hatched_at,
    openedAt: row.opened_at ?? null,
    placed: row.placed === 1,
    // Nullable *and* possibly absent: added by `ensureColumns` on older databases,
    // where the read would otherwise be `undefined` rather than null.
    dissolvedAt: row.dissolved_at ?? null,
    builtSha: row.built_sha ?? null,
    builtClean: row.built_clean === 1,
    chain: row.chain ?? null,
  };
}
