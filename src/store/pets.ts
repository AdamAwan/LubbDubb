import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Pet, PetAction, PetActionKind, PetReset, PetSpecies } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

/**
 * `pets` was introduced as a fresh `CREATE TABLE` and needed no entry here.
 * `dissolved_at`, added now, does: `CREATE TABLE IF NOT EXISTS` never alters an
 * existing table, so without this the column is invisible on every database from
 * before blending existed — and invisible is the whole failure, since a pet whose
 * `dissolved_at` reads `undefined` is simply alive again.
 */
export const PET_COLUMNS: ColumnMigrations = {
  pets: {
    dissolved_at: `TEXT`,
    // Null spells *still an egg*, which is why this one needs a backfill as well
    // as an `ALTER TABLE` — see `openPetsFromBeforeEggs`.
    opened_at: `TEXT`,
    // The three authenticity columns. Every one of them reads as a *weaker* claim
    // when absent rather than a false one — a pet from before them carries no
    // build and no chain link, and `attest.ts` declines to judge it rather than
    // calling it a forgery. That asymmetry is deliberate: the failure that would
    // matter most here is telling an honest operator their collection is fake.
    built_sha: `TEXT`,
    built_clean: `INTEGER NOT NULL DEFAULT 0`,
    chain: `TEXT`,
  },
};

/**
 * The five `pet_*` tables: what has hatched, every operator action that has been
 * rolled, every beat that has been spent, every clearance that has released the
 * collection, and the one row saying when this vivarium started counting.
 *
 * Each arrived as a fresh `CREATE TABLE` and so needed no `ColumnMigrations` entry
 * — and a table being new **once** does not keep it exempt: `pets` has needed one
 * since `dissolved_at`, and a column added to any of the others later will too.
 *
 * Nothing here is derived twice. The wallet is a sum over `pet_purchases` from the
 * last clearance's stamp onwards, the pity counter is a count over `pet_actions`,
 * and neither is cached in a column, because a running total is a second copy of a
 * number these tables already hold and it drifts the first time a write lands
 * twice.
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
    /** The build that rolled it. The keeper resolves it; nothing here runs git. */
    builtSha?: string | null;
    builtClean?: boolean;
  }): Pet {
    // A drop writes an egg — `opened_at` null — and nothing here decides when it
    // is opened. The species and tier are already in `input`, settled by the hash
    // of the action: the shell withholds them, it does not choose them.
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
      // The first four in stand in the vivarium without being asked for: an empty
      // enclosure under a full queue is the state that teaches an operator the
      // corner is decoration and to stop looking at it.
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
   * Every pet in the order it was written, with the link it carries.
   *
   * Insertion order, not `hatched_at`: the chain is built as rows are inserted, and
   * a scan settling a backlog writes several pets whose hatch times run backwards
   * against the order they were chained in.
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
   * Every action key already rolled, as `<kind>:<ref>`.
   *
   * The whole of what makes a re-scan a no-op: an action in this set is skipped
   * rather than re-rolled, so a source whose timestamp moves under it — a plan
   * re-saved, a finding re-triaged — cannot pay out twice or consume a second slot
   * of the pity counter. It is a set of keys and not a watermark, which is why an
   * action from before the vivarium started is still written here: skipping it
   * unrecorded would leave it fresh forever.
   *
   * It says nothing about whether anything has been *rolled* — see
   * {@link petRolledSince}, which is the question the first-action guarantee asks.
   */
  petActionKeys(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT kind, ref FROM pet_actions`).all() as { kind: string; ref: string }[];
    return new Set(rows.map((row) => `${row.kind}:${row.ref}`));
  }

  /**
   * Every rolled action in the order it was written, with what it came to.
   *
   * **`rowid`, not `at`** — the same reason {@link petActionsSinceHatch} counts
   * that way. A scan settles several actions in one pass and a busy minute stamps
   * them identically, so an order taken from the timestamp is not the order pity
   * counted them in, and a replay reading it would disagree with the harness about
   * which action was forced.
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
   * Every rolled action, by key, with what it came to.
   *
   * The wider read behind {@link petActionKeys}, and what an attestation is
   * checked against: a pet whose origin names no row here, or a row that hatched
   * something else, was not put there by the scan. Read once per snapshot and
   * shared across the whole vivarium — the alternative is a query per card on a
   * surface the socket redraws constantly.
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

  /**
   * What each pet's purchases actually paid for, by pet id.
   *
   * `pets.fed` is a cache of this sum, written in the same transaction as the
   * purchase. The two disagreeing means either a torn write or a hand-edited
   * column, and both read identically from the card: a creature further along
   * than anything bought it.
   */
  petPaidTotals(): Map<string, number> {
    const rows = this.ctx.db
      .prepare(`SELECT pet_id, COALESCE(SUM(beats), 0) AS total FROM pet_purchases GROUP BY pet_id`)
      .all() as { pet_id: string; total: number }[];
    return new Map(rows.map((row) => [row.pet_id, row.total]));
  }

  /**
   * Actions rolled since the last one that hatched something, **per kind**.
   *
   * One counter per action kind rather than one over the whole table, and the
   * reason is the shape of a real deployment rather than a preference: the
   * harness settles jobs and findings by the dozen and accepts an upgrade a few
   * times a year, so a shared counter is spent almost entirely by whichever
   * action is most frequent. The scarce kinds then never reach their ceiling —
   * pity fires constantly on job launches and, in practice, never on a landing
   * or a self-update, which is the opposite of what a floor is for. Sparse by
   * design: a kind with no rolled actions has no row and reads as zero.
   *
   * Counted over the ordered table rather than kept in a column: a stored counter
   * is one more thing a torn write can leave wrong, and wrong here means the pity
   * rule either never fires or fires forever, neither of which announces itself.
   *
   * **Ordered by `rowid`, not by `at`.** A scan settles several actions in one
   * pass and a busy minute stamps them identically, so a timestamp comparison
   * counts a tie as "not after" and quietly reports zero — the counter then never
   * moves and pity never fires, with every row present and correct.
   *
   * **`since` is the vivarium's start, and rows older than it do not count.** They
   * are in the table — recorded so a re-scan stays free — but they were never
   * rolled, and counting them would hand the deployment's first genuine action a
   * pity floor built out of a backlog nobody was paid for. The one place that is
   * *not* a `rowid` comparison, because a boundary is a time and only a time.
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

  /**
   * Whether anything at or after the vivarium's start has been rolled yet.
   *
   * The `firstEver` signal, and it is a query rather than `petActionKeys().size`
   * because that set holds the backlog too: a deployment that took this build with
   * months of history behind it has thousands of keys and has still never rolled
   * anything, and the one guaranteed drop belongs to the first thing its operator
   * does *after* the vivarium started.
   */
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
   * The vivarium's start, stamping it on the one boot that has none.
   *
   * The row's own absence is the migration gate, and the value it takes is the
   * whole of the migration decision:
   *
   * - **`pet_actions` empty → `now()`.** Nothing here has ever been rolled, so
   *   nothing is being cut off. The deployment's whole history is recorded inert
   *   and its first pet comes from what the operator does next — which is the
   *   point: a build that shipped pets to a year-old database would otherwise roll
   *   that year in one pass and spend the first-action guarantee on an escalation
   *   answered last spring.
   * - **`pet_actions` non-empty → `MIN(at)` over it.** Every row that has already
   *   been rolled is then at or after the start, which makes the filter a provable
   *   no-op for an existing collection: the same pity walk, the same `firstEver`,
   *   the same replay, the same pets. A start of `now()` here would mark honestly
   *   earned actions pre-boundary and put an `unearned` badge on somebody's real
   *   animal on the boot they took the build.
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

  /**
   * Crack one open, stamping the moment the operator did it.
   *
   * `opened_at IS NULL` in the `WHERE`, so a second click — a double tap, a
   * retried request, two tabs — changes nothing and reports it by returning the
   * row unchanged rather than by moving the stamp. The reveal is a ceremony over a
   * decided outcome, so there is nothing here to re-run.
   */
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

  /**
   * How many of this species are still alive.
   *
   * What `blend` reads to refuse the last one of its kind: dissolving a duplicate
   * is a use for surplus, and dissolving your only Ouroboros is losing something.
   */
  livePetsOfSpecies(species: PetSpecies): number {
    const row = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM pets WHERE species=? AND dissolved_at IS NULL`)
      .get(species) as { n: number };
    return row.n;
  }

  /**
   * Dissolve one duplicate into beats.
   *
   * Two writes in one transaction, the same shape as {@link feedPet}: the credit
   * is the record and the stamp is what the cockpit draws, and a crash between
   * them would either pay for a pet still standing or dissolve one for nothing.
   * The row is **marked, never deleted** — its origin line is the point of the
   * panel. It also leaves the vivarium, because a dissolved animal holding one of
   * four slots is a slot nobody can use.
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

  /**
   * The newest clearance's stamp, which is the floor the wallet counts spend from.
   *
   * `MAX(at)` rather than the newest row: a clearance is stamped when it runs, and
   * insertion order and time agree here only because nothing ever back-dates one.
   * Taking the maximum is the same answer today and the safe one if that changes.
   */
  petEpoch(): string | null {
    const row = this.ctx.db.prepare(`SELECT MAX(at) AS at FROM pet_resets`).get() as { at: string | null };
    return row.at;
  }

  /**
   * Release the whole collection, and stamp when.
   *
   * **`pet_actions` is deliberately left standing.** An action whose key is in it
   * is skipped rather than re-rolled, so keeping it is the whole of what stops the
   * next scan hatching the released collection straight back out of the same
   * history. Clearing it too would read as the tidier wipe and would undo itself
   * on the next pulse.
   *
   * Purchases and blends go with the pets, because a beat spent on a creature
   * that no longer exists is a balance drawn down against nothing. One
   * transaction: a crash between the deletes would leave purchases pointing at
   * pets that had gone, which reads from the wallet as spend nobody can account
   * for.
   *
   * **The start is re-stamped in that same transaction**, which is what makes
   * "starts the beats again from zero" true of the rolls as well as the wallet:
   * every surviving `pet_actions` row falls before the new start, so the backlog a
   * clearance leaves standing is inert rather than merely spent — no pity floor
   * inherited from it, and the first-action guarantee handed back to whatever the
   * operator does next.
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

/**
 * How many pets stand in the vivarium at once.
 *
 * Four rather than all of them because the rail is 268 pixels wide, and an
 * enclosure that scrolled would be a second queue in the one column of the screen
 * reserved for the first.
 */
export const VIVARIUM_SLOTS = 4;

/**
 * The identity fields one link covers.
 *
 * Everything that says *which creature this is and where it came from*, and
 * nothing that legitimately changes afterwards: `name`, `fed`, `placed` and
 * `dissolved_at` all move in ordinary use, and a chain over them would break on
 * the first rename.
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
 * One link: this pet's identity, hashed onto the link before it.
 *
 * **What it buys, precisely.** A pet cannot be edited or slipped into the middle
 * of the collection without every link after it going wrong, and recomputing the
 * tail is work an idle `UPDATE` will not do. What it does *not* buy is protection
 * against an append: a forger writing the newest row can chain onto the newest
 * link as easily as the harness can. That is a real limit and it is why the chain
 * is one check of several rather than the check.
 *
 * SHA-256 rather than the `hash32` the roll uses: a 32-bit link is a chain anybody
 * can collide by trying, and unlike the roll there is no reason here to want a
 * number small enough to index with.
 *
 * @public — recomputed by `src/pets/attest.ts`, which is the only reader.
 */
/**
 * Stamp every pet that predates the shell as already opened.
 *
 * Run **only on the boot `pets.opened_at` arrives**, which is why `ensureColumns`
 * reports what it added. Null in that column means *still an egg*, so a vivarium
 * raised over months would come back as a crate of shells the day the operator
 * takes this build — every creature they know redrawn as an anonymous egg, with
 * nothing red and no way back but clicking through the lot. Stamped with
 * `hatched_at`, because a pet from before eggs was revealed the moment it dropped
 * and that is the honest time to give it.
 *
 * Ungated it is the same silence pointed the other way: it would open, on every
 * restart, every egg the operator had deliberately left sitting.
 *
 * @public — called by `Store`'s constructor, the only place that knows a column
 * was just added.
 */
export function openPetsFromBeforeEggs(db: Database.Database): void {
  db.prepare(`UPDATE pets SET opened_at = hatched_at WHERE opened_at IS NULL`).run();
}

/**
 * The chain covers what the **roll** decided, and deliberately not `opened_at`.
 *
 * Opening is the operator's own act on a creature whose species, tier and origin
 * were settled the instant it was rolled — none of which this touches. Hashing it
 * in would break every link the moment a shell came off, and an honest collection
 * would start reporting `broken-chain` on the pets its owner had just enjoyed most.
 */
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
    // Nullable *and* possibly absent: added by `ensureColumns` on databases from
    // an older build, where the read would otherwise be `undefined` rather than null.
    dissolvedAt: row.dissolved_at ?? null,
    builtSha: row.built_sha ?? null,
    builtClean: row.built_clean === 1,
    chain: row.chain ?? null,
  };
}
