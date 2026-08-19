import type { Store } from '../store/store.js';
import type { Pet, PetWallet } from '../types.js';
import type { PetState, PetView } from '../wire.js';
import { VIVARIUM_SLOTS } from '../store/pets.js';
import { beatsToNextStage, petStage, SPECIES } from './catalogue.js';
import { rollAction } from './roll.js';
import { collectActions } from './scan.js';

/** What the operator can tune. Every field is a number an operator can feel. */
export interface PetPolicy {
  enabled: boolean;
  /** Beats per dollar of fleet spend. Raising it makes every pet cheaper to raise. */
  beatsPerDollar: number;
  /** Chance one qualifying operator action hatches something, before pity. */
  dropChance: number;
  /** Actions without a hatch before the next one is forced. */
  pity: number;
}

/** A refusal the route returns as a 400, or the pet the act produced. */
type PetResult = { ok: true; pet: Pet } | { ok: false; error: string };

/**
 * The vivarium: what has hatched, what it has been fed, and the one scan that
 * decides both.
 *
 * A **lens**. It reads what the operator has already done and writes only its own
 * three tables; nothing it holds is read by a rule, a gate, a rank or a report,
 * and `test/pets.test.ts` asserts structurally that `src/dispatcher/` never
 * imports any of it. The day that assertion fails, the fix is the import.
 */
export class PetKeeper {
  constructor(
    private readonly store: Store,
    private readonly policy: PetPolicy,
  ) {}

  /**
   * Roll every operator action not yet rolled, oldest first, and hatch what comes
   * of it. Returns what hatched, for the caller that wants to say so.
   *
   * Safe to call as often as anything likes: an action already recorded is skipped
   * by key, and the roll is a hash, so the second call over the same world writes
   * nothing. That is what lets the routes call it for latency while `cycle:end`
   * remains the thing that guarantees delivery — **forgetting the call on a new
   * route costs a delay, never a pet.**
   */
  scan(): Pet[] {
    if (!this.policy.enabled) return [];
    const seen = this.store.petActionKeys();
    const fresh = collectActions(this.store)
      .filter((action) => !seen.has(`${action.kind}:${action.ref}`))
      .sort((a, b) => a.at.localeCompare(b.at));
    const hatched: Pet[] = [];
    let sinceHatch = this.store.petActionsSinceHatch();
    // Carried across the pass rather than re-read per action. `seen` is captured
    // before the loop, so asking it would call *every* action in a first scan the
    // deployment's first — seven guaranteed pets out of one afternoon, which is
    // the thing having a single guarantee exists to stop.
    let anyRolled = seen.size > 0;
    for (const action of fresh) {
      const firstEver = !anyRolled;
      const forced = sinceHatch + 1 >= this.policy.pity;
      const roll = rollAction(action.kind, action.ref, action.at, {
        dropChance: this.policy.dropChance,
        forced,
        firstEver,
      });
      const pet = roll.hatches
        ? this.store.hatchPet({
            species: roll.species,
            seed: `${action.kind}:${action.ref}`,
            originKind: action.kind,
            originRef: action.ref,
            hatchedAt: action.at,
          })
        : null;
      this.store.recordPetAction({ kind: action.kind, ref: action.ref, at: action.at, petId: pet?.id ?? null });
      anyRolled = true;
      if (pet) {
        hatched.push(pet);
        sinceHatch = 0;
      } else {
        sinceHatch += 1;
      }
    }
    return hatched;
  }

  /** What the cockpit draws, or null when the feature is off. */
  state(): PetState | null {
    if (!this.policy.enabled) return null;
    return { pets: this.store.listPets().map((pet) => this.view(pet)), wallet: this.wallet(), slots: VIVARIUM_SLOTS };
  }

  feed(id: string, beats: number): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    if (!Number.isInteger(beats) || beats <= 0) return { ok: false, error: 'beats must be a whole number above zero' };
    const wallet = this.wallet();
    if (beats > wallet.balance)
      return { ok: false, error: `only ${wallet.balance} beats to spend — the fleet has not earned that many yet` };
    const pet = this.store.feedPet(id, beats);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  /** An empty name restores the species' own, which is why null is a value here. */
  rename(id: string, name: string | null): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    const pet = this.store.renamePet(id, name);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  place(id: string, placed: boolean): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    // Counted before the write rather than trimmed after it: silently evicting
    // whoever was there is the cockpit deciding something the operator did not.
    if (placed && this.store.placedCount() >= VIVARIUM_SLOTS) {
      const already = this.store.getPet(id);
      if (already !== null && !already.placed)
        return { ok: false, error: `the vivarium holds ${VIVARIUM_SLOTS} — take one out first` };
    }
    const pet = this.store.placePet(id, placed);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  /**
   * Beats earned, spent and left — derived on every read, never accumulated into
   * a column. `usage_events` only ever grows, so the earned figure only ever grows
   * with it, and a restore or a recount moves the balance to the truth rather than
   * to the truth plus whatever a column had remembered.
   */
  private wallet(): PetWallet {
    const earned = Math.floor(this.store.sumUsageCostSince(EPOCH) * this.policy.beatsPerDollar);
    const spent = this.store.petBeatsSpent();
    return { earned, spent, balance: Math.max(0, earned - spent) };
  }

  private view(pet: Pet): PetView {
    const { rarity, display } = SPECIES[pet.species];
    return {
      ...pet,
      rarity,
      display,
      stage: petStage(pet.species, pet.fed),
      beatsToNextStage: beatsToNextStage(pet.species, pet.fed),
    };
  }
}

/**
 * Before any timestamp this harness can hold, so `at >= EPOCH` is every usage
 * event ever recorded. An empty string would compare the same way and read as an
 * accident.
 */
const EPOCH = '0000-01-01T00:00:00.000Z';
