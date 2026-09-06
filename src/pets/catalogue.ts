import type { PetActionKind, PetRarity, PetSpecies, PetStage } from '../types.js';

// → docs/spec/22-pets.md

export const SPECIES: Record<PetSpecies, { rarity: PetRarity; display: string; growth: number }> = {
  pip: { rarity: 'common', display: 'Pip', growth: 1 },
  mote: { rarity: 'common', display: 'Mote', growth: 1 },
  nib: { rarity: 'common', display: 'Nib', growth: 1 },
  tuft: { rarity: 'common', display: 'Tuft', growth: 1 },
  beck: { rarity: 'common', display: 'Beck', growth: 1 },
  berth: { rarity: 'common', display: 'Berth', growth: 1 },
  stoke: { rarity: 'common', display: 'Stoke', growth: 1 },
  speck: { rarity: 'common', display: 'Speck', growth: 1 },
  patch: { rarity: 'common', display: 'Patch', growth: 1 },
  warden: { rarity: 'uncommon', display: 'Warden', growth: 1.6 },
  cinder: { rarity: 'uncommon', display: 'Cinder', growth: 1.6 },
  nocturne: { rarity: 'uncommon', display: 'Nocturne', growth: 1.6 },
  chit: { rarity: 'uncommon', display: 'Chit', growth: 1.6 },
  vellum: { rarity: 'uncommon', display: 'Vellum', growth: 1.6 },
  drift: { rarity: 'uncommon', display: 'Drift', growth: 1.6 },
  bramble: { rarity: 'uncommon', display: 'Bramble', growth: 1.6 },
  lander: { rarity: 'rare', display: 'Lander', growth: 2.5 },
  quill: { rarity: 'rare', display: 'Quill', growth: 2.5 },
  cairn: { rarity: 'rare', display: 'Cairn', growth: 2.5 },
  ingot: { rarity: 'rare', display: 'Ingot', growth: 2.5 },
  clarion: { rarity: 'mythic', display: 'Clarion', growth: 4 },
  covenant: { rarity: 'mythic', display: 'Covenant', growth: 4 },
  oracle: { rarity: 'mythic', display: 'Oracle', growth: 4 },
  keystone: { rarity: 'mythic', display: 'Keystone', growth: 4 },
  forge: { rarity: 'mythic', display: 'Forge', growth: 4 },
  lodestone: { rarity: 'mythic', display: 'Lodestone', growth: 4 },
  ouroboros: { rarity: 'mythic', display: 'Ouroboros', growth: 4 },
};

/**
 * Commonest first, which is the order a degrade walks *backwards* along: a tier a
 * pool cannot fill steps down this list until one has members.
 *
 * @public — walked by `speciesCandidates` in `src/pets/roll.ts`, which asks what
 * every tier of one action resolves to rather than what one roll landed on.
 */
export const RARITIES: readonly PetRarity[] = ['common', 'uncommon', 'rare', 'mythic'];

const JUVENILE_AT = 1_500;
const ADULT_AT = 8_000;

const POOLS: Record<PetActionKind, Record<PetRarity, readonly PetSpecies[]>> = {
  escalation: {
    common: ['pip', 'mote', 'beck'],
    uncommon: ['warden', 'nocturne'],
    rare: ['quill', 'cairn'],
    mythic: ['clarion'],
  },
  'human-task': {
    common: ['pip', 'mote', 'tuft'],
    uncommon: ['chit', 'nocturne'],
    rare: ['quill'],
    mythic: ['covenant'],
  },
  plan: {
    common: ['pip', 'mote', 'nib'],
    uncommon: ['vellum', 'nocturne'],
    rare: ['quill'],
    mythic: ['oracle'],
  },
  landing: {
    common: ['pip', 'mote', 'berth'],
    uncommon: ['drift', 'nocturne'],
    rare: ['lander'],
    mythic: ['keystone'],
  },
  job: {
    common: ['pip', 'mote', 'stoke'],
    uncommon: ['cinder', 'nocturne'],
    rare: ['ingot'],
    mythic: ['forge'],
  },
  claim: {
    common: ['pip', 'mote', 'speck'],
    uncommon: ['bramble', 'nocturne'],
    rare: ['cairn'],
    mythic: ['lodestone'],
  },
  finding: {
    common: ['pip', 'mote', 'speck'],
    uncommon: ['bramble', 'nocturne'],
    rare: ['cairn'],
    mythic: ['lodestone'],
  },
  upgrade: {
    common: ['pip', 'mote', 'patch'],
    uncommon: ['cinder', 'nocturne'],
    rare: ['lander'],
    mythic: ['ouroboros'],
  },
};

const RETIRED_KINDS: ReadonlySet<PetActionKind> = new Set<PetActionKind>(['finding']);

/**
 * Every action that can draw something **today**, in the order the pools declare
 * them.
 *
 * Derived from `POOLS` rather than written out again: a kind added to the record
 * and forgotten here is a whole action the Pets page never mentions, and nothing
 * is red — the page simply draws six columns where there are seven. Less the
 * retired ones, which is the same failure pointed the other way: an eighth column
 * for an act nobody can take, and a `share` normalised over a pool that is counted
 * twice under two names.
 *
 * @public — walked by `src/pets/compendium.ts`, which asks what every pool of
 * every kind resolves to rather than what one roll landed on.
 */
export const PET_ACTION_KINDS = (Object.keys(POOLS) as PetActionKind[]).filter(
  (kind) => !RETIRED_KINDS.has(kind),
) as readonly PetActionKind[];

const NIGHT_FROM = 22;
const NIGHT_TO = 5;

function eligible(species: PetSpecies, hour: number): boolean {
  if (species !== 'nocturne') return true;
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

function membersOf(kind: PetActionKind, tier: PetRarity, hour: number): readonly PetSpecies[] {
  return POOLS[kind][tier].filter((species) => eligible(species, hour));
}

export function resolveTier(
  kind: PetActionKind,
  tier: PetRarity,
  hour: number,
): { tier: PetRarity; members: readonly PetSpecies[] } | null {
  for (let i = RARITIES.indexOf(tier); i >= 0; i--) {
    const at = RARITIES[i]!;
    const members = membersOf(kind, at, hour);
    if (members.length > 0) return { tier: at, members };
  }
  return null;
}

export function tiersFor(
  weights: Record<PetRarity, number>,
  firstEver: boolean,
): readonly { tier: PetRarity; weight: number }[] {
  const all = RARITIES.map((tier) => ({ tier, weight: Math.max(0, weights[tier]) })).filter(
    (entry) => entry.weight > 0,
  );
  if (!firstEver) return all;
  const notable = all.filter((entry) => entry.tier !== 'common');
  return notable.length > 0 ? notable : all;
}

export function petStage(species: PetSpecies, fed: number): PetStage {
  const { growth } = SPECIES[species];
  if (fed >= ADULT_AT * growth) return 'adult';
  if (fed >= JUVENILE_AT * growth) return 'juvenile';
  return 'hatchling';
}

export function beatsToNextStage(species: PetSpecies, fed: number): number | null {
  const { growth } = SPECIES[species];
  if (fed < JUVENILE_AT * growth) return Math.ceil(JUVENILE_AT * growth - fed);
  if (fed < ADULT_AT * growth) return Math.ceil(ADULT_AT * growth - fed);
  return null;
}

export function blendValue(species: PetSpecies, yieldPerGrowth: number): number {
  return Math.round(yieldPerGrowth * SPECIES[species].growth);
}
