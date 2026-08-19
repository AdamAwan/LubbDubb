import type { PetView } from '../types.js';

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
