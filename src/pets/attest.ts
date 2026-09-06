import type { Pet, PetAction, PetActionKind, PetFlaw, PetProvenance } from '../types.js';
import { chainLink, type ChainInput } from '../store/pets.js';
import { SPECIES } from './catalogue.js';
import { rollAction, speciesCandidates } from './roll.js';
import type { PetRules } from './rules.js';

// → docs/spec/22-pets.md

export interface PetLedger {
  actions: Map<string, { at: string; petId: string | null }>;
  paid: Map<string, number>;
  chain: Map<string, string>;
  barren: Set<string>;
  build: { sha: string | null; clean: boolean };
}

export function replayBarren(log: PetAction[], rules: PetRules, since: string): Set<string> {
  const barren = new Set<string>();
  const sinceHatch = new Map<PetActionKind, number>();
  let anyRolled = false;
  for (const action of log) {
    if (action.at < since) continue;
    const missed = sinceHatch.get(action.kind) ?? 0;
    const roll = rollAction(action.kind, action.ref, action.at, {
      rules,
      forced: missed + 1 >= rules.rates[action.kind].pity,
      firstEver: !anyRolled,
    });
    anyRolled = true;
    if (!roll.hatches) barren.add(`${action.kind}:${action.ref}`);
    sinceHatch.set(action.kind, action.petId === null ? missed + 1 : 0);
  }
  return barren;
}

export function replayChain(log: { id: string; chain: string | null; link: ChainInput }[]): Map<string, string> {
  const out = new Map<string, string>();
  let previous: string | null = null;
  for (const row of log) {
    if (row.chain === null) {
      previous = null;
      continue;
    }
    previous = chainLink(previous, row.link);
    out.set(row.id, previous);
  }
  return out;
}

export function provenanceOf(pet: Pet): PetProvenance {
  if (pet.builtSha === null) return 'unknown';
  return pet.builtClean ? 'official' : 'modified';
}

function judgeable(pet: Pet, build: { sha: string | null; clean: boolean }): boolean {
  return build.sha !== null && build.clean && pet.builtSha === build.sha && pet.builtClean;
}

export function attestPet(pet: Pet, ledger: PetLedger): PetFlaw | null {
  const key = `${pet.originKind}:${pet.originRef}`;
  const action = ledger.actions.get(key);
  if (action === undefined || action.petId !== pet.id)
    return { code: 'unrecorded', note: 'nothing in the record of what you have done accounts for this one' };
  if (action.at !== pet.hatchedAt)
    return { code: 'misdated', note: 'it hatched at a different moment than the action it names was settled' };
  if (pet.seed !== key)
    return { code: 'impossible', note: 'its markings are drawn from a seed that is not its own origin' };
  if (!speciesCandidates(pet.originKind, pet.originRef, pet.hatchedAt).has(pet.species))
    return {
      code: 'impossible',
      note: `no roll of ${pet.originRef} can produce a ${SPECIES[pet.species].display}`,
    };
  if (pet.fed > (ledger.paid.get(pet.id) ?? 0))
    return { code: 'overfed', note: 'it has grown by more beats than anything ever paid for' };
  const expected = ledger.chain.get(pet.id);
  if (pet.chain !== null && expected !== undefined && pet.chain !== expected)
    return { code: 'broken-chain', note: 'the record of hatchings does not run through it' };
  if (judgeable(pet, ledger.build) && ledger.barren.has(key))
    return { code: 'unearned', note: `this build would have hatched nothing on ${pet.originRef}` };
  return null;
}
