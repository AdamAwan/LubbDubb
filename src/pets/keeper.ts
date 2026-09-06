import type { Store } from '../store/store.js';
import type { Pet, PetActionKind, PetReset, PetWallet } from '../types.js';
import type { PetState, PetView } from '../wire.js';
import { VIVARIUM_SLOTS } from '../store/pets.js';
import { attestPet, provenanceOf, replayBarren, replayChain, type PetLedger } from './attest.js';
import { buildStamp, type PetBuildStamp } from './build.js';
import { beatsToNextStage, blendValue, petStage, SPECIES } from './catalogue.js';
import { rollAction } from './roll.js';
import { PET_RULES, type PetRules } from './rules.js';
import { collectActions } from './scan.js';

/**
 * The whole of what an operator may say about pets: two switches, no numbers — every rate lives
 * as a constant in `src/pets/rules.ts`. `enabled` off stops the scan and deletes nothing;
 * `visible` off hides the vivarium and changes nothing else — it keeps growing behind it.
 * → `docs/spec/22-pets.md#authenticity`, `docs/spec/22-pets.md#configuration`
 */
export interface PetPolicy {
  enabled: boolean;
  visible: boolean;
}

/** A refusal the route returns as a 400, or the pet the act produced. */
type PetResult = { ok: true; pet: Pet } | { ok: false; error: string };

/**
 * The vivarium: what has hatched, what it has been fed, and the one scan that decides both. A
 * lens — writes only its own five tables, and nothing it holds is read by a rule, gate, rank or
 * report. `test/pets.test.ts` asserts structurally that `src/dispatcher/` never imports any of it.
 */
export class PetKeeper {
  constructor(
    private readonly store: Store,
    private readonly policy: PetPolicy,
    /** The rates, constants everywhere but here — a parameter only so tests can roll a certain drop chance. Nothing threads it from configuration. */
    private readonly rules: PetRules = PET_RULES,
    /** Which build is doing the hatching and judging. A parameter for `rules`' reason; the default reads the running install once and remembers it. */
    private readonly stamp: () => PetBuildStamp = buildStamp,
  ) {}

  /**
   * Roll every operator action not yet rolled, oldest first, and hatch what comes of it.
   * Idempotent — an action already recorded is skipped by key — so forgetting the call on a new
   * route costs a delay, never a pet. An action stamped before the vivarium started is recorded
   * and rolls nothing; leaving it unrecorded would pay the whole backlog out the day the
   * boundary moved.
   */
  scan(): Pet[] {
    if (!this.policy.enabled) return [];
    // Stamped here, not in the `Store` constructor, so a deployment with pets off doesn't burn
    // its start date on boots that hatch nothing. Depends on `resetOnce` running first in `src/server/main.ts`.
    const since = this.store.beginVivarium();
    const seen = this.store.petActionKeys();
    const fresh = collectActions(this.store)
      .filter((action) => !seen.has(`${action.kind}:${action.ref}`))
      .sort((a, b) => a.at.localeCompare(b.at));
    const hatched: Pet[] = [];
    // One counter per kind, so a pity floor for a rare kind isn't spent by a common one.
    const sinceHatch = this.store.petActionsSinceHatch(since);
    // Carried across the pass rather than re-read per action, or every action in a first scan
    // would read as "the first ever" — a handful of guaranteed pets in one afternoon.
    let anyRolled = this.store.petRolledSince(since);
    for (const action of fresh) {
      if (action.at < since) {
        // Inert, not pending: written with no pet, touching neither pity nor the guarantee.
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
   * Release the whole collection, once, and start the beats again from zero. Runs at most once
   * per deployment, keyed on the `VIVARIUM_RESET` id. Pets, purchases and blend credits go;
   * `pet_actions` stays as the scan's watermark, and the vivarium's start is re-stamped in the
   * same transaction. Skipped while `pets.enabled` is off — off has never deleted anything.
   * Returns what it released, or null when there was nothing to do.
   * → `docs/spec/22-pets.md#clearing-the-vivarium`
   */
  resetOnce(): PetReset | null {
    if (!this.policy.enabled) return null;
    if (this.store.petResetAt(VIVARIUM_RESET) !== null) return null;
    return this.store.clearVivarium(VIVARIUM_RESET);
  }

  /**
   * What the cockpit draws, or null when the feature is off — or merely hidden, which the
   * cockpit is deliberately not told apart from off. Hidden is the only gate here that isn't
   * `enabled`; everything that hatches, feeds or clears stays on `enabled` alone.
   * → `docs/spec/22-pets.md#configuration`
   */
  state(): PetState | null {
    if (!this.policy.enabled || !this.policy.visible) return null;
    // One ledger for the whole grid, not a per-pet read every pulse.
    const ledger = this.ledger();
    const pets = this.store.listPets();
    const labels = this.originLabels(pets);
    return {
      pets: pets.map((pet) => this.view(pet, ledger, labels)),
      wallet: this.wallet(),
      slots: VIVARIUM_SLOTS,
      // Read, never stamped: `scan()` owns the stamp.
      startedAt: this.store.vivariumStart(),
    };
  }

  /**
   * Crack an egg open — the one act that reveals rather than decides. Nothing is rolled here:
   * species and tier were settled by `hash32(kind:ref)` when the scan reached the action.
   * A second open is a success, not a refusal.
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
    // The flaw is checked before the shell, here and in `blend`: "open it first" on
    // a forgery is an invitation to carry on.
    const flawed = existing === null ? null : this.refuseFlawed(existing, 'fed');
    if (flawed !== null) return flawed;
    // An egg hides what the beats would be buying from the operator spending them.
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
    // Counted before the write: silently evicting whoever was there is the cockpit deciding.
    if (placed && this.store.placedCount() >= VIVARIUM_SLOTS) {
      const already = this.store.getPet(id);
      if (already !== null && !already.placed)
        return { ok: false, error: `the vivarium holds ${VIVARIUM_SLOTS} — take one out first` };
    }
    const existing = this.store.getPet(id);
    if (placed && existing !== null && existing.dissolvedAt !== null)
      return { ok: false, error: 'that one was blended — a dissolved pet cannot stand in the vivarium' };
    // Only on the way *in*: refusing on the way out would strand the pet in the rail.
    const flawed = placed && existing !== null ? this.refuseFlawed(existing, 'put out') : null;
    if (flawed !== null) return flawed;
    const pet = this.store.placePet(id, placed);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  /** Dissolve a duplicate into beats. Marks, never deletes — the row keeps its species, seed and origin, and only stops being feedable, placeable and alive. Only a duplicate that verifies may go. */
  blend(id: string): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    const pet = this.store.getPet(id);
    if (pet === null) return { ok: false, error: 'no such pet' };
    if (pet.dissolvedAt !== null) return { ok: false, error: 'that one has already been blended' };
    const flawed = this.refuseFlawed(pet, 'blended');
    if (flawed !== null) return flawed;
    // An unopened shell is not a duplicate yet: nobody has been shown what is in it.
    if (pet.openedAt === null)
      return { ok: false, error: 'that one is still an egg — open it before you decide it is a duplicate' };
    if (this.store.livePetsOfSpecies(pet.species) < 2) {
      // The species is named only once the pet is old enough to have said so itself:
      // naming a hatchling's would give away what the juvenile stage withholds.
      const { display } = SPECIES[pet.species];
      const which = petStage(pet.species, pet.fed) === 'hatchling' ? 'one of these' : display;
      return { ok: false, error: `this is your only ${which} — blending is for duplicates` };
    }
    const blended = this.store.blendPet(id, blendValue(pet.species, this.rules.blendYield));
    return blended ? { ok: true, pet: blended } : { ok: false, error: 'no such pet' };
  }

  /** The refusal a pet that does not verify earns, or null when it does. Feeding, placing and blending all use it. */
  private refuseFlawed(pet: Pet, act: string): { ok: false; error: string } | null {
    const flaw = attestPet(pet, this.ledger());
    if (flaw === null) return null;
    return { ok: false, error: `that one does not check out — ${flaw.note} — so it cannot be ${act}` };
  }

  /** Everything an attestation is made against, built once per snapshot rather than per card — recomputed rather than cached into a column nothing keeps in step. */
  private ledger(): PetLedger {
    return {
      actions: this.store.petActionIndex(),
      paid: this.store.petPaidTotals(),
      chain: replayChain(this.store.petChainLog()),
      barren: replayBarren(this.store.petActionLog(), this.rules, this.store.vivariumStart() ?? EPOCH),
      build: this.stamp(),
    };
  }

  /** Beats earned, spent and left — derived on every read, never accumulated into a column. */
  private wallet(): PetWallet {
    // The blend credit is stored, not derived from the dissolved rows: this build's yield isn't
    // necessarily the one the credit was granted under. Spend is counted since the last
    // clearance — `usage_events` is never pruned, so counting from the start would reopen a
    // cleared vivarium holding every beat ever earned.
    const earned =
      Math.floor(this.store.sumUsageCostSince(this.store.petEpoch() ?? EPOCH) * this.rules.beatsPerDollar) +
      this.store.petBlendCredits();
    const spent = this.store.petBeatsSpent();
    return { earned, spent, balance: Math.max(0, earned - spent) };
  }

  /** A line of words for every origin the vivarium holds, keyed `kind:ref`. By-id reads, never a walk — cost follows the collection, not the deployment's history. → `docs/spec/22-pets.md#what-is-not-checked` */
  private originLabels(pets: Pet[]): Map<string, string> {
    const byKind = new Map<PetActionKind, Set<string>>();
    for (const pet of pets) {
      const refs = byKind.get(pet.originKind) ?? new Set<string>();
      refs.add(pet.originRef);
      byKind.set(pet.originKind, refs);
    }
    const ids = (kind: PetActionKind): string[] => [...(byKind.get(kind) ?? [])];
    const read: [PetActionKind, Map<string, string>][] = [
      ['escalation', this.store.escalationLabels(ids('escalation'))],
      ['human-task', this.store.humanTaskLabels(ids('human-task'))],
      ['plan', this.store.planLabels(ids('plan'))],
      ['landing', this.store.landingLabels(ids('landing'))],
      ['job', this.store.jobLabels(ids('job'))],
    ];
    const out = new Map<string, string>();
    for (const [kind, found] of read) {
      for (const [ref, label] of found) {
        const clamped = clampLabel(label);
        if (clamped !== null) out.set(`${kind}:${ref}`, clamped);
      }
    }
    // An upgrade's ref is its label, shortened — the row it came from has moved on.
    for (const ref of ids('upgrade')) out.set(`upgrade:${ref}`, ref.slice(0, 7));
    return out;
  }

  private view(pet: Pet, ledger: PetLedger, labels: Map<string, string>): PetView {
    const { rarity, display } = SPECIES[pet.species];
    return {
      ...pet,
      rarity,
      display,
      stage: petStage(pet.species, pet.fed),
      beatsToNextStage: beatsToNextStage(pet.species, pet.fed),
      flaw: attestPet(pet, ledger),
      provenance: provenanceOf(pet),
      originLabel: labels.get(`${pet.originKind}:${pet.originRef}`) ?? null,
    };
  }
}

/** One line, and a card's worth of it. Every label is free text somebody typed, so the clamp happens on the wire rather than in the panel. Whitespace is no label. */
function clampLabel(raw: string): string | null {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  return line.length <= LABEL_MAX ? line : `${line.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/** Long enough for a job title or a finding's claim, short enough for a card. */
const LABEL_MAX = 90;

/** Before any timestamp this harness can hold, so `at >= EPOCH` matches everything. An empty string would compare the same way and read as an accident. */
const EPOCH = '0000-01-01T00:00:00.000Z';

/**
 * The name of the clearance this build carries, and the only thing that decides whether a
 * deployment has had it. Never edited in place: changing the string is a second clearance that
 * silently releases every collection on every deployment taking the build. A new clearance is a new id.
 * → `docs/spec/22-pets.md#clearing-the-vivarium`
 */
const VIVARIUM_RESET = 'mark-two';
