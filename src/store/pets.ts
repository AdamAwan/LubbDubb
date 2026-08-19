import { nanoid } from 'nanoid';
import type { Pet, PetAction, PetActionKind, PetSpecies } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The three `pet_*` tables: what has hatched, every operator action that has been
 * rolled, and every beat that has been spent.
 *
 * All three are new, so none needs a `ColumnMigrations` entry — and a table being
 * new **once** does not keep it exempt: a column added to any of them later does.
 *
 * Nothing here is derived twice. The wallet is a sum over `pet_purchases`, the
 * pity counter is a count over `pet_actions`, and neither is cached in a column,
 * because a running total is a second copy of a number these tables already hold
 * and it drifts the first time a write lands twice.
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
   * Hatch one, or hand back what is already there.
   *
   * `INSERT OR IGNORE` on the origin's unique key rather than a read-then-write:
   * the roll is a hash, so a re-scan of the same action arrives here with exactly
   * the same creature, and the two together are what make the whole scan safe to
   * run as often as anything likes.
   */
  hatchPet(input: {
    species: PetSpecies;
    seed: string;
    originKind: PetActionKind;
    originRef: string;
    hatchedAt: string;
  }): Pet {
    const existing = this.ctx.db
      .prepare(`SELECT * FROM pets WHERE origin_kind=? AND origin_ref=?`)
      .get(input.originKind, input.originRef) as PetRow | undefined;
    if (existing) return rowToPet(existing);
    const pet: Pet = {
      id: `pet_${nanoid(10)}`,
      species: input.species,
      seed: input.seed,
      name: null,
      fed: 0,
      originKind: input.originKind,
      originRef: input.originRef,
      hatchedAt: input.hatchedAt,
      // The first four in stand in the vivarium without being asked for: an empty
      // enclosure under a full queue is the state that teaches an operator the
      // corner is decoration and to stop looking at it.
      placed: this.placedCount() < VIVARIUM_SLOTS,
    };
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO pets (id, species, seed, name, fed, origin_kind, origin_ref, hatched_at, placed)
         VALUES (@id, @species, @seed, @name, @fed, @originKind, @originRef, @hatchedAt, @placed)`,
      )
      .run({ ...pet, placed: pet.placed ? 1 : 0 });
    return pet;
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
   * Every action key already rolled, as `<kind>:<ref>`.
   *
   * The whole of what makes a re-scan a no-op, and the reason the scan needs no
   * watermark: an action in this set is skipped rather than re-rolled, so a
   * source whose timestamp moves under it — a plan re-saved, a finding re-triaged
   * — cannot pay out twice or consume a second slot of the pity counter.
   */
  petActionKeys(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT kind, ref FROM pet_actions`).all() as { kind: string; ref: string }[];
    return new Set(rows.map((row) => `${row.kind}:${row.ref}`));
  }

  /**
   * Actions rolled since the last one that hatched something.
   *
   * Counted over the ordered table rather than kept in a column: a stored counter
   * is one more thing a torn write can leave wrong, and wrong here means the pity
   * rule either never fires or fires forever, neither of which announces itself.
   *
   * **Ordered by `rowid`, not by `at`.** A scan settles several actions in one
   * pass and a busy minute stamps them identically, so a timestamp comparison
   * counts a tie as "not after" and quietly reports zero — the counter then never
   * moves and pity never fires, with every row present and correct.
   */
  petActionsSinceHatch(): number {
    const row = this.ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pet_actions
          WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM pet_actions WHERE pet_id IS NOT NULL)`,
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Spend beats on one pet.
   *
   * Two writes in one transaction: the purchase is the record and `fed` is the
   * cache of it, so a crash between them would leave a pet that was paid for and
   * did not grow. Nothing un-feeds — a fed pet is a decision about a finite
   * thing, which is the only reason feeding one rather than another means
   * anything.
   */
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

  renamePet(id: string, name: string | null): Pet | null {
    const changed = this.ctx.db.prepare(`UPDATE pets SET name=? WHERE id=?`).run(name, id).changes;
    return changed === 0 ? null : this.getPet(id);
  }

  placePet(id: string, placed: boolean): Pet | null {
    const changed = this.ctx.db.prepare(`UPDATE pets SET placed=? WHERE id=?`).run(placed ? 1 : 0, id).changes;
    return changed === 0 ? null : this.getPet(id);
  }

  /** Every beat ever spent. The only input to the wallet's `spent`. */
  petBeatsSpent(): number {
    const row = this.ctx.db.prepare(`SELECT COALESCE(SUM(beats), 0) AS total FROM pet_purchases`).get() as {
      total: number;
    };
    return row.total;
  }
}

/**
 * How many pets stand in the vivarium at once.
 *
 * Four rather than all of them because the rail is 268 pixels wide, and an
 * enclosure that scrolled would be a second queue in the one column of the screen
 * reserved for the first.
 */
export const VIVARIUM_SLOTS = 4;

interface PetRow {
  id: string;
  species: string;
  seed: string;
  name: string | null;
  fed: number;
  origin_kind: string;
  origin_ref: string;
  hatched_at: string;
  placed: number;
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
    placed: row.placed === 1,
  };
}
