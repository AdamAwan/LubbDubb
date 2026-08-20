import type { PetSpecies, PetStage, PetView } from '../types.js';

/**
 * What a pet may be **called** on a surface, given how far it has come.
 *
 * The catalogue has three reveals in it and each one is a wait: the shell says
 * nothing, opening it says the tier, and the juvenile is the first form that says
 * which animal you have. `display` — the species' own name — rides on the wire
 * from the moment of the drop, because the roll settled it there, so every surface
 * that falls back to it hands the answer over early.
 *
 * That is not a hypothetical. The panel named the species under a hatchling
 * sprite from the day it shipped, which quietly cost the juvenile stage its whole
 * point; the hatch modal only made it obvious, by promising a wait the next
 * surface did not keep. One helper, so a surface added later cannot re-open it by
 * reaching for the field that is right there.
 *
 * The operator's own name always wins. It is theirs, they chose it knowing what
 * they had, and withholding it would be the cockpit keeping a secret from the
 * person who wrote it.
 *
 * → `docs/spec/22-pets.md#what-the-shell-gives-away`
 */
export function petLabel(pet: PetView): string {
  if (pet.name !== null && pet.name.length > 0) return pet.name;
  if (pet.openedAt === null) return `${pet.rarity} egg`;
  return pet.stage === 'hatchling' ? `${pet.rarity} hatchling` : pet.display;
}

/**
 * Whether the species is a thing this surface may say out loud yet.
 *
 * Separate from {@link petLabel} because some copy is *about* the species without
 * naming the pet — "this is your only Ouroboros" — and the answer there is to
 * reword the sentence, not to rename the animal.
 */
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
