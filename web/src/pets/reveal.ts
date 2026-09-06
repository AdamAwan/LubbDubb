import type { PetSpecies, PetStage, PetView } from '../types.js';

// → docs/spec/22-pets.md

export function petLabel(pet: PetView): string {
  if (pet.name !== null && pet.name.length > 0) return pet.name;
  if (pet.openedAt === null) return `${pet.rarity} egg`;
  return pet.stage === 'hatchling' ? `${pet.rarity} hatchling` : pet.display;
}

export function speciesKnown(pet: PetView): boolean {
  return pet.openedAt !== null && pet.stage !== 'hatchling';
}

/**
 * The stages in the order a pet passes through them.
 *
 * @public — the ladder {@link speciesSeen} walks, and the order the Pets page
 * draws a species' forms in.
 */
export const PET_STAGES: readonly PetStage[] = ['hatchling', 'juvenile', 'adult'];

/**
 * Every form of every species the collection has actually shown its owner.
 *
 * The catalogue's reveal is a record of what you have *seen*, and neither half of
 * that is what the collection holds. A shell has shown nothing — the animal inside
 * it is decided but withheld, so a species owned only as an egg is a species you
 * have not met. And a stage nobody has raised one to is a form nobody has been
 * shown, so an adult stays a silhouette on a card whose juvenile is drawn.
 *
 * Walked per pet rather than per species so the lower rungs come with the one
 * reached: a pet at adult was a hatchling and a juvenile on the way, and a card
 * that greyed the forms its owner watched it grow out of would be withholding a
 * memory rather than a secret.
 *
 * A dissolved pet still counts. Having seen the animal is not undone by having
 * blended a spare of it later.
 *
 * @public — read by `web/src/components/PetsPage.tsx`, checked in
 * `test/petsReveal.test.ts`.
 */
export function speciesSeen(pets: readonly PetView[]): Map<PetSpecies, Set<PetStage>> {
  const out = new Map<PetSpecies, Set<PetStage>>();
  for (const pet of pets) {
    if (pet.openedAt === null) continue;
    const seen = out.get(pet.species) ?? new Set<PetStage>();
    for (const stage of PET_STAGES.slice(0, PET_STAGES.indexOf(pet.stage) + 1)) seen.add(stage);
    out.set(pet.species, seen);
  }
  return out;
}
