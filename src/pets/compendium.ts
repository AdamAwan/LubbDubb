import type { PetActionKind, PetRarity, PetSpecies } from '../types.js';
import type { PetCatalogue, PetCatalogueEntry, PetCatalogueSource } from '../wire.js';
import { beatsToNextStage, blendValue, PET_ACTION_KINDS, RARITIES, resolveTier, SPECIES } from './catalogue.js';
import { PET_RULES } from './rules.js';

/**
 * The catalogue as a reading rather than as a roll.
 *
 * The Pets page has to answer "what is out there and how often" — a question the
 * rest of the subsystem never asks, because a roll only ever resolves *one*
 * action. Everything here is that same roll walked exhaustively: every action,
 * every tier, every hour of the clock. Nothing is a second copy of the tables,
 * and that is the whole design constraint — a page carrying its own thresholds or
 * its own idea of which pools hold a rare would advertise a price the harness does
 * not charge, and there is no test that could tell.
 *
 * **Read-only, and never consulted by a decision.** Like the panel it feeds, this
 * is written from what the tables already say; a dispatcher rule or a store write
 * reaching for it would be the harness marking its own homework.
 *
 * → `docs/spec/22-pets.md#the-pets-page`
 */

/** Every hour the clock has, which is the range an action's timestamp falls in. */
const HOURS = 24;

/**
 * The tier weights as shares of their own total.
 *
 * `tiersFor` is deliberately not used: its `firstEver` arm drops the commons for
 * the one guaranteed drop a deployment gets, and a page that folded that into its
 * headline rates would describe a moment that happens once rather than the
 * deployment. The first drop is a fact for the spec, not for the arithmetic.
 */
function tierShares(): Record<PetRarity, number> {
  const total = RARITIES.reduce((sum, tier) => sum + Math.max(0, PET_RULES.rarity[tier]), 0);
  const out = {} as Record<PetRarity, number>;
  for (const tier of RARITIES) out[tier] = total <= 0 ? 0 : Math.max(0, PET_RULES.rarity[tier]) / total;
  return out;
}

/**
 * What one action at one hour draws, by species, given that something drops.
 *
 * Uniform among the landed tier's members, which is stage 3 of the roll — no
 * weights, because the tier share has already done the rarity work.
 */
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

/** An hour at which no species is filtered out, so a source row lists the whole pool. */
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

/** Every species this deployment can produce, and how often, over the whole clock. */
function entries(): PetCatalogueEntry[] {
  const shares = tierShares();
  const share = new Map<PetSpecies, number>();
  const kinds = new Map<PetSpecies, Set<PetActionKind>>();
  const hours = new Map<PetSpecies, Set<number>>();

  for (const kind of PET_ACTION_KINDS) {
    for (let hour = 0; hour < HOURS; hour++) {
      for (const [species, weight] of drawAt(kind, hour, shares)) {
        share.set(species, (share.get(species) ?? 0) + weight / (PET_ACTION_KINDS.length * HOURS));
        (kinds.get(species) ?? kinds.set(species, new Set()).get(species)!).add(kind);
        (hours.get(species) ?? hours.set(species, new Set()).get(species)!).add(hour);
      }
    }
  }

  return (Object.keys(SPECIES) as PetSpecies[]).map((species) => {
    const { rarity, display, growth } = SPECIES[species];
    // From `beatsToNextStage` rather than from the thresholds, so the page and a
    // pet's own card can never disagree about what the next stage costs.
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

/** Where every tier of every action actually lands, and what it may draw there. */
function sources(): PetCatalogueSource[] {
  const hour = widestHour();
  const out: PetCatalogueSource[] = [];
  for (const kind of PET_ACTION_KINDS) {
    for (const rolled of RARITIES) {
      const landed = resolveTier(kind, rolled, hour);
      // A pool with every tier empty cannot happen through the shipped table, and
      // a row that says so is more use to whoever broke it than a missing row.
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
