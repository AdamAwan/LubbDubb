import type { PetActionKind, PetRarity, PetSpecies } from '../types.js';
import { RARITIES, resolveTier, tiersFor } from './catalogue.js';
import type { PetRules } from './rules.js';

// → docs/spec/22-pets.md

export function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

interface RollOutcome {
  hatches: boolean;
  species: PetSpecies;
  tier: PetRarity;
}

export function rollAction(
  kind: PetActionKind,
  ref: string,
  at: string,
  opts: { rules: PetRules; forced: boolean; firstEver: boolean },
): RollOutcome {
  const key = `${kind}:${ref}`;
  const hour = hourOf(at);
  const rate = opts.rules.rates[kind];
  const hatches = opts.forced || opts.firstEver || hash32(key) % 10_000 < Math.round(rate.dropChance * 10_000);

  const tiers = tiersFor(opts.rules.rarity, opts.firstEver);
  const rolled = pickTier(tiers, hash32(`${key}:tier`));
  const landed = resolveTier(kind, rolled, hour);
  if (landed === null) return { hatches: false, species: 'pip', tier: 'common' };

  return { hatches, species: pickSpecies(key, landed.members), tier: landed.tier };
}

/**
 * Every species this action could *ever* draw, whatever tier stage 2 lands on.
 *
 * What {@link attestPet} checks a stored pet against, and the reason it is worth
 * having beside {@link rollAction} rather than inside it: an attestation must not
 * depend on the tier weights, because those are a number this build ships and an
 * older build may have shipped differently — a pet from a deployment that once
 * tuned them is still an honestly earned pet, and a check that called it a forgery
 * would take something away from the one operator who had done nothing wrong.
 *
 * Weight-independent and still narrow: an origin key reaches exactly four species
 * out of twenty-seven — one per tier, because stage 3 is a hash of that same key
 * and the tiers hold disjoint members. It reached two or three when pools had
 * holes in them, so filling every ladder did widen this slightly; four in
 * twenty-seven is still narrower than three in twenty, and the property that
 * matters is untouched. **You cannot choose which animal an action gives you**,
 * which is the whole of what the check is for.
 *
 * @public — read by `src/pets/attest.ts` across the roll/attest seam.
 */
export function speciesCandidates(kind: PetActionKind, ref: string, at: string): Set<PetSpecies> {
  const key = `${kind}:${ref}`;
  const hour = hourOf(at);
  const out = new Set<PetSpecies>();
  for (const tier of RARITIES) {
    const landed = resolveTier(kind, tier, hour);
    if (landed !== null) out.add(pickSpecies(key, landed.members));
  }
  return out;
}

function pickSpecies(key: string, members: readonly PetSpecies[]): PetSpecies {
  return members[hash32(`${key}:species`) % members.length]!;
}

function hourOf(at: string): number {
  return new Date(at).getHours();
}

function pickTier(table: readonly { tier: PetRarity; weight: number }[], hash: number): PetRarity {
  const total = table.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return table[0]?.tier ?? 'common';
  let cursor = hash % total;
  for (const entry of table) {
    if (cursor < entry.weight) return entry.tier;
    cursor -= entry.weight;
  }
  return table[table.length - 1]!.tier;
}
