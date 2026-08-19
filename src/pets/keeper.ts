import type { Store } from '../store/store.js';
import type { Pet, PetReset, PetWallet } from '../types.js';
import type { PetState, PetView } from '../wire.js';
import { VIVARIUM_SLOTS } from '../store/pets.js';
import { attestPet, provenanceOf, replayBarren, replayChain, type PetLedger } from './attest.js';
import { buildStamp, type PetBuildStamp } from './build.js';
import { beatsToNextStage, blendValue, petStage, SPECIES } from './catalogue.js';
import { rollAction } from './roll.js';
import { PET_RULES, type PetRules } from './rules.js';
import { collectActions } from './scan.js';

/**
 * The whole of what an operator may say about pets.
 *
 * **One switch, and nothing that is a number.** Every rate this feature runs on
 * used to be a key here, and each of them was a way of writing a pet into
 * existence without doing anything — a drop chance of 1, a pity of 1, a rarity
 * table zeroed everywhere but `mythic`. They now live as constants in
 * `src/pets/rules.ts`, which is what lets a collection mean the same thing on
 * every deployment. → `docs/spec/22-pets.md#authenticity`
 *
 * `enabled` is safe to keep because off is the one direction that cannot mint
 * anything: it hides the vivarium and stops the scan, and deletes nothing.
 */
export interface PetPolicy {
  enabled: boolean;
}

/** A refusal the route returns as a 400, or the pet the act produced. */
type PetResult = { ok: true; pet: Pet } | { ok: false; error: string };

/**
 * The vivarium: what has hatched, what it has been fed, and the one scan that
 * decides both.
 *
 * A **lens**. It reads what the operator has already done and writes only its own
 * five tables; nothing it holds is read by a rule, a gate, a rank or a report,
 * and `test/pets.test.ts` asserts structurally that `src/dispatcher/` never
 * imports any of it. The day that assertion fails, the fix is the import.
 */
export class PetKeeper {
  constructor(
    private readonly store: Store,
    private readonly policy: PetPolicy,
    /**
     * The rates, which are constants everywhere but here.
     *
     * A parameter only so the suite can roll against a certain drop chance instead
     * of manufacturing a hundred escalations per assertion. **Nothing threads it
     * from configuration** — `src/system.ts` passes two arguments, and
     * `test/pets.test.ts` asserts that no config key reaches it.
     */
    private readonly rules: PetRules = PET_RULES,
    /**
     * Which build is doing the hatching and the judging.
     *
     * A parameter for the same reason `rules` is: the suite has to be able to say
     * "this pet was rolled by this build" without a git checkout underneath it.
     * The default reads the running install once and remembers it.
     */
    private readonly stamp: () => PetBuildStamp = buildStamp,
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
   *
   * An action stamped **before the vivarium started** is recorded and rolls
   * nothing. That is the whole of what stops a build shipping pets to a long-lived
   * database from treating a year of escalations, jobs and findings as this
   * afternoon's work — and it is recorded rather than passed over, because an
   * unrecorded action stays fresh forever and would pay the whole backlog out at
   * once the day anything moved the boundary.
   */
  scan(): Pet[] {
    if (!this.policy.enabled) return [];
    // Stamped here rather than in the `Store`'s constructor, so a deployment
    // sitting with `pets.enabled` false for months does not silently burn its
    // start date on boots that could hatch nothing anyway. It does mean the value
    // depends on ordering in `src/server/main.ts` — `resetOnce` runs before the
    // first cycle scan — and a route that scanned earlier would stamp it seconds
    // early, which costs nothing but is why this is worth saying.
    const since = this.store.beginVivarium();
    const seen = this.store.petActionKeys();
    const fresh = collectActions(this.store)
      .filter((action) => !seen.has(`${action.kind}:${action.ref}`))
      .sort((a, b) => a.at.localeCompare(b.at));
    const hatched: Pet[] = [];
    // One counter per kind. A single counter is spent by whatever the deployment
    // does most — jobs and findings, by an order of magnitude — so the kinds a
    // pity floor is actually for never reach theirs.
    const sinceHatch = this.store.petActionsSinceHatch(since);
    // Carried across the pass rather than re-read per action, and asked of the
    // rolls rather than of `seen`: the key set holds the backlog too, so a
    // deployment taking this build has thousands of keys and has still never
    // rolled anything. Re-reading it per action instead would call *every* action
    // in a first scan the deployment's first — seven guaranteed pets out of one
    // afternoon, which is the thing having a single guarantee exists to stop.
    let anyRolled = this.store.petRolledSince(since);
    for (const action of fresh) {
      if (action.at < since) {
        // Inert, not pending: written with no pet so a re-scan stays free, and
        // touching neither the pity counter nor the guarantee.
        this.store.recordPetAction({ kind: action.kind, ref: action.ref, at: action.at, petId: null });
        continue;
      }
      const firstEver = !anyRolled;
      const missed = sinceHatch.get(action.kind) ?? 0;
      const forced = missed + 1 >= this.rules.rates[action.kind].pity;
      const roll = rollAction(action.kind, action.ref, action.at, { rules: this.rules, forced, firstEver });
      const build = roll.hatches ? this.stamp() : null;
      const pet =
        build === null
          ? null
          : this.store.hatchPet({
              species: roll.species,
              seed: `${action.kind}:${action.ref}`,
              originKind: action.kind,
              originRef: action.ref,
              hatchedAt: action.at,
              builtSha: build.sha,
              builtClean: build.clean,
            });
      this.store.recordPetAction({ kind: action.kind, ref: action.ref, at: action.at, petId: pet?.id ?? null });
      anyRolled = true;
      if (pet) hatched.push(pet);
      sinceHatch.set(action.kind, pet ? 0 : missed + 1);
    }
    return hatched;
  }

  /**
   * Release the whole collection, once, and start the beats again from zero.
   *
   * **Runs at most once per deployment**, and the row it writes is what says so:
   * `VIVARIUM_RESET` names *this* clearance, so a restart, a restored backup and
   * an upgrade all find it already done. A build that asked "has any clearance
   * run" instead could never ship a second one.
   *
   * What goes is the collection and the ledger under it — pets, purchases and
   * blend credits. What stays is `pet_actions`, and it has to: it is the scan's
   * watermark, so an action that has already been rolled is skipped rather than
   * rolled again, and the released collection cannot hatch straight back out of
   * the history it came from. What is re-stamped, in the same transaction, is the
   * vivarium's start: those surviving rows all fall before it, so they are inert
   * rather than merely spent — no pity floor inherited from them, and the
   * deployment's one first-action guarantee handed back. The vivarium starts again
   * from what the operator does *next*, which is the whole of what "from here on"
   * means.
   *
   * Skipped entirely while `pets.enabled` is off, because off is the one setting
   * that has never deleted anything and this is not the change that makes it. A
   * deployment that turns the vivarium on later gets the clearance then.
   *
   * Returns what it released, or null when there was nothing to do.
   */
  resetOnce(): PetReset | null {
    if (!this.policy.enabled) return null;
    if (this.store.petResetAt(VIVARIUM_RESET) !== null) return null;
    return this.store.clearVivarium(VIVARIUM_RESET);
  }

  /** What the cockpit draws, or null when the feature is off. */
  state(): PetState | null {
    if (!this.policy.enabled) return null;
    // One ledger for the whole grid rather than two queries per card: the snapshot
    // is what the socket redraws, and a per-pet read here is a per-pet read on
    // every pulse.
    const ledger = this.ledger();
    return {
      pets: this.store.listPets().map((pet) => this.view(pet, ledger)),
      wallet: this.wallet(),
      slots: VIVARIUM_SLOTS,
    };
  }

  /**
   * Crack an egg open — the one act that reveals rather than decides.
   *
   * Nothing is rolled here. The species and the tier were settled by
   * `hash32(kind:ref)` the instant the scan reached the action, and the shell only
   * withholds them; a roll at this point would move the subsystem's one decision
   * from the action to the click, and with it every guarantee the hash buys — a
   * re-scan would stop being free, and two operators on one database would open
   * different animals out of one egg.
   *
   * **A second open is a success, not a refusal.** A double click, a retried
   * request and a reload of a shared link all arrive here after the stamp is set,
   * and none of them is the operator getting something wrong — the store's own
   * `opened_at IS NULL` guard means they change nothing either way.
   */
  open(id: string): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    const existing = this.store.getPet(id);
    if (existing === null) return { ok: false, error: 'no such pet' };
    if (existing.openedAt !== null) return { ok: true, pet: existing };
    const pet = this.store.openPet(id);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  feed(id: string, beats: number): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    if (!Number.isInteger(beats) || beats <= 0) return { ok: false, error: 'beats must be a whole number above zero' };
    const wallet = this.wallet();
    if (beats > wallet.balance)
      return { ok: false, error: `only ${wallet.balance} beats to spend — the fleet has not earned that many yet` };
    const existing = this.store.getPet(id);
    if (existing !== null && existing.dissolvedAt !== null)
      return { ok: false, error: 'that one was blended — a dissolved pet keeps its record but stops growing' };
    // The flaw is checked before the shell, here and in `blend`: a pet that does
    // not verify is refused for *that*, whether or not it has been opened, because
    // "open it first" on a forgery is an invitation to carry on.
    const flawed = existing === null ? null : this.refuseFlawed(existing, 'fed');
    if (flawed !== null) return flawed;
    // Growth is a decision about a creature, and an egg is not one yet: what the
    // beats would be buying is hidden from the operator spending them.
    if (existing !== null && existing.openedAt === null)
      return { ok: false, error: 'that one is still an egg — open it before you feed it' };
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
    const existing = this.store.getPet(id);
    if (placed && existing !== null && existing.dissolvedAt !== null)
      return { ok: false, error: 'that one was blended — a dissolved pet cannot stand in the vivarium' };
    // Only on the way *in*: a pet that stops verifying while it stands there can
    // always be taken out again, and refusing that would strand it in the rail.
    const flawed = placed && existing !== null ? this.refuseFlawed(existing, 'put out') : null;
    if (flawed !== null) return flawed;
    const pet = this.store.placePet(id, placed);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  /**
   * Dissolve a duplicate into beats.
   *
   * **Marks, never deletes.** The row keeps its species, its seed and its origin
   * line — the night you answered the thing that produced it — because that line
   * is the one part of this subsystem that gets better the longer a deployment
   * runs, and a `DELETE` takes it with the animal. The panel draws a dissolved pet
   * greyed with its date; it simply stops being feedable, placeable and alive.
   *
   * Only a **duplicate** may go: blending is a use for a species you already have
   * standing, so the last live one of its kind is refused. That is what keeps this
   * from being a way to lose something.
   *
   * And only a pet that **verifies**. This is the single route from a creature back
   * into beats, so an unchecked one would let a row written straight into the file
   * be laundered into food for the honest animals beside it.
   */
  blend(id: string): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    const pet = this.store.getPet(id);
    if (pet === null) return { ok: false, error: 'no such pet' };
    if (pet.dissolvedAt !== null) return { ok: false, error: 'that one has already been blended' };
    const flawed = this.refuseFlawed(pet, 'blended');
    if (flawed !== null) return flawed;
    // The last guard against losing something unseen: an unopened shell is not a
    // duplicate yet, whatever the species column says, because nobody has been
    // shown what is in it.
    if (pet.openedAt === null)
      return { ok: false, error: 'that one is still an egg — open it before you decide it is a duplicate' };
    if (this.store.livePetsOfSpecies(pet.species) < 2) {
      // The species is named only once the pet is old enough to have said so
      // itself. A hatchling has not — one grid serves every animal of a tier — so
      // a refusal that named it would hand over, in an error message, the answer
      // the whole juvenile stage exists to make you wait for.
      const { display } = SPECIES[pet.species];
      const which = petStage(pet.species, pet.fed) === 'hatchling' ? 'one of these' : display;
      return { ok: false, error: `this is your only ${which} — blending is for duplicates` };
    }
    const blended = this.store.blendPet(id, blendValue(pet.species, this.rules.blendYield));
    return blended ? { ok: true, pet: blended } : { ok: false, error: 'no such pet' };
  }

  /**
   * The refusal a pet that does not verify earns, or null when it does.
   *
   * Feeding, placing and blending all go through it, and blending is the one that
   * matters — the other two only spend beats on something that is not real, which
   * costs the operator and nobody else.
   */
  private refuseFlawed(pet: Pet, act: string): { ok: false; error: string } | null {
    const flaw = attestPet(pet, this.ledger());
    if (flaw === null) return null;
    return { ok: false, error: `that one does not check out — ${flaw.note} — so it cannot be ${act}` };
  }

  /**
   * Everything an attestation is made against, built once.
   *
   * Four reads and two replays over a few hundred rows — the whole vivarium's
   * worth, rather than a query and a walk per card. Both replays are a handful of
   * hashes an action, which is cheap enough to redo on every snapshot rather than
   * cache into a column nothing can keep in step.
   */
  private ledger(): PetLedger {
    return {
      actions: this.store.petActionIndex(),
      paid: this.store.petPaidTotals(),
      chain: replayChain(this.store.petChainLog()),
      barren: replayBarren(this.store.petActionLog(), this.rules, this.store.vivariumStart() ?? EPOCH),
      build: this.stamp(),
    };
  }

  /**
   * Beats earned, spent and left — derived on every read, never accumulated into
   * a column. `usage_events` only ever grows, so the earned figure only ever grows
   * with it, and a restore or a recount moves the balance to the truth rather than
   * to the truth plus whatever a column had remembered.
   */
  private wallet(): PetWallet {
    // Fleet spend plus what duplicates have been blended back. The blend credit is
    // *stored* rather than derived from the dissolved rows, because a yield this
    // build ships is not necessarily the yield the credit was granted under.
    // Spend since the last clearance, not since the beginning. `usage_events` is
    // never pruned, so a cleared vivarium counted from the beginning would open
    // holding every beat the deployment had ever earned — a full grown collection
    // one afternoon's clicking away, which is exactly what clearing it was for.
    const earned =
      Math.floor(this.store.sumUsageCostSince(this.store.petEpoch() ?? EPOCH) * this.rules.beatsPerDollar) +
      this.store.petBlendCredits();
    const spent = this.store.petBeatsSpent();
    return { earned, spent, balance: Math.max(0, earned - spent) };
  }

  private view(pet: Pet, ledger: PetLedger): PetView {
    const { rarity, display } = SPECIES[pet.species];
    return {
      ...pet,
      rarity,
      display,
      stage: petStage(pet.species, pet.fed),
      beatsToNextStage: beatsToNextStage(pet.species, pet.fed),
      flaw: attestPet(pet, ledger),
      provenance: provenanceOf(pet),
    };
  }
}

/**
 * Before any timestamp this harness can hold, so `at >= EPOCH` is every usage
 * event ever recorded — and, on a vivarium that has never been scanned, every
 * action ever rolled. An empty string would compare the same way and read as an
 * accident.
 */
const EPOCH = '0000-01-01T00:00:00.000Z';

/**
 * The name of the clearance this build carries, and the only thing that decides
 * whether a deployment has had it.
 *
 * **Never edited in place.** Changing this string is not a rename: it is a second
 * clearance, and it releases every collection on every deployment that takes the
 * build — silently, since a wipe that ran as designed has nothing to report and
 * `npm run check` has no opinion about a constant. A new clearance is a new id,
 * added deliberately, and the old one stays where it is so the deployments that
 * have had it are not given it twice.
 */
const VIVARIUM_RESET = 'mark-two';
