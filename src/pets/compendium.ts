import type { PetActionKind, PetRarity, PetSpecies } from '../types.js';
import type { PetCatalogue, PetCatalogueEntry, PetCatalogueSource } from '../wire.js';
import { beatsToNextStage, blendValue, PET_ACTION_KINDS, RARITIES, resolveTier, SPECIES } from './catalogue.js';
import { PET_RULES } from './rules.js';

// → docs/spec/22-pets.md

const HOURS = 24;

function tierShares(): Record<PetRarity, number> {
  const total = RARITIES.reduce((sum, tier) => sum + Math.max(0, PET_RULES.rarity[tier]), 0);
  const out = {} as Record<PetRarity, number>;
  for (const tier of RARITIES) out[tier] = total <= 0 ? 0 : Math.max(0, PET_RULES.rarity[tier]) / total;
  return out;
}

function drawAt(kind: PetActionKind, hour: number, shares: Record<PetRarity, number>): Map<PetSpecies, number> {
  const out = new Map<PetSpecies, number>();
  for (const tier of RARITIES) {
    const landed = resolveTier(kind, tier, hour);
    if (landed === null) continue;
    const each = shares[tier] / landed.members.length;
    for (const species of landed.members) out.set(species, (out.get(species) ?? 0) + each);
  }
  return out;
}

function widestHour(): number {
  let best = 0;
  let most = -1;
  for (let hour = 0; hour < HOURS; hour++) {
    const count = new Set(PET_ACTION_KINDS.flatMap((kind) => [...drawAt(kind, hour, tierShares()).keys()])).size;
    if (count > most) {
      most = count;
      best = hour;
    }
  }
  return best;
}

function kindWeights(): Map<PetActionKind, number> {
  const total = PET_ACTION_KINDS.reduce((sum, kind) => sum + PET_RULES.rates[kind].dropChance, 0);
  return new Map(PET_ACTION_KINDS.map((kind) => [kind, total <= 0 ? 0 : PET_RULES.rates[kind].dropChance / total]));
}

function entries(): PetCatalogueEntry[] {
  const shares = tierShares();
  const weights = kindWeights();
  const share = new Map<PetSpecies, number>();
  const kinds = new Map<PetSpecies, Set<PetActionKind>>();
  const hours = new Map<PetSpecies, Set<number>>();

  for (const kind of PET_ACTION_KINDS) {
    for (let hour = 0; hour < HOURS; hour++) {
      for (const [species, weight] of drawAt(kind, hour, shares)) {
        share.set(species, (share.get(species) ?? 0) + (weight * (weights.get(kind) ?? 0)) / HOURS);
        (kinds.get(species) ?? kinds.set(species, new Set()).get(species)!).add(kind);
        (hours.get(species) ?? hours.set(species, new Set()).get(species)!).add(hour);
      }
    }
  }

  return (Object.keys(SPECIES) as PetSpecies[]).map((species) => {
    const { rarity, display, growth } = SPECIES[species];
    const juvenileAt = beatsToNextStage(species, 0) ?? 0;
    const drawnAt = hours.get(species) ?? new Set<number>();
    return {
      species,
      display,
      rarity,
      growth,
      juvenileAt,
      adultAt: juvenileAt + (beatsToNextStage(species, juvenileAt) ?? 0),
      blend: blendValue(species, PET_RULES.blendYield),
      share: share.get(species) ?? 0,
      kinds: PET_ACTION_KINDS.filter((kind) => kinds.get(species)?.has(kind) === true),
      hours: drawnAt.size === HOURS ? null : [...drawnAt].sort((a, b) => a - b),
    };
  });
}

function sources(): PetCatalogueSource[] {
  const hour = widestHour();
  const out: PetCatalogueSource[] = [];
  for (const kind of PET_ACTION_KINDS) {
    for (const rolled of RARITIES) {
      const landed = resolveTier(kind, rolled, hour);
      if (landed === null) continue;
      out.push({ kind, rolled, landed: landed.tier, members: [...landed.members] });
    }
  }
  return out;
}

/**
 * Built once at import: the tables are frozen constants, so this cannot change
 * between calls and re-walking the clock per request would only cost time.
 *
 * @public — served by `GET /api/pets/catalogue` in `src/server/routes/pets.ts`.
 */
export const PET_CATALOGUE: PetCatalogue = {
  rules: PET_RULES,
  rarities: [...RARITIES],
  species: entries(),
  sources: sources(),
};
