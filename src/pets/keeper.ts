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

// → docs/spec/22-pets.md

export interface PetPolicy {
  enabled: boolean;
  visible: boolean;
}

type PetResult = { ok: true; pet: Pet } | { ok: false; error: string };

export class PetKeeper {
  constructor(
    private readonly store: Store,
    private readonly policy: PetPolicy,
    private readonly rules: PetRules = PET_RULES,
    private readonly stamp: () => PetBuildStamp = buildStamp,
  ) {}

  scan(): Pet[] {
    if (!this.policy.enabled) return [];
    const since = this.store.beginVivarium();
    const seen = this.store.petActionKeys();
    const fresh = collectActions(this.store)
      .filter((action) => !seen.has(`${action.kind}:${action.ref}`))
      .sort((a, b) => a.at.localeCompare(b.at));
    const hatched: Pet[] = [];
    const sinceHatch = this.store.petActionsSinceHatch(since);
    let anyRolled = this.store.petRolledSince(since);
    for (const action of fresh) {
      if (action.at < since) {
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

  resetOnce(): PetReset | null {
    if (!this.policy.enabled) return null;
    if (this.store.petResetAt(VIVARIUM_RESET) !== null) return null;
    return this.store.clearVivarium(VIVARIUM_RESET);
  }

  state(): PetState | null {
    if (!this.policy.enabled || !this.policy.visible) return null;
    const ledger = this.ledger();
    const pets = this.store.listPets();
    const labels = this.originLabels(pets);
    return {
      pets: pets.map((pet) => this.view(pet, ledger, labels)),
      wallet: this.wallet(),
      slots: VIVARIUM_SLOTS,
      startedAt: this.store.vivariumStart(),
    };
  }

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
    const flawed = existing === null ? null : this.refuseFlawed(existing, 'fed');
    if (flawed !== null) return flawed;
    if (existing !== null && existing.openedAt === null)
      return { ok: false, error: 'that one is still an egg — open it before you feed it' };
    const pet = this.store.feedPet(id, beats);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  rename(id: string, name: string | null): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    const pet = this.store.renamePet(id, name);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  place(id: string, placed: boolean): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    if (placed && this.store.placedCount() >= VIVARIUM_SLOTS) {
      const already = this.store.getPet(id);
      if (already !== null && !already.placed)
        return { ok: false, error: `the vivarium holds ${VIVARIUM_SLOTS} — take one out first` };
    }
    const existing = this.store.getPet(id);
    if (placed && existing !== null && existing.dissolvedAt !== null)
      return { ok: false, error: 'that one was blended — a dissolved pet cannot stand in the vivarium' };
    const flawed = placed && existing !== null ? this.refuseFlawed(existing, 'put out') : null;
    if (flawed !== null) return flawed;
    const pet = this.store.placePet(id, placed);
    return pet ? { ok: true, pet } : { ok: false, error: 'no such pet' };
  }

  blend(id: string): PetResult {
    if (!this.policy.enabled) return { ok: false, error: 'pets are turned off for this deployment' };
    const pet = this.store.getPet(id);
    if (pet === null) return { ok: false, error: 'no such pet' };
    if (pet.dissolvedAt !== null) return { ok: false, error: 'that one has already been blended' };
    const flawed = this.refuseFlawed(pet, 'blended');
    if (flawed !== null) return flawed;
    if (pet.openedAt === null)
      return { ok: false, error: 'that one is still an egg — open it before you decide it is a duplicate' };
    if (this.store.livePetsOfSpecies(pet.species) < 2) {
      const { display } = SPECIES[pet.species];
      const which = petStage(pet.species, pet.fed) === 'hatchling' ? 'one of these' : display;
      return { ok: false, error: `this is your only ${which} — blending is for duplicates` };
    }
    const blended = this.store.blendPet(id, blendValue(pet.species, this.rules.blendYield));
    return blended ? { ok: true, pet: blended } : { ok: false, error: 'no such pet' };
  }

  private refuseFlawed(pet: Pet, act: string): { ok: false; error: string } | null {
    const flaw = attestPet(pet, this.ledger());
    if (flaw === null) return null;
    return { ok: false, error: `that one does not check out — ${flaw.note} — so it cannot be ${act}` };
  }

  private ledger(): PetLedger {
    return {
      actions: this.store.petActionIndex(),
      paid: this.store.petPaidTotals(),
      chain: replayChain(this.store.petChainLog()),
      barren: replayBarren(this.store.petActionLog(), this.rules, this.store.vivariumStart() ?? EPOCH),
      build: this.stamp(),
    };
  }

  private wallet(): PetWallet {
    const earned =
      Math.floor(this.store.sumUsageCostSince(this.store.petEpoch() ?? EPOCH) * this.rules.beatsPerDollar) +
      this.store.petBlendCredits();
    const spent = this.store.petBeatsSpent();
    return { earned, spent, balance: Math.max(0, earned - spent) };
  }

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

function clampLabel(raw: string): string | null {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  return line.length <= LABEL_MAX ? line : `${line.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

const LABEL_MAX = 90;

const EPOCH = '0000-01-01T00:00:00.000Z';

const VIVARIUM_RESET = 'mark-two';
