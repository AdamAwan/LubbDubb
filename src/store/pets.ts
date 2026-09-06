import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Pet, PetAction, PetActionKind, PetReset, PetSpecies } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

export const PET_COLUMNS: ColumnMigrations = {
  pets: {
    dissolved_at: `TEXT`,
    opened_at: `TEXT`,
    built_sha: `TEXT`,
    built_clean: `INTEGER NOT NULL DEFAULT 0`,
    chain: `TEXT`,
  },
};

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

  hatchPet(input: {
    species: PetSpecies;
    seed: string;
    originKind: PetActionKind;
    originRef: string;
    hatchedAt: string;
    builtSha?: string | null;
    builtClean?: boolean;
  }): Pet {
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

  private lastChain(): string | null {
    const row = this.ctx.db.prepare(`SELECT chain FROM pets ORDER BY rowid DESC LIMIT 1`).get() as
      | { chain: string | null }
      | undefined;
    return row?.chain ?? null;
  }

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

  placedCount(): number {
    const row = this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM pets WHERE placed=1`).get() as { n: number };
    return row.n;
  }

  recordPetAction(action: PetAction): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pet_actions (kind, ref, at, pet_id) VALUES (@kind, @ref, @at, @petId)`)
      .run(action);
  }

  petActionKeys(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT kind, ref FROM pet_actions`).all() as { kind: string; ref: string }[];
    return new Set(rows.map((row) => `${row.kind}:${row.ref}`));
  }

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

  petActionIndex(): Map<string, { at: string; petId: string | null }> {
    const rows = this.ctx.db.prepare(`SELECT kind, ref, at, pet_id FROM pet_actions`).all() as {
      kind: string;
      ref: string;
      at: string;
      pet_id: string | null;
    }[];
    return new Map(rows.map((row) => [`${row.kind}:${row.ref}`, { at: row.at, petId: row.pet_id }]));
  }

  petPaidTotals(): Map<string, number> {
    const rows = this.ctx.db
      .prepare(`SELECT pet_id, COALESCE(SUM(beats), 0) AS total FROM pet_purchases GROUP BY pet_id`)
      .all() as { pet_id: string; total: number }[];
    return new Map(rows.map((row) => [row.pet_id, row.total]));
  }

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

  petRolledSince(since: string): boolean {
    const row = this.ctx.db.prepare(`SELECT 1 AS n FROM pet_actions WHERE at >= ? LIMIT 1`).get(since) as
      | { n: number }
      | undefined;
    return row !== undefined;
  }

  vivariumStart(): string | null {
    const row = this.ctx.db.prepare(`SELECT started_at FROM pet_vivarium WHERE id=1`).get() as
      | { started_at: string }
      | undefined;
    return row?.started_at ?? null;
  }

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

  livePetsOfSpecies(species: PetSpecies): number {
    const row = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM pets WHERE species=? AND dissolved_at IS NULL`)
      .get(species) as { n: number };
    return row.n;
  }

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

  petBlendCredits(): number {
    const row = this.ctx.db.prepare(`SELECT COALESCE(SUM(beats), 0) AS total FROM pet_blends`).get() as {
      total: number;
    };
    return row.total;
  }

  petBeatsSpent(): number {
    const row = this.ctx.db.prepare(`SELECT COALESCE(SUM(beats), 0) AS total FROM pet_purchases`).get() as {
      total: number;
    };
    return row.total;
  }

  petResetAt(id: string): string | null {
    const row = this.ctx.db.prepare(`SELECT at FROM pet_resets WHERE id=?`).get(id) as { at: string } | undefined;
    return row?.at ?? null;
  }

  petEpoch(): string | null {
    const row = this.ctx.db.prepare(`SELECT MAX(at) AS at FROM pet_resets`).get() as { at: string | null };
    return row.at;
  }

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

export const VIVARIUM_SLOTS = 4;

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
    dissolvedAt: row.dissolved_at ?? null,
    builtSha: row.built_sha ?? null,
    builtClean: row.built_clean === 1,
    chain: row.chain ?? null,
  };
}
